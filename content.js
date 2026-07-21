// Injected while edit mode is active. Re-injected after each full navigation
// by the background service worker; SPA navigations (pushState) are detected
// here. Collected edits are synced to the background so they survive page
// changes.
(() => {
  if (window.__slopOffInjected) {
    window.__slopOffEnable();
    return;
  }
  window.__slopOffInjected = true;

  // Sections are keyed by URL with the hash ignored: one section per page.
  const normUrl = (u) => (u || '').split('#')[0];

  let active = false;
  let currentUrl = location.href;
  let tracked = new Map(); // element -> { selector, before, after }
  // Empty fields with a placeholder: typing edits the placeholder, not the value.
  const phMode = new WeakSet();
  let carried = []; // adopted edits from an earlier visit, not (yet) re-attached to a live element
  let reapplyTimers = [];
  let viewMode = 'new'; // 'original' | 'diff' | 'new' — what the page currently shows
  let instantMode = false; // ⚡: flush each change to the agent after a short pause
  let instantTimer = null;
  let adopting = false; // getSections roundtrip in flight; hold syncs so they can't clobber old edits
  let syncWanted = false;
  let syncTimer = null;
  let urlWatch = null;

  const isFormControl = (el) =>
    el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

  // outerHTML with the *current* value baked in for form controls, so value
  // changes show up in the report (the value attribute doesn't track typing).
  const htmlOf = (el) => {
    const clone = el.cloneNode(true);
    // ponytail: strips ALL contenteditable attrs (ours from ⌥-click label
    // editing, but also the page's own) so our toggles never leak into the
    // report; map-only-ours if a page with real contenteditable ever matters.
    if (clone.removeAttribute) clone.removeAttribute('contenteditable');
    clone.querySelectorAll?.('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    // The inline attribute-editor chip lives inside the page DOM; never capture it.
    clone.querySelectorAll?.('slop-off-ui').forEach((n) => n.remove());
    if (isFormControl(el)) {
      if (el.tagName === 'TEXTAREA') {
        if (phMode.has(el) && el.value) {
          clone.textContent = '';
          clone.setAttribute('placeholder', el.value);
        } else {
          clone.textContent = el.value;
        }
      } else if (el.tagName === 'SELECT') {
        const options = clone.querySelectorAll('option');
        options.forEach((opt, i) => {
          if (i === el.selectedIndex) opt.setAttribute('selected', '');
          else opt.removeAttribute('selected');
        });
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) clone.setAttribute('checked', '');
        else clone.removeAttribute('checked');
      } else if (phMode.has(el) && el.value) {
        clone.setAttribute('placeholder', el.value);
        clone.removeAttribute('value');
      } else {
        clone.setAttribute('value', el.value);
      }
    }
    return clone.outerHTML;
  };

  // Short unique-ish CSS path to help locate the element in the source.
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        return parts.join(' > ');
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  };

  const track = (el) => {
    if (el.closest && el.closest('[data-ec-ui]')) return; // never capture our own UI
    if (
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
      !el.value &&
      el.hasAttribute('placeholder')
    ) {
      phMode.add(el);
    }
    // Skip if already covered by a tracked (ancestor) element,
    // otherwise the report gets nested duplicate entries.
    for (const trackedEl of tracked.keys()) {
      if (trackedEl === el || trackedEl.contains(el)) return;
    }
    tracked.set(el, { selector: cssPath(el), before: htmlOf(el), after: null });
  };

  // Keep the "after" snapshot current while elements are still in the DOM.
  // SPA frameworks (Next.js, React) replace the DOM on navigation, so by the
  // time we notice the URL changed, the elements are already disconnected —
  // this preserves the user's last edit instead of reporting a removal.
  const updateAfters = () => {
    if (viewMode !== 'new') return; // the DOM shows a view, not the edits
    for (const [el, rec] of tracked) {
      if (el.isConnected) rec.after = htmlOf(el);
    }
  };

  const snapshot = () => {
    const edits = carried.slice();
    for (const [el, rec] of tracked) {
      let after;
      if (viewMode === 'new') {
        after = el.isConnected ? htmlOf(el) : rec.after != null ? rec.after : '(element removed)';
      } else {
        after = rec.after != null ? rec.after : rec.before; // stored state, not the view
      }
      if (after !== rec.before) {
        edits.push({ selector: rec.selector, before: rec.before, after });
      }
    }
    return edits;
  };

  const sync = () => {
    if (!active) return; // disable() teardown must never resurrect cleared sections
    renderPanel();
    if (adopting) {
      syncWanted = true;
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: 'sync',
        url: currentUrl,
        edits: snapshot(),
        notes: noteList(),
      });
    } catch (e) {
      // Extension context gone (e.g. reloaded); nothing we can do.
    }
    if (instantMode) scheduleInstantFlush();
  };

  // ── Instant mode: ship pending changes after a short pause ──────────
  const scheduleInstantFlush = () => {
    clearTimeout(instantTimer);
    // ponytail: 1.2s pause = "done typing"; raise if half-typed words ship
    instantTimer = setTimeout(flushInstant, 1200);
  };

  const flushNow = (manual) => {
    if (!active) return;
    // Mid-interaction? Instant retries after the next pause; manual just says so.
    if (viewMode !== 'new' || adopting || noteEditor || linkEditing) {
      if (manual) miniToast('Busy — try again in a moment');
      else scheduleInstantFlush();
      return;
    }
    const edits = snapshot();
    const sentEls = new Set(tracked.keys());
    const sentNoteEls = new Set(notes.keys());
    try {
      chrome.runtime.sendMessage(
        { type: 'flushInstant', url: currentUrl, edits, notes: noteList() },
        (ok) => {
          void chrome.runtime.lastError;
          if (!ok || !active) {
            if (manual && active) miniToast('⚠ Nothing sent — webhook unreachable');
            return; // stays batched
          }
          // ponytail: only drop what we sent; anything typed mid-flight keeps
          // its (new) tracking baseline
          sentEls.forEach((el) => tracked.delete(el));
          sentNoteEls.forEach((el) => notes.delete(el));
          carried = [];
          carriedNotes = [];
          syncMarkers();
          renderPanel();
          miniToast('⚡ Sent to agent');
          pollPending(); // pill shows the new pending report right away
        }
      );
    } catch (e) {}
  };

  const flushInstant = () => {
    if (instantMode) flushNow(false);
  };

  // ⌘/Ctrl+Return: interim submit — closes an open editor first, then sends.
  const onSubmitKey = (e) => {
    if (!active || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    e.stopPropagation();
    if (noteEditor) closeNoteEditor();
    if (linkEditing) hideLinkUi();
    flushNow(true);
  };

  // SPA navigation: close out the previous visit and start a fresh one.
  const checkUrlChange = () => {
    if (location.href === currentUrl) return;
    clearTimeout(syncTimer);
    // ponytail: if adoption is still mid-flight, sync() defers and we discard
    // it below — the background's section is the richer one, don't clobber it.
    sync();
    adopting = false;
    syncWanted = false;
    currentUrl = location.href;
    viewMode = 'new'; // fresh page shows the live state
    if (active) document.designMode = 'on';
    tracked = new Map();
    carried = [];
    clearNotes();
    reapplyTimers.forEach(clearTimeout);
    reapplyTimers = [];
    renderPanel();
    adoptSection();
  };

  // ── Returning to an edited page: re-apply the earlier edits ─────────
  // Find the element via its selector; if it still matches the old "before"
  // snapshot (exact HTML, or same text as fallback for pages that hydrate
  // extra attributes), swap in the "after" and track it again.
  const reattach = (edit) => {
    if (edit.after === '(element removed)') return false;
    let el = null;
    try {
      el = document.querySelector(edit.selector);
    } catch (e) {}
    if (!el) return false;
    const cur = htmlOf(el);
    if (cur !== edit.after) {
      // ponytail: text-equality fallback also re-applies over hydration-mangled
      // attributes; fine for mockups, tighten if it ever misfires
      if (cur !== edit.before && textOf(cur) !== textOf(edit.before)) return false;
      el.outerHTML = edit.after; // re-apply
      try {
        el = document.querySelector(edit.selector);
      } catch (e) {}
    }
    if (!el) return false;
    tracked.set(el, { selector: edit.selector, before: edit.before, after: edit.after });
    return true;
  };

  const adoptSection = () => {
    adopting = true;
    const adoptedUrl = normUrl(currentUrl);
    const done = () => {
      if (!adopting) return;
      adopting = false;
      if (syncWanted) {
        syncWanted = false;
        sync();
      }
    };
    const failsafe = setTimeout(done, 2000);
    try {
      chrome.runtime.sendMessage({ type: 'getSections' }, (sections) => {
        void chrome.runtime.lastError;
        try {
          if (!active || !Array.isArray(sections)) return;
          const section = sections
            .filter((s) => normUrl(s.url) === adoptedUrl && (s.edits.length > 0 || s.notes?.length > 0))
            .pop();
          if (!section) return;
          let pending = section.edits.slice();
          const attempt = () => {
            if (!active || normUrl(currentUrl) !== adoptedUrl) return;
            // An element re-edited in the meantime wins over its old edit.
            const trackedSelectors = new Set([...tracked.values()].map((r) => r.selector));
            pending = pending.filter((edit) => !trackedSelectors.has(edit.selector) && !reattach(edit));
            carried = pending;
            // Notes: re-attach to their element when it exists, else carry.
            const attached = new Set([...notes.values()].map((n) => n.selector));
            carriedNotes = (section.notes || []).filter((n) => {
              if (attached.has(n.selector)) return false;
              let els = [];
              try {
                els = [...document.querySelectorAll(n.selector)];
              } catch (err) {}
              if (!els.length) return true;
              notes.set(els[0], { els, selector: n.selector, prompt: n.prompt, html: n.html });
              return false;
            });
            syncMarkers();
            sync();
          };
          attempt();
          // SPA frameworks may still be rendering; retry a couple of times.
          reapplyTimers = [setTimeout(attempt, 600), setTimeout(attempt, 1800)];
        } finally {
          clearTimeout(failsafe);
          done();
        }
      });
    } catch (e) {
      clearTimeout(failsafe);
      done();
    }
  };

  const onBeforeInput = (e) => {
    if (viewMode !== 'new') {
      e.preventDefault(); // original/diff views are read-only
      return;
    }
    checkUrlChange();

    // Form controls: the event target is the control itself.
    if (isFormControl(e.target)) {
      track(e.target);
      return;
    }

    const sel = document.getSelection();
    const node = sel && sel.anchorNode;
    if (!node) return;

    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || el === document.body || el === document.documentElement) return;
    track(el);
  };

  // Selects don't fire beforeinput; capture form controls on focus instead.
  // Focused-but-unchanged controls are filtered out by snapshot().
  const onFocusIn = (e) => {
    if (isFormControl(e.target)) track(e.target);
  };

  // Placeholder-mode fields: on blur, move the typed text into the
  // placeholder attribute so it renders as a real (gray) placeholder again.
  const onFocusOut = (e) => {
    if (viewMode !== 'new') return;
    const el = e.target;
    if (!phMode.has(el) || !el.value) return;
    el.setAttribute('placeholder', el.value);
    el.value = '';
    updateAfters();
    sync();
  };

  const onInput = (e) => {
    if (viewMode !== 'new') return;
    checkUrlChange();
    if (isFormControl(e.target) && !tracked.has(e.target)) track(e.target);
    updateAfters();
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 300);
  };

  const onPageHide = () => {
    checkUrlChange();
    sync();
  };

  // Tab switch / minimize: flush pending edits right away.
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'hidden') return;
    checkUrlChange();
    clearTimeout(syncTimer);
    sync();
  };

  const enable = () => {
    if (active) return;
    active = true;
    viewMode = 'new';
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('contextmenu', onAnnotate, true);
    document.addEventListener('click', onAnnotate, true);
    document.addEventListener('mousemove', onAnnotateMove, true);
    document.addEventListener('keydown', onAnnotateKey, true);
    document.addEventListener('keyup', onAnnotateKey, true);
    document.addEventListener('keydown', onTabCycle, true);
    document.addEventListener('keydown', onEscDiscard, true);
    document.addEventListener('keydown', onSubmitKey, true);
    document.addEventListener('click', onControlAltClick, true);
    document.addEventListener('click', onLinkClick, true);
    document.addEventListener('auxclick', onLinkClick, true);
    document.addEventListener('click', onFormTextClick, true);
    document.addEventListener('mouseover', onLinkHover, true);
    window.addEventListener('popstate', checkUrlChange);
    urlWatch = setInterval(() => {
      checkUrlChange();
      // SPA frameworks may replace <body>/<head>, dropping our overlays; re-attach.
      if (borderEl && !borderEl.isConnected) hideBorder();
      showBorder();
      addModeStyle();
      if (linkUi && !linkUi.isConnected) hideLinkUi();
      positionLinkUi(); // follow the element while scrolling
      syncMarkers(); // note markers follow their elements too
      if (panelEl && !panelEl.isConnected) {
        removePanel();
        renderPanel();
      }
    }, 400);
    document.designMode = 'on';
    addModeStyle();
    showBorder();
    renderPanel();
    adoptSection();
    bridgeTimer = setInterval(pollPending, 1000); // localhost: cheap, keeps the pill snappy
    pollPending();
    try {
      chrome.storage.sync.get({ instant: false }, (v) => {
        instantMode = Boolean(v && v.instant);
        paintModeBtn();
      });
    } catch (e) {}
  };

  // ── Links: never navigate while editing; ⌥-click edits the URL ──────
  let linkHintShown = false;

  const TOAST_CSS =
    'position:fixed;right:20px;z-index:2147483647;background:#001E35;color:#fff;' +
    'border-left:4px solid #FBB734;border-radius:10px;padding:10px 16px;' +
    'font:600 13px/1.4 -apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,30,53,.35);';

  // Only one toast at a time: a new one replaces the previous instead of
  // stacking on the same spot when you click a few times in a row.
  let toastEl = null;
  let toastTimer = 0;
  const miniToast = (text) => {
    try {
      window.SlopOffPanes?.logNotif(text); // every toast lands in the history
    } catch (e) {}
    clearTimeout(toastTimer);
    toastEl?.remove(); // rapid hints replace each other; other toasts stack
    const t = document.createElement('div');
    t.setAttribute('data-ec-ui', '');
    t.setAttribute('data-slop-toast', '');
    t.textContent = text;
    // Stack upward from the bottom; the lowest 70px belong to the host page.
    // ponytail: no re-collapse when a lower toast expires — they live seconds
    let bottom = 78;
    for (const el of document.querySelectorAll('[data-slop-toast],[data-slop-stack]')) {
      bottom = Math.max(bottom, Math.round(innerHeight - el.getBoundingClientRect().top + 8));
    }
    t.style.cssText = TOAST_CSS + `bottom:${bottom}px;`;
    (document.body || document.documentElement).appendChild(t);
    toastEl = t;
    toastTimer = setTimeout(() => {
      t.remove();
      if (toastEl === t) toastEl = null;
    }, 2600);
  };


  const onLinkClick = (e) => {
    if (viewMode !== 'new') return; // views are a normal page: links just work
    if (e.target.closest && e.target.closest('[data-ec-ui]')) return;
    const a = e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    // Deliberate navigation: same-tab full load, so the background worker
    // re-injects us and the edit session continues on the next page.
    // ⌘-only: ⌃-click is the annotate gesture.
    if (e.type === 'click' && e.metaKey) {
      if (a.href) {
        clearTimeout(syncTimer);
        sync(); // flush before we leave
        location.href = a.href;
      }
      return;
    }
    if (!linkHintShown) {
      linkHintShown = true;
      miniToast('Link clicks are off in edit mode — ⌘-click follows, hover to edit URL');
    }
  };

  // Inline attribute editor: a chip appears above the hovered link (href) or
  // form field (placeholder); clicking it swaps to an input. Enter/✓ applies,
  // Esc closes.
  let linkUi = null;
  let linkTarget = null;
  let linkKind = 'href';
  let linkEditing = false;
  let linkHideTimer = null;

  const hideLinkUi = () => {
    clearTimeout(linkHideTimer);
    linkUi?.remove();
    linkUi = null;
    linkTarget = null;
    linkEditing = false;
  };

  const linkBtnStyle =
    'background:#001E35;color:#fff;border:none;border-radius:8px;padding:4px 10px;' +
    'font:600 12px/1.4 -apple-system,"Segoe UI",sans-serif;cursor:pointer;';

  const showLinkChip = (target, kind) => {
    if (linkEditing) return;
    hideLinkUi();
    linkTarget = target;
    linkKind = kind;
    // Lives INSIDE the anchor (or right after the input), so hovering the
    // chip never counts as leaving the element — but position:fixed, so it
    // takes no layout space. htmlOf() strips <slop-off-ui> from every
    // capture.
    linkUi = document.createElement('slop-off-ui');
    linkUi.setAttribute('data-ec-ui', '');
    linkUi.contentEditable = 'false';
    linkUi.style.cssText =
      'position:fixed;z-index:2147483647;display:flex;gap:4px;align-items:center;' +
      'filter:drop-shadow(0 2px 8px rgba(0,30,53,.25));';
    // The chip lives inside the <a>: clicks must never escape it, or SPA
    // routers treat them as link clicks and navigate away.
    for (const type of ['click', 'auxclick', 'mousedown', 'mouseup']) {
      linkUi.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'click' || type === 'auxclick') e.preventDefault();
      });
    }
    const chip = document.createElement('button');
    chip.textContent = '🔗 Edit URL';
    chip.style.cssText = linkBtnStyle;
    chip.addEventListener('click', showLinkInput);
    const follow = document.createElement('button');
    follow.textContent = '↗';
    follow.title = 'Follow link (edit session continues there)';
    follow.style.cssText = linkBtnStyle;
    follow.addEventListener('click', () => {
      const href = linkTarget?.href;
      hideLinkUi();
      if (href) {
        clearTimeout(syncTimer);
        sync(); // flush before we leave
        location.href = href;
      }
    });
    linkUi.append(chip, follow);
    target.appendChild(linkUi);
    positionLinkUi();
  };

  // Flush against the end of the link text; if there's no room to the right,
  // above (or below) it — never on top of the text itself.
  const positionLinkUi = () => {
    if (!linkUi || !linkTarget?.isConnected) return;
    const r = linkTarget.getBoundingClientRect();
    const w = linkUi.offsetWidth || 160;
    let left = r.right + 4;
    let top = r.top + r.height / 2 - 13;
    if (left + w > innerWidth - 4) {
      left = Math.max(4, Math.min(r.left, innerWidth - w - 4));
      top = r.top >= 34 ? r.top - 30 : r.bottom + 4;
    }
    linkUi.style.left = `${left}px`;
    linkUi.style.top = `${Math.max(4, top)}px`;
  };

  const showLinkInput = () => {
    if (!linkUi || !linkTarget) return;
    linkEditing = true;
    linkUi.textContent = '';
    const input = document.createElement('input');
    input.value = linkTarget.getAttribute(linkKind) || '';
    input.style.cssText =
      'width:min(320px,60vw);padding:5px 8px;border:1px solid #195FA4;border-radius:8px;' +
      'font:12px/1.4 ui-monospace,Menlo,monospace;color:#001E35;background:#fff;outline:none;';
    const ok = document.createElement('button');
    ok.textContent = '✓';
    ok.title = 'Apply (Enter)';
    ok.style.cssText = linkBtnStyle + 'background:#195FA4;';
    const apply = () => {
      const target = linkTarget;
      if (target && input.value !== target.getAttribute(linkKind)) {
        track(target);
        target.setAttribute(linkKind, input.value);
        updateAfters();
        sync();
      }
      hideLinkUi();
    };
    ok.addEventListener('click', apply);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault(); // don't submit an enclosing form
        apply();
      }
      if (e.key === 'Escape') hideLinkUi();
    });
    linkUi.append(input, ok);
    input.focus();
    input.select();
  };

  const onLinkHover = (e) => {
    if (viewMode !== 'new') return;
    if (linkUi && linkUi.contains(e.target)) {
      clearTimeout(linkHideTimer);
      return;
    }
    if (!e.target.closest) return;
    const target = e.target.closest('a');
    if (target) {
      clearTimeout(linkHideTimer);
      if (target !== linkTarget) showLinkChip(target, 'href');
    } else if (linkUi && !linkEditing) {
      clearTimeout(linkHideTimer);
      linkHideTimer = setTimeout(hideLinkUi, 400);
    }
  };


  // ── Element annotations: ⌃-click an element, attach an instruction ──
  // Saved notes show as a small 💬 marker on the element's corner; hovering
  // it highlights the element and shows the prompt, clicking it re-opens the
  // editor. Notes travel with the report as selector + snippet + instruction.
  // A note can cover several elements (⌃⇧-click adds to the open one); the map
  // is keyed on the first element and `selector` is then a CSS selector list.
  let notes = new Map(); // first element -> { els, selector, prompt, html }
  let carriedNotes = []; // notes from an earlier visit whose element isn't found (yet)
  let noteMarkers = new Map(); // element -> marker node
  let noteEditor = null;
  let noteTarget = null; // key element of the note being edited
  let noteEls = []; // every element that note covers
  let noteHl = null;
  let noteBubble = null;

  const snippetOf = (el) => {
    const html = htmlOf(el);
    // ponytail: head-truncate big elements; selector + snippet is enough context
    return html.length > 1500 ? html.slice(0, 1500) + ' …' : html;
  };

  const noteList = () => {
    const out = carriedNotes.slice();
    for (const [, n] of notes) out.push({ selector: n.selector, prompt: n.prompt, html: n.html });
    return out;
  };

  // The note's first element is gold; the ones added with ⌃⇧ are teal, so it
  // stays visible which element the note hangs off.
  const GOLD = '#FBB734';
  const TEAL = '#2DD4BF';

  const highlightNoteEl = (els) => {
    unhighlightNoteEl();
    noteHl = [];
    [els].flat().forEach((el, i) => {
      if (!el?.isConnected) return;
      noteHl.push({ el, outline: el.style.outline, offset: el.style.outlineOffset });
      el.style.outline = `3px solid ${i ? TEAL : GOLD}`;
      el.style.outlineOffset = '2px';
    });
  };
  const unhighlightNoteEl = () => {
    for (const h of noteHl || []) {
      h.el.style.outline = h.outline;
      h.el.style.outlineOffset = h.offset;
    }
    noteHl = null;
  };

  const hideNoteBubble = () => {
    noteBubble?.remove();
    noteBubble = null;
  };
  const showNoteBubble = (marker, prompt) => {
    hideNoteBubble();
    noteBubble = document.createElement('slop-off-ui');
    noteBubble.setAttribute('data-ec-ui', '');
    noteBubble.textContent = prompt.length > 200 ? prompt.slice(0, 200) + '…' : prompt;
    const r = marker.getBoundingClientRect();
    noteBubble.style.cssText =
      'position:fixed;z-index:2147483647;display:block;max-width:280px;background:#001E35;color:#fff;' +
      'border-radius:8px;padding:8px 10px;font:12px/1.5 -apple-system,"Segoe UI",sans-serif;' +
      `box-shadow:0 6px 24px rgba(0,30,53,.35);left:${Math.max(4, Math.min(r.left, innerWidth - 300))}px;` +
      `top:${r.bottom + 6}px;`;
    (document.body || document.documentElement).appendChild(noteBubble);
  };

  const positionMarker = (el, marker) => {
    if (!el.isConnected) {
      marker.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) {
      marker.style.display = 'none';
      return;
    }
    marker.style.display = 'flex';
    marker.style.left = `${Math.max(2, Math.min(r.right - 10, innerWidth - 24))}px`;
    marker.style.top = `${Math.max(2, r.top - 10)}px`;
  };

  // One marker per element the note covers — teal on the added ones, so a
  // multi-element note is visible at every place it hangs off.
  const createMarker = (el, key) => {
    const m = document.createElement('slop-off-ui');
    m.setAttribute('data-ec-ui', '');
    m.contentEditable = 'false';
    m._noteKey = key; // which note this marker belongs to (see syncMarkers)
    m.textContent = '💬';
    m.style.cssText =
      'position:fixed;z-index:2147483647;width:22px;height:22px;border-radius:50%;' +
      `background:${el === key ? GOLD : TEAL};` +
      'display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,30,53,.35);user-select:none;';
    m.addEventListener('mouseenter', () => {
      const n = notes.get(key);
      highlightNoteEl(n?.els || el);
      if (n) showNoteBubble(m, n.prompt);
    });
    m.addEventListener('mouseleave', () => {
      unhighlightNoteEl();
      hideNoteBubble();
    });
    for (const type of ['mousedown', 'mouseup', 'auxclick']) {
      m.addEventListener(type, (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
    }
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openNoteEditor(el);
    });
    (document.body || document.documentElement).appendChild(m);
    return m;
  };

  const syncMarkers = () => {
    const owner = new Map(); // every annotated element -> its note's key element
    for (const [key, n] of notes) for (const el of n.els) owner.set(el, key);
    for (const [el, marker] of noteMarkers) {
      if (owner.get(el) === marker._noteKey) continue;
      marker.remove();
      noteMarkers.delete(el);
    }
    for (const [el, key] of owner) {
      if (!noteMarkers.has(el)) noteMarkers.set(el, createMarker(el, key));
      positionMarker(el, noteMarkers.get(el));
    }
  };

  const onOutsideNote = (e) => {
    if (e.ctrlKey && e.shiftKey) return; // ⌃⇧-click extends the note instead
    if (noteEditor && !noteEditor.contains(e.target)) closeNoteEditor();
  };

  const closeNoteEditor = () => {
    document.removeEventListener('mousedown', onOutsideNote, true);
    noteEditor?.remove();
    noteEditor = null;
    noteTarget = null;
    noteEls = [];
    unhighlightNoteEl();
    clearTimeout(syncTimer);
    sync();
  };

  // Live save: everything typed is stored right away (debounced sync).
  const liveSaveNote = (value) => {
    const el = noteTarget;
    if (!el) return;
    const v = value.trim();
    const prev = notes.get(el);
    if (!v) notes.delete(el);
    else notes.set(el, {
      els: noteEls,
      selector: noteEls.map(cssPath).join(', '),
      prompt: v,
      // Snapshot stays put unless the selection itself changed.
      html: prev?.els.length === noteEls.length ? prev.html : noteEls.map(snippetOf).join('\n'),
    });
    syncMarkers();
    queueSync();
  };

  const queueSync = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 300);
  };

  const deleteNote = () => {
    const el = noteTarget;
    if (el) notes.delete(el);
    syncMarkers();
    closeNoteEditor();
  };

  // ⌃⇧-click adds another element to the note that's open right now. Toggles:
  // ⌃⇧-clicking an element that's already in the note drops it again.
  const addToNote = (el) => {
    const ta = noteEditor?.querySelector('textarea');
    if (!ta || !noteTarget) return;
    if (el === noteEls[0]) return; // the note hangs off this one
    noteEls = noteEls.includes(el) ? noteEls.filter((x) => x !== el) : [...noteEls, el];
    highlightNoteEl(noteEls);
    liveSaveNote(ta.value);
    ta.focus(); // keep typing where you left off
  };

  const openNoteEditor = (el) => {
    closeNoteEditor();
    hideNoteBubble();
    // Clicking any member of a group re-opens that group.
    const key = notes.has(el) ? el : [...notes].find(([, n]) => n.els.includes(el))?.[0] || el;
    noteTarget = key;
    noteEls = notes.get(key)?.els || [key];
    highlightNoteEl(noteEls);
    noteEditor = document.createElement('slop-off-ui');
    noteEditor.setAttribute('data-ec-ui', '');
    noteEditor.contentEditable = 'false';
    const r = el.getBoundingClientRect();
    // Terminal look: dark panel, mono font, ❯ prompt, gold caret.
    noteEditor.style.cssText =
      'position:fixed;z-index:2147483647;display:flex;flex-direction:column;gap:4px;width:340px;' +
      'background:#0B1826;border:1px solid #1E3A5F;border-radius:10px;padding:10px 12px;' +
      'box-shadow:0 8px 30px rgba(0,30,53,.45);' +
      `left:${Math.max(4, Math.min(r.left, innerWidth - 360))}px;` +
      `top:${Math.min(Math.max(4, r.bottom + 6), innerHeight - 150)}px;`;
    for (const type of ['click', 'auxclick', 'mousedown', 'mouseup']) {
      noteEditor.addEventListener(type, (e) => e.stopPropagation());
    }
    const promptRow = document.createElement('div');
    promptRow.style.cssText = 'display:flex;gap:8px;align-items:flex-start;';
    const chevron = document.createElement('span');
    chevron.textContent = '❯';
    chevron.style.cssText =
      'color:#FBB734;font:700 13px/1.5 ui-monospace,Menlo,monospace;flex:none;user-select:none;';
    const ta = document.createElement('textarea');
    ta.value = notes.get(key)?.prompt || '';
    ta.placeholder = 'instruction for this element…';
    ta.rows = 3;
    ta.style.cssText =
      'flex:1;background:transparent;border:none;outline:none;resize:none;padding:0;margin:0;' +
      'color:#E2E8F0;caret-color:#FBB734;font:13px/1.5 ui-monospace,Menlo,monospace;';
    ta.addEventListener('input', () => liveSaveNote(ta.value));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        closeNoteEditor(); // already saved live
      }
      if (e.key === 'Escape') closeNoteEditor();
      // Tab is handled by the document-level onTabCycle (capture phase).
    });
    promptRow.append(chevron, ta);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;';
    const del = document.createElement('button');
    del.title = 'Remove note';
    del.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
      '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    del.style.cssText =
      'display:flex;align-items:center;justify-content:center;width:26px;height:26px;' +
      'background:transparent;color:#64748B;border:none;border-radius:6px;cursor:pointer;padding:0;';
    del.addEventListener('mouseenter', () => {
      del.style.color = '#F87171';
      del.style.background = 'rgba(248,113,113,.12)';
    });
    del.addEventListener('mouseleave', () => {
      del.style.color = '#64748B';
      del.style.background = 'transparent';
    });
    del.addEventListener('click', deleteNote);
    row.appendChild(del);
    noteEditor.append(promptRow, row);
    (document.body || document.documentElement).appendChild(noteEditor);
    ta.focus();
    // Click anywhere outside closes (deferred so the opening click doesn't).
    setTimeout(() => document.addEventListener('mousedown', onOutsideNote, true), 0);
  };

  // ⌃-click picks an element. macOS turns ⌃-click into a contextmenu event,
  // other platforms fire a plain click — handle both.
  const annotatable = (el) =>
    el &&
    el !== document.documentElement &&
    el !== document.body &&
    !(el.closest && el.closest('[data-ec-ui]'));

  const onAnnotate = (e) => {
    if (viewMode !== 'new' || !e.ctrlKey || e.metaKey || e.altKey) return;
    if (!annotatable(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    clearAnnotateHover();
    // ⇧ only ever extends an open note — it never starts one.
    if (!e.shiftKey) openNoteEditor(e.target);
    else if (noteEditor) addToNote(e.target);
    else miniToast('Open a note with ⌃-click first, then ⌃⇧-click to add elements');
  };

  // While ⌃ is held, preview which element a click would pick.
  let annotateHover = null;
  let lastMouseTarget = null;

  const clearAnnotateHover = () => {
    if (!annotateHover) return;
    annotateHover.el.style.outline = annotateHover.outline;
    annotateHover.el.style.outlineOffset = annotateHover.offset;
    annotateHover = null;
  };

  const previewAnnotate = (el, ctrlDown, adding) => {
    // ⇧ aims at "add to the open note", so there has to be one — and the
    // element already in the note gets no preview, it's highlighted already.
    if (adding && (!noteEditor || noteEls.includes(el))) return clearAnnotateHover();
    if (!ctrlDown || viewMode !== 'new' || !annotatable(el)) return clearAnnotateHover();
    if (annotateHover?.el === el && annotateHover.adding === adding) return;
    clearAnnotateHover();
    annotateHover = { el, adding, outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = `2px dashed ${adding ? TEAL : GOLD}`;
    el.style.outlineOffset = '2px';
  };

  const aiming = (e) => e.ctrlKey && !e.metaKey && !e.altKey;

  const onAnnotateMove = (e) => {
    lastMouseTarget = e.target;
    previewAnnotate(e.target, aiming(e), e.shiftKey);
  };

  const onAnnotateKey = (e) => {
    if (e.key !== 'Control' && e.key !== 'Shift') return;
    if (e.type === 'keyup' && e.key === 'Control') clearAnnotateHover();
    else previewAnnotate(lastMouseTarget, aiming(e), e.shiftKey);
  };

  // Tab cycles through the annotated elements (Shift+Tab backwards) and
  // opens each prompt; the page's own tab order is bypassed entirely.
  const cycleNotes = (dir) => {
    const els = [...notes.keys()].filter((el) => el.isConnected);
    if (!els.length) return;
    let i = els.indexOf(noteTarget);
    i = i === -1 ? (dir > 0 ? 0 : els.length - 1) : (i + dir + els.length) % els.length;
    const el = els[i];
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    openNoteEditor(el);
  };

  const onTabCycle = (e) => {
    if (!active || viewMode !== 'new' || e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    cycleNotes(e.shiftKey ? -1 : 1);
  };

  // ── Discard the session: ✕ next to the chip, or a fast double-Esc ───
  const doDiscard = () => {
    setView('new'); // make sure the DOM holds the edits, not a view
    for (const [el, rec] of tracked) {
      if (el.isConnected && afterOf(el, rec) !== rec.before) el.outerHTML = rec.before;
    }
    try {
      chrome.runtime.sendMessage({ type: 'discard' });
    } catch (e) {}
    disable();
  };

  const discardSession = () => {
    try {
      chrome.runtime.sendMessage({ type: 'getSections' }, (sections) => {
        void chrome.runtime.lastError;
        const secs = Array.isArray(sections) ? sections : [];
        const past = secs.filter((s) => normUrl(s.url) !== normUrl(currentUrl));
        const total =
          changedEntries().length +
          carried.length +
          notes.size +
          carriedNotes.length +
          past.reduce((n, s) => n + s.edits.length + (s.notes?.length || 0), 0);
        if (
          total > 0 &&
          !window.confirm(`Discard ${total} change${total === 1 ? '' : 's'} from this session?`)
        ) {
          return;
        }
        doDiscard();
      });
    } catch (e) {
      doDiscard();
    }
  };

  let lastEsc = 0;
  const onEscDiscard = (e) => {
    if (!active || e.key !== 'Escape') return;
    if (helpEl) return closeHelp(); // Esc closes the shortcut sheet first, never discards
    if (e.target.closest && e.target.closest('[data-ec-ui]')) return; // Esc in our editors just closes them
    const now = Date.now();
    if (now - lastEsc < 450) {
      lastEsc = 0;
      discardSession();
    } else {
      lastEsc = now;
    }
  };

  const clearNotes = () => {
    closeNoteEditor();
    hideNoteBubble();
    clearAnnotateHover();
    noteMarkers.forEach((m) => m.remove());
    noteMarkers = new Map();
    notes = new Map();
    carriedNotes = [];
  };

  // ── Native controls: keep them working while editing ────────────────
  // designMode suppresses native activation (buttons don't click, selects
  // don't open, checkboxes don't toggle, details don't fold). Marking them
  // read-only for editing restores their behavior; ⌥-click makes one
  // temporarily editable again to change its label.
  let modeStyle = null;
  const editableOverrides = new Set();
  // designMode turns on native spellcheck, painting red squiggles under every
  // word. Suppress it on the editing host (body) and restore the page's own
  // setting on teardown.
  let prevSpellcheck = null; // undefined until saved; then null | string

  const addModeStyle = () => {
    if (prevSpellcheck === null) {
      prevSpellcheck = document.body.getAttribute('spellcheck') ?? false;
    }
    document.body.spellcheck = false;
    if (modeStyle?.isConnected) return;
    modeStyle?.remove();
    modeStyle = document.createElement('style');
    modeStyle.textContent =
      'input, select, textarea, details, summary, audio, video' +
      ' { -webkit-user-modify: read-only !important; }';
    document.documentElement.appendChild(modeStyle);
  };

  const removeModeStyle = () => {
    modeStyle?.remove();
    modeStyle = null;
    if (prevSpellcheck !== null) {
      if (prevSpellcheck === false) document.body.removeAttribute('spellcheck');
      else document.body.setAttribute('spellcheck', prevSpellcheck);
      prevSpellcheck = null;
    }
    editableOverrides.forEach((el) => el.removeAttribute('contenteditable'));
    editableOverrides.clear();
  };

  const onControlAltClick = (e) => {
    if (viewMode !== 'new') return;
    if (e.type !== 'click' || !e.altKey) return;
    const ctl = e.target.closest ? e.target.closest('summary') : null;
    if (!ctl || ctl.closest('[data-ec-ui]')) return;
    e.preventDefault();
    e.stopPropagation();
    ctl.contentEditable = 'true'; // stripped from reports by htmlOf
    editableOverrides.add(ctl);
    ctl.focus();
    miniToast('Label is now editable');
  };

  // Labels forward focus to their control on click, which steals the caret;
  // prevent that so label text stays editable. Buttons are editable too;
  // ⌘/Ctrl-click one to actually activate it.
  const onFormTextClick = (e) => {
    if (viewMode !== 'new') return;
    if (!e.isTrusted) return; // our own ctl.click() below must not recurse
    const ctl = e.target.closest ? e.target.closest('label, button') : null;
    if (!ctl) return;
    if (e.target.closest('[data-ec-ui]')) return;
    if (e.target.closest('input, select, textarea')) return; // a real control inside the label
    if (ctl.tagName === 'BUTTON' && e.metaKey) {
      // ⌘-only: ⌃-click is the annotate gesture.
      e.preventDefault();
      e.stopPropagation();
      ctl.click(); // deliberate activation
      return;
    }
    e.preventDefault();
    if (ctl.tagName === 'BUTTON') {
      // Chrome refuses to place a caret inside a <button> under designMode;
      // an explicit contenteditable island does accept one.
      ctl.contentEditable = 'true'; // stripped from reports by htmlOf
      editableOverrides.add(ctl);
      const sel = getSelection();
      sel.selectAllChildren(ctl);
      sel.collapseToEnd();
    }
  };

  // ── Live edits panel: current page's edits with per-edit undo ───────
  let panelEl = null;
  let chipEl = null;
  let listEl = null;
  let viewBarEl = null;
  let modeBtn = null;
  let submitBtn = null;
  let tipEl = null;
  let helpEl = null;
  let pendingEl = null;
  let panelOpen = false;

  // ── Pending pill: reports queued at the bridge, not yet picked up ───
  // Click the pill for the list; a row expands to the report text, ✕ cancels.
  let bridgeTimer = 0;
  let pendingListEl = null;
  let pendingOpen = false;
  let pendingReports = [];
  const pendingShown = new Set(); // ids with the report text expanded

  // Bridge state, always visible as a dot on the ⚙ button. "Bridge up" is
  // deliberately distinct from "an agent is actually waiting for edits".
  let bridgeState = 'checking'; // 'checking' | 'waiting' | 'idle' | 'off' | 'none'
  let bridgeDotEl = null;
  const BRIDGE_LABELS = {
    checking: 'checking agent connection…',
    waiting: 'agent is waiting for your edits',
    processing: 'agent is applying your edits…',
    idle: 'bridge up — no agent waiting right now',
    off: 'agent bridge not reachable',
    none: 'no webhook configured',
  };
  const BRIDGE_COLORS = {
    checking: '#FBB734',
    waiting: '#22C55E',
    processing: '#14B8A6',
    idle: '#195FA4',
    off: '#EF4444',
    none: '#CBD5E1',
  };
  const bridgeStateOf = (resp) =>
    !resp
      ? 'off'
      : !resp.configured
        ? 'none'
        : !resp.ok
          ? 'off'
          : resp.processing
            ? 'processing'
            : resp.waiting
              ? 'waiting'
              : 'idle';
  const paintBridgeDot = () => {
    if (!bridgeDotEl) return;
    bridgeDotEl.style.background = BRIDGE_COLORS[bridgeState];
  };

  const pollPending = () => {
    try {
      chrome.runtime.sendMessage({ type: 'checkBridge' }, (resp) => {
        void chrome.runtime.lastError;
        bridgeState = bridgeStateOf(resp);
        paintBridgeDot();
        if (!pendingEl) return;
        const n = resp?.pending || 0;
        pendingReports = resp?.reports || [];
        pendingEl.style.display = n ? 'inline-flex' : 'none';
        pendingEl.textContent = `⏳ ${n}`;
        if (!n) pendingOpen = false;
        renderPendingList();
      });
    } catch (e) {
      bridgeState = 'off';
      paintBridgeDot();
    }
  };

  const renderPendingList = () => {
    if (!pendingListEl) return;
    pendingListEl.style.display = pendingOpen && pendingReports.length ? 'block' : 'none';
    pendingListEl.textContent = '';
    if (!pendingOpen) return;
    for (const r of pendingReports) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid #EEF2F7;font-size:12px;';
      const label = document.createElement('div');
      label.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#001E35;cursor:pointer;';
      const time = new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const applying = r.phase === 'applying';
      label.textContent =
        `${time} · ${r.count ?? '?'} edit${r.count === 1 ? '' : 's'} · ` +
        (r.urls || []).map((u) => u.replace(/^https?:\/\//, '')).join(', ') +
        (applying ? ' · ⚙ applying…' : '');
      if (applying) label.style.color = '#0F766E';
      label.title = 'Show the report';
      label.addEventListener('click', () => {
        pendingShown.has(r.id) ? pendingShown.delete(r.id) : pendingShown.add(r.id);
        renderPendingList();
      });
      const x = document.createElement('button');
      x.textContent = '✕';
      x.title = applying
        ? 'Dismiss — the agent already picked this up'
        : 'Cancel: the agent will not pick this report up';
      x.style.cssText =
        'border:1px solid #CBD5E1;color:#B91C1C;background:#fff;border-radius:6px;cursor:pointer;padding:2px 8px;font:inherit;flex:none;';
      x.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'cancelReport', id: r.id }, (ok) => {
          void chrome.runtime.lastError;
          miniToast(ok ? 'Report cancelled' : '⚠ Could not cancel — already picked up?');
          pollPending();
        });
      });
      row.append(label, x);
      pendingListEl.appendChild(row);
      if (pendingShown.has(r.id)) {
        const pre = document.createElement('pre');
        pre.textContent = r.report || '(no report text)';
        pre.style.cssText =
          'margin:0;padding:8px 10px;background:#F8FAFC;border-bottom:1px solid #EEF2F7;' +
          'max-height:150px;overflow:auto;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
          'color:#475569;white-space:pre-wrap;word-break:break-word;';
        pendingListEl.appendChild(pre);
      }
    }
  };

  // Custom tooltip: native `title` popups appear at the cursor and cover the
  // very buttons they describe (and can fall off-screen down here in the
  // bottom-right). Ours floats centered just above the hovered control.
  const showTip = (target, text) => {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.setAttribute('data-ec-ui', '');
      tipEl.contentEditable = 'false';
      tipEl.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;background:#001E35;color:#fff;' +
        'padding:6px 9px;border-radius:7px;max-width:220px;white-space:normal;' +
        'font:500 12px/1.35 -apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(0,30,53,.35);' +
        'opacity:0;transition:opacity .12s;';
      (document.body || document.documentElement).appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.style.display = 'block';
    const r = target.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect(); // measured with text in place
    const left = Math.max(8, Math.min(r.left + r.width / 2 - tr.width / 2, innerWidth - tr.width - 8));
    tipEl.style.left = left + 'px';
    tipEl.style.top = Math.max(8, r.top - tr.height - 8) + 'px';
    tipEl.style.opacity = '1';
  };
  const hideTip = () => {
    if (tipEl) tipEl.style.opacity = '0';
  };
  const attachTip = (el, text) => {
    // `text` may be a function for tips that show live state.
    el.addEventListener('mouseenter', () => showTip(el, typeof text === 'function' ? text() : text));
    el.addEventListener('mouseleave', hideTip);
  };

  // ── ⚙ overlay: panes come from panes.js (shared with the options page) ─
  const REPO_URL = 'https://github.com/wbso-ai/slop-off';
  const SVG_GITHUB =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 1.5A10.5 10.5 0 0 0 8.68 22c.53.1.72-.23.72-.5v-1.9c-2.93.64-3.55-1.25-3.55-1.25-.48-1.22-1.17-1.55-1.17-1.55-.96-.65.07-.64.07-.64 1.06.08 1.62 1.09 1.62 1.09.94 1.62 2.47 1.15 3.07.88.1-.68.37-1.15.67-1.42-2.34-.27-4.8-1.17-4.8-5.2 0-1.15.41-2.09 1.09-2.83-.11-.27-.47-1.34.1-2.8 0 0 .88-.28 2.9 1.08a10 10 0 0 1 5.28 0c2-1.36 2.9-1.08 2.9-1.08.57 1.46.21 2.53.1 2.8.68.74 1.09 1.68 1.09 2.83 0 4.04-2.47 4.93-4.82 5.19.38.33.72.97.72 1.96v2.9c0 .28.19.61.73.5A10.5 10.5 0 0 0 12 1.5Z"/></svg>';

  let helpPingTimer = 0;
  let helpTab = 'keys'; // remembered across open/close: 'keys' | 'notes'
  const closeHelp = () => {
    clearInterval(helpPingTimer);
    helpPingTimer = 0;
    helpEl?.remove();
    helpEl = null;
  };

  const paintLamp = (state) => {
    if (!helpEl) return;
    const lamp = helpEl.querySelector('[data-ec-lamp]');
    const txt = helpEl.querySelector('[data-ec-lamptext]');
    if (!lamp || !txt) return;
    const set = (bg, glow, color, label) => {
      lamp.style.background = bg;
      lamp.style.boxShadow = glow;
      txt.style.color = color;
      txt.textContent = label;
    };
    if (state === 'waiting')
      set('#22C55E', '0 0 0 3px rgba(34,197,94,.22)', '#15803D', 'Agent is waiting for your edits');
    else if (state === 'processing')
      set('#14B8A6', '0 0 0 3px rgba(20,184,166,.22)', '#0F766E', 'Agent is applying your edits…');
    else if (state === 'idle')
      set('#195FA4', '0 0 0 3px rgba(25,95,164,.22)', '#195FA4', 'Bridge up — no agent waiting (run /slop-off)');
    else if (state === 'checking') set('#FBB734', '0 0 0 3px rgba(251,183,52,.22)', '#B45309', 'Checking connection…');
    else if (state === 'none') set('#CBD5E1', 'none', '#94A3B8', 'No webhook configured');
    else set('#EF4444', 'none', '#B91C1C', 'Agent bridge not reachable');
  };

  const pingBridge = () => {
    try {
      chrome.runtime.sendMessage({ type: 'checkBridge' }, (resp) => {
        void chrome.runtime.lastError;
        if (!helpEl) return;
        paintLamp(bridgeStateOf(resp));
      });
    } catch (e) {
      paintLamp('off');
    }
  };

  let helpTabsApi = null;
  const toggleHelp = (tab) => {
    if (helpEl) {
      closeHelp();
      helpTabsApi = null;
      if (!tab) return; // plain toggle: second click closes
    }
    if (tab) helpTab = tab;

    helpEl = document.createElement('div');
    helpEl.setAttribute('data-ec-ui', '');
    helpEl.contentEditable = 'false';
    helpEl.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,30,53,.5);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);' +
      'font:13px/1.4 -apple-system,"Segoe UI",sans-serif;';
    helpEl.innerHTML =
      // Fixed-size sheet: switching tabs never resizes the panel.
      `<div style="background:#fff;border-radius:18px;box-shadow:0 30px 80px rgba(0,30,53,.45);` +
      `width:min(640px,calc(100vw - 40px));height:min(580px,calc(100vh - 40px));display:flex;` +
      `flex-direction:column;overflow:hidden;padding:22px 24px 20px;box-sizing:border-box;">` +
      // header: tab switcher (filled by panes.js) + close
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px;flex:none;">` +
      `<div data-ec-tabs></div>` +
      `<button data-ec-close="1" aria-label="Close" style="flex:none;border:none;background:#F1F5F9;color:#64748B;` +
      `width:30px;height:30px;border-radius:999px;cursor:pointer;font-size:15px;line-height:1;">✕</button></div>` +
      // panes, one visible at a time, inside a scroll area
      `<div data-ec-panes style="flex:1;min-height:0;overflow:auto;"></div>` +
      // footer: status lamp + github + esc hint
      `<div style="margin-top:18px;padding-top:14px;border-top:1px solid #EEF2F7;display:flex;flex:none;` +
      `align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">` +
      `<div style="display:flex;align-items:center;gap:8px;">` +
      `<span data-ec-lamp style="width:9px;height:9px;border-radius:50%;background:#FBB734;flex:none;` +
      `transition:background .2s,box-shadow .2s;"></span>` +
      `<span data-ec-lamptext style="font-size:12px;font-weight:600;color:#B45309;">Checking connection…</span></div>` +
      `<div style="display:flex;align-items:center;gap:14px;color:#94A3B8;font-size:12px;">` +
      `<span>Press <kbd style="padding:2px 6px;background:#F1F5F9;border:1px solid #CBD5E1;border-radius:5px;` +
      `font:600 11px/1 ui-monospace,monospace;color:#475569;">Esc</kbd> to close</span>` +
      `<a data-ec-gh href="${REPO_URL}" target="_blank" rel="noopener noreferrer" ` +
      `style="display:inline-flex;align-items:center;gap:5px;color:#64748B;text-decoration:none;font-weight:600;">` +
      `${SVG_GITHUB}<span>GitHub</span></a></div></div></div>`;
    helpEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-ec-gh]')) {
        // designMode can swallow a plain link click; open it ourselves.
        e.preventDefault();
        window.open(REPO_URL, '_blank', 'noopener');
        return;
      }
      if (e.target === helpEl || e.target.closest('[data-ec-close]')) closeHelp();
    });
    // Own the keyboard while open: Esc closes the sheet without reaching the
    // double-Esc discard handler, and typing can't leak into the page.
    helpEl.addEventListener(
      'keydown',
      (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') closeHelp();
      },
      true
    );
    (document.body || document.documentElement).appendChild(helpEl);
    helpEl.querySelector('[data-ec-close]')?.focus();

    // Shared panes (panes.js): same tabs as the options page.
    const P = window.SlopOffPanes;
    const resend = (item, cb) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'resendReport', report: item.report, count: item.count, urls: item.urls || [] },
          (ok) => {
            void chrome.runtime.lastError;
            pollPending();
            cb(Boolean(ok));
          }
        );
      } catch (e) {
        cb(false);
      }
    };
    helpTabsApi = P.mountTabs(
      helpEl.querySelector('[data-ec-tabs]'),
      helpEl.querySelector('[data-ec-panes]'),
      [
        { key: 'keys', label: 'Shortcuts', fill: P.renderShortcuts },
        { key: 'notes', label: 'Notifications', fill: (el) => P.renderNotifications(el, { toast: miniToast }) },
        { key: 'history', label: 'History', fill: (el) => P.renderHistory(el, { toast: miniToast, resend }) },
        { key: 'settings', label: 'Settings', fill: (el) => P.renderSettings(el, { toast: miniToast }) },
      ],
      helpTab,
      (key) => (helpTab = key)
    );

    paintLamp('checking');
    pingBridge();
    helpPingTimer = setInterval(() => {
      pingBridge();
      // Live refresh while open (settings has a build-once guard, so no clobber).
      if (helpTabsApi && helpTabsApi.getTab() !== 'settings') helpTabsApi.refresh();
    }, 4000);
  };

  // Current after-state of a tracked element, view-safe: while a view is
  // shown, the DOM holds view content, so read the stored snapshot instead.
  const afterOf = (el, rec) => {
    if (viewMode === 'new') {
      return el.isConnected ? htmlOf(el) : rec.after != null ? rec.after : '(element removed)';
    }
    return rec.after != null ? rec.after : rec.before;
  };

  const changedEntries = () => {
    const out = [];
    for (const [el, rec] of tracked) {
      if (afterOf(el, rec) !== rec.before) out.push([el, rec]);
    }
    return out;
  };

  const undoEdit = (el) => {
    setView('new'); // restore the live state before touching the DOM
    const rec = tracked.get(el);
    if (!rec) return;
    // ponytail: outerHTML swap restores markup but drops JS listeners on that element
    if (el.isConnected) el.outerHTML = rec.before;
    tracked.delete(el);
    sync();
  };

  const ensurePanel = () => {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.setAttribute('data-ec-ui', '');
    panelEl.setAttribute('data-slop-stack', ''); // toasts stack above the panel
    panelEl.contentEditable = 'false'; // keep our own UI out of designMode
    panelEl.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:2147483647;display:flex;flex-direction:column;' +
      'align-items:flex-end;gap:8px;font:13px/1.4 -apple-system,"Segoe UI",sans-serif;color:#001E35;';
    listEl = document.createElement('div');
    listEl.style.cssText =
      'display:none;background:#fff;border:1px solid #CBD5E1;border-radius:10px;' +
      'box-shadow:0 8px 30px rgba(0,30,53,.25);max-height:40vh;overflow:auto;width:380px;';
    chipEl = document.createElement('button');
    chipEl.style.cssText =
      'background:#001E35;color:#fff;border:none;border-radius:999px;padding:8px 14px;' +
      'font:600 13px/1 -apple-system,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,30,53,.3);';
    chipEl.addEventListener('click', () => {
      panelOpen = !panelOpen;
      renderPanel();
    });
    viewBarEl = document.createElement('div');
    // Right-aligned above the chip row, like the rest of the panel column.
    viewBarEl.style.cssText =
      'display:none;background:#fff;border:1px solid #CBD5E1;border-radius:999px;' +
      'overflow:hidden;box-shadow:0 4px 16px rgba(0,30,53,.2);';
    for (const [mode, label] of [
      ['original', 'original'],
      ['diff', 'diff'],
      ['new', 'new'],
    ]) {
      const b = document.createElement('button');
      b.dataset.mode = mode;
      b.textContent = label;
      b.style.cssText =
        'border:none;background:transparent;padding:6px 12px;cursor:pointer;' +
        'font:600 12px/1 -apple-system,"Segoe UI",sans-serif;color:#001E35;' +
        (mode !== 'original' ? 'border-left:1px solid #E2E8F0;' : '');
      b.addEventListener('click', () => setView(mode));
      viewBarEl.appendChild(b);
    }
    const discardBtn = document.createElement('button');
    discardBtn.textContent = '✕';
    discardBtn.style.cssText =
      'background:#001E35;color:#94A3B8;border:none;border-radius:999px;width:30px;height:30px;' +
      'cursor:pointer;font:600 13px/1 -apple-system,"Segoe UI",sans-serif;flex:none;' +
      'box-shadow:0 4px 16px rgba(0,30,53,.3);';
    discardBtn.addEventListener('mouseenter', () => (discardBtn.style.color = '#F87171'));
    discardBtn.addEventListener('mouseleave', () => (discardBtn.style.color = '#94A3B8'));
    discardBtn.addEventListener('click', discardSession);
    attachTip(discardBtn, 'Discard all changes (double-Esc)');
    // ── Segmented toggles: both options visible, active one filled dark on
    // white — same shape as the view bar so on/off reads at a glance.
    const makeSegBtn = (svg, tip, first) => {
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.innerHTML = svg;
      attachTip(seg, tip);
      seg.style.cssText =
        'border:none;background:transparent;width:32px;height:28px;cursor:pointer;flex:none;' +
        'display:flex;align-items:center;justify-content:center;color:#94A3B8;' +
        'transition:background .12s,color .12s;' +
        (first ? '' : 'border-left:1px solid #E2E8F0;');
      return seg;
    };
    // modeBtn is a 2-segment pill: [ 📦 batch | ⚡ instant ]
    modeBtn = document.createElement('div');
    modeBtn.style.cssText = SEG_PILL;
    const batchSeg = makeSegBtn(SVG_BOX, 'Batch: changes ship when you end the session', true);
    const instantSeg = makeSegBtn(SVG_BOLT, 'Instant: each change is sent as soon as you pause', false);
    const setMode = (next) => {
      if (instantMode === next) return;
      instantMode = next;
      try {
        chrome.storage.sync.set({ instant: instantMode });
      } catch (e) {}
      paintModeBtn();
      if (instantMode) scheduleInstantFlush();
    };
    batchSeg.addEventListener('click', () => setMode(false));
    instantSeg.addEventListener('click', () => setMode(true));
    modeBtn.append(batchSeg, instantSeg);
    submitBtn = document.createElement('button');
    submitBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
    submitBtn.style.cssText =
      'border:none;border-radius:999px;width:30px;height:30px;cursor:pointer;flex:none;' +
      'display:none;align-items:center;justify-content:center;background:#195FA4;color:#fff;' +
      'box-shadow:0 4px 16px rgba(0,30,53,.3);';
    submitBtn.addEventListener('click', () => flushNow(true));
    attachTip(submitBtn, 'Send pending changes to the agent now (⌘⏎ — session keeps going)');
    // Gear: opens the shortcuts / notifications overlay. The dot in its
    // corner always shows the agent-bridge state (green/red/gray).
    const helpBtn = document.createElement('button');
    helpBtn.type = 'button';
    helpBtn.innerHTML = SVG_GEAR;
    helpBtn.style.cssText =
      'position:relative;width:30px;height:30px;border-radius:999px;cursor:pointer;flex:none;background:#fff;' +
      'border:1px solid #CBD5E1;color:#001E35;display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 4px 16px rgba(0,30,53,.2);';
    bridgeDotEl = document.createElement('span');
    bridgeDotEl.style.cssText =
      'position:absolute;top:-2px;right:-2px;width:10px;height:10px;border-radius:50%;' +
      'border:2px solid #fff;background:#FBB734;pointer-events:none;';
    helpBtn.appendChild(bridgeDotEl);
    paintBridgeDot();
    helpBtn.addEventListener('click', () => toggleHelp());
    attachTip(helpBtn, () => `Shortcuts & settings — ${BRIDGE_LABELS[bridgeState]}`);
    // Pending pill: how many sent reports still await the agent.
    pendingEl = document.createElement('button');
    pendingEl.type = 'button';
    pendingEl.style.cssText =
      'display:none;align-items:center;height:28px;padding:0 10px;border-radius:999px;flex:none;' +
      'background:#fff;border:1px solid #CBD5E1;color:#B45309;cursor:pointer;' +
      'font:600 12px/1 -apple-system,"Segoe UI",sans-serif;box-shadow:0 4px 16px rgba(0,30,53,.2);';
    attachTip(pendingEl, 'Reports waiting to be picked up by the agent — click to view or cancel');
    pendingEl.addEventListener('click', () => {
      pendingOpen = !pendingOpen;
      renderPendingList();
    });
    pendingListEl = document.createElement('div');
    pendingListEl.style.cssText =
      'display:none;background:#fff;border:1px solid #CBD5E1;border-radius:10px;' +
      'box-shadow:0 8px 30px rgba(0,30,53,.25);max-height:35vh;overflow:auto;width:340px;';
    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
    chipRow.append(helpBtn, modeBtn, pendingEl, chipEl, submitBtn, discardBtn);
    paintModeBtn();
    panelEl.append(pendingListEl, listEl, viewBarEl, chipRow);
    (document.body || document.documentElement).appendChild(panelEl);
  };

  // Readable text of a captured HTML snippet (form control values included).
  const textOf = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    let text;
    const input = d.querySelector('input');
    if (input) text = input.getAttribute('value') || '';
    else if (d.querySelector('select')) text = d.querySelector('option[selected]')?.textContent || '';
    else text = d.textContent || '';
    return text.replace(/\s+/g, ' ').trim();
  };

  const attrOf = (html, name) => {
    const m = html.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : null;
  };

  // Word-level LCS diff → [['same'|'del'|'ins', text], ...]
  const diffWords = (a, b) => {
    const A = a.split(/\s+/).filter(Boolean);
    const B = b.split(/\s+/).filter(Boolean);
    // ponytail: O(n·m) LCS; bail to plain before/after on huge texts
    if (A.length * B.length > 40000) return [['del', a], ['ins', b]];
    const m = A.length;
    const n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const parts = [];
    let i = 0;
    let j = 0;
    const push = (t, w) => {
      const last = parts[parts.length - 1];
      if (last && last[0] === t) last[1] += ' ' + w;
      else parts.push([t, w]);
    };
    while (i < m && j < n) {
      if (A[i] === B[j]) {
        push('same', A[i]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push('del', A[i++]);
      } else {
        push('ins', B[j++]);
      }
    }
    while (i < m) push('del', A[i++]);
    while (j < n) push('ins', B[j++]);
    return parts;
  };

  const DIFF_DEL = 'text-decoration:line-through;color:#B91C1C;background:#FEF2F2;border-radius:3px;';
  const DIFF_INS = 'color:#166534;background:#F0FDF4;border-radius:3px;font-weight:600;';

  const addDiffSpan = (node, style, text) => {
    const s = document.createElement('span');
    s.textContent = text + ' ';
    s.style.cssText = style;
    node.appendChild(s);
  };

  const renderDiff = (node, before, after) => {
    for (const [type, text] of diffWords(before, after)) {
      if (type === 'same') {
        const words = text.split(' ');
        const shown =
          words.length > 14 ? `${words.slice(0, 5).join(' ')} … ${words.slice(-5).join(' ')}` : text;
        addDiffSpan(node, 'color:#64748B;', shown);
      } else {
        addDiffSpan(node, type === 'del' ? DIFF_DEL : DIFF_INS, text);
      }
    }
  };

  // ── View toggle: show the page as original / diff / new ─────────────
  // The tracked elements stay in place; only their *content* is swapped, so
  // tracking survives the round-trip. Original/diff views are read-only.
  const parseFrag = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    return t.content.firstElementChild;
  };

  // Put the content/state of `html` into the live element without replacing it.
  const applyContent = (el, html) => {
    const src = parseFrag(html);
    if (!src) return;
    if (isFormControl(el)) {
      if (el.tagName === 'TEXTAREA') el.value = src.getAttribute('placeholder') ? '' : src.textContent;
      else if (el.tagName === 'SELECT') {
        const i = [...src.querySelectorAll('option')].findIndex((o) => o.hasAttribute('selected'));
        if (i >= 0) el.selectedIndex = i;
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        el.checked = src.hasAttribute('checked');
      } else {
        el.value = src.getAttribute('value') || '';
        if (src.hasAttribute('placeholder')) el.placeholder = src.getAttribute('placeholder');
      }
      return;
    }
    el.replaceChildren(...src.childNodes);
  };

  // ponytail: the in-page diff flattens nested markup to a word-diff of the
  // text; attribute-only changes just show the new state
  const applyDiffContent = (el, rec) => {
    const bt = textOf(rec.before);
    const at = textOf(rec.after);
    if (isFormControl(el)) {
      const show = bt === at ? at : `${bt} → ${at}`;
      if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') {
        applyContent(el, rec.after);
      } else if (phMode.has(el) || parseFrag(rec.after)?.hasAttribute('placeholder')) {
        el.value = '';
        el.placeholder = show;
      } else {
        el.value = show;
      }
      return;
    }
    if (bt === at) return applyContent(el, rec.after);
    el.replaceChildren();
    for (const [type, text] of diffWords(bt, at)) {
      const s = document.createElement('span');
      s.textContent = text + ' ';
      if (type === 'del') s.style.cssText = DIFF_DEL;
      else if (type === 'ins') s.style.cssText = DIFF_INS;
      el.appendChild(s);
    }
  };

  const setView = (mode) => {
    if (!active || mode === viewMode) return;
    if (viewMode === 'new') updateAfters(); // capture the live state first
    hideLinkUi();
    viewMode = mode;
    // Views behave like a normal page: no caret, no editing, links work.
    document.designMode = mode === 'new' ? 'on' : 'off';
    for (const [el, rec] of tracked) {
      if (!el.isConnected || rec.after == null || rec.after === rec.before) continue;
      if (mode === 'original') applyContent(el, rec.before);
      else if (mode === 'new') applyContent(el, rec.after);
      else applyDiffContent(el, rec);
    }
    renderPanel();
  };

  // Text diff when the text changed; otherwise the changed attribute.
  const renderChange = (node, beforeHtml, afterHtml) => {
    const bt = textOf(beforeHtml);
    const at = textOf(afterHtml);
    if (bt !== at) return renderDiff(node, bt, at);
    for (const name of ['href', 'placeholder', 'checked', 'value', 'src']) {
      const b = attrOf(beforeHtml, name);
      const a = attrOf(afterHtml, name);
      if (b !== a) {
        const fmt = (v) => (v === null ? '(off)' : v === '' ? '(on)' : v);
        addDiffSpan(node, 'color:#64748B;', name + ':');
        addDiffSpan(node, DIFF_DEL, fmt(b));
        addDiffSpan(node, DIFF_INS, fmt(a));
        return;
      }
    }
    addDiffSpan(node, 'color:#64748B;', '(HTML change)');
  };

  const renderPanel = () => {
    if (!active) return;
    ensurePanel();
    // Past pages' edits live in the background; fetch, then paint.
    try {
      chrome.runtime.sendMessage({ type: 'getSections' }, (resp) => {
        void chrome.runtime.lastError;
        paintPanel(Array.isArray(resp) ? resp : []);
      });
    } catch (e) {
      paintPanel([]);
    }
  };

  const paintPanel = (sections) => {
    if (!active || !panelEl) return;
    const entries = changedEntries();
    const past = sections.filter(
      (s) => normUrl(s.url) !== normUrl(currentUrl) && (s.edits.length > 0 || s.notes?.length > 0)
    );
    const total = entries.length + carried.length + past.reduce((n, s) => n + s.edits.length, 0);
    const noteTotal =
      notes.size + carriedNotes.length + past.reduce((n, s) => n + (s.notes?.length || 0), 0);
    chipEl.textContent =
      `✏️ ${total} edit${total === 1 ? '' : 's'}` + (noteTotal ? ` · 💬 ${noteTotal}` : '');
    if (submitBtn) submitBtn.style.display = total || noteTotal ? 'flex' : 'none';
    viewBarEl.style.display = entries.length ? 'flex' : 'none';
    for (const b of viewBarEl.children) {
      const on = b.dataset.mode === viewMode;
      b.style.background = on ? '#001E35' : 'transparent';
      b.style.color = on ? '#fff' : '#001E35';
    }
    listEl.style.display = panelOpen && (total || noteTotal) ? 'block' : 'none';
    listEl.textContent = '';
    if (!panelOpen) return;

    const addHeader = (url, suffix) => {
      const h = document.createElement('div');
      h.textContent = url.replace(/^https?:\/\//, '') + (suffix || '');
      h.title = url;
      h.style.cssText =
        'padding:6px 10px;background:#F8FAFC;color:#64748B;font-size:11px;font-weight:700;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid #EEF2F7;';
      if (!suffix) {
        // Other pages: click to switch — the session survives the navigation
        // and the edits there are re-applied.
        h.style.color = '#195FA4';
        h.style.cursor = 'pointer';
        h.style.textDecoration = 'underline';
        h.addEventListener('click', () => {
          clearTimeout(syncTimer);
          sync(); // flush before we leave
          location.href = url;
        });
      }
      listEl.appendChild(h);
    };
    const rowBtn = (text, title, onClick) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.title = title;
      btn.style.cssText =
        'border:1px solid #195FA4;color:#195FA4;background:#fff;border-radius:6px;cursor:pointer;padding:2px 8px;font:inherit;flex:none;';
      btn.addEventListener('click', onClick);
      return btn;
    };
    const addRow = (before, after, selector, onUndo, onRemove) => {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid #EEF2F7;';
      const label = document.createElement('div');
      label.style.cssText = 'flex:1;min-width:0;word-break:break-word;';
      label.title = selector || '';
      renderChange(label, before, after);
      row.appendChild(label);
      if (onUndo) row.appendChild(rowBtn('↩︎', 'Undo this edit', onUndo));
      if (onRemove) row.appendChild(rowBtn('✕', 'Drop this edit from the report', onRemove));
      listEl.appendChild(row);
    };
    const addNoteRow = (n, onEdit, onRemove) => {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid #EEF2F7;';
      const label = document.createElement('div');
      label.style.cssText = 'flex:1;min-width:0;word-break:break-word;color:#334155;';
      label.title = n.selector || '';
      label.textContent = `💬 ${n.prompt.length > 120 ? n.prompt.slice(0, 120) + '…' : n.prompt}`;
      row.appendChild(label);
      if (onEdit) row.appendChild(rowBtn('✎', 'Edit this note', onEdit));
      if (onRemove) row.appendChild(rowBtn('✕', 'Remove this note', onRemove));
      listEl.appendChild(row);
    };

    for (const s of past) {
      addHeader(s.url);
      for (const e of s.edits) {
        addRow(e.before, e.after, e.selector, null, () => {
          try {
            chrome.runtime.sendMessage(
              { type: 'removeEdit', url: s.url, selector: e.selector, before: e.before },
              () => {
                void chrome.runtime.lastError;
                renderPanel();
              }
            );
          } catch (err) {}
        });
      }
      for (const n of s.notes || []) {
        addNoteRow(n, null, () => {
          try {
            chrome.runtime.sendMessage(
              { type: 'removeEdit', url: s.url, selector: n.selector, prompt: n.prompt, noteMode: true },
              () => {
                void chrome.runtime.lastError;
                renderPanel();
              }
            );
          } catch (err) {}
        });
      }
    }
    if (entries.length || carried.length || notes.size || carriedNotes.length) {
      addHeader(currentUrl, ' — this page');
      for (const e of carried) {
        addRow(e.before, e.after, e.selector, null, () => {
          carried = carried.filter((x) => x !== e);
          sync();
        });
      }
      for (const [el, rec] of entries) {
        addRow(rec.before, afterOf(el, rec), rec.selector, () => undoEdit(el), null);
      }
      for (const n of carriedNotes) {
        addNoteRow(n, null, () => {
          carriedNotes = carriedNotes.filter((x) => x !== n);
          sync();
        });
      }
      for (const [el, n] of notes) {
        addNoteRow(
          n,
          () => openNoteEditor(el),
          () => {
            notes.delete(el);
            syncMarkers();
            sync();
          }
        );
      }
    }
  };

  const SVG_BOLT =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
  const SVG_BOX =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
    '<path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/></svg>';

  // White segmented-pill shell shared by the mode and model toggles.
  const SEG_PILL =
    'display:inline-flex;align-items:center;height:30px;background:#fff;border:1px solid #CBD5E1;' +
    'border-radius:999px;overflow:hidden;flex:none;box-shadow:0 4px 16px rgba(0,30,53,.2);';
  // Fill the active segment dark, dim the inactive one — the on/off tell.
  const paintSeg = (seg, on) => {
    seg.style.background = on ? '#001E35' : 'transparent';
    seg.style.color = on ? '#fff' : '#94A3B8';
  };

  const paintModeBtn = () => {
    if (!modeBtn) return;
    paintSeg(modeBtn.children[0], !instantMode); // batch
    paintSeg(modeBtn.children[1], instantMode); // instant
  };

  const SVG_GEAR =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  const removePanel = () => {
    clearInterval(helpPingTimer);
    helpPingTimer = 0;
    panelEl?.remove();
    tipEl?.remove();
    helpEl?.remove();
    panelEl = chipEl = listEl = viewBarEl = modeBtn = submitBtn = tipEl = helpEl = pendingEl = pendingListEl = bridgeDotEl = null;
    panelOpen = false;
    pendingOpen = false;
  };

  // ponytail: fixed overlay border instead of html outline, so it stays above page's fixed/high-z-index elements
  let borderEl = null;
  const showBorder = () => {
    if (borderEl) return;
    borderEl = document.createElement('div');
    borderEl.style.cssText =
      'position:fixed;inset:0;border:4px solid #FBB734;pointer-events:none;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(borderEl);
  };
  const hideBorder = () => {
    borderEl?.remove();
    borderEl = null;
  };

  const disable = () => {
    if (!active) return;
    active = false;
    clearTimeout(syncTimer);
    clearTimeout(instantTimer);
    clearInterval(urlWatch);
    clearInterval(bridgeTimer);
    document.removeEventListener('beforeinput', onBeforeInput, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('contextmenu', onAnnotate, true);
    document.removeEventListener('click', onAnnotate, true);
    document.removeEventListener('mousemove', onAnnotateMove, true);
    document.removeEventListener('keydown', onAnnotateKey, true);
    document.removeEventListener('keyup', onAnnotateKey, true);
    document.removeEventListener('keydown', onTabCycle, true);
    document.removeEventListener('keydown', onEscDiscard, true);
    document.removeEventListener('keydown', onSubmitKey, true);
    document.removeEventListener('click', onControlAltClick, true);
    document.removeEventListener('click', onLinkClick, true);
    document.removeEventListener('auxclick', onLinkClick, true);
    document.removeEventListener('click', onFormTextClick, true);
    document.removeEventListener('mouseover', onLinkHover, true);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('popstate', checkUrlChange);
    document.designMode = 'off';
    removeModeStyle();
    hideBorder();
    removePanel();
    hideLinkUi();
    clearNotes();
    reapplyTimers.forEach(clearTimeout);
    reapplyTimers = [];
    carried = [];
    tracked = new Map();
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'showNotifications') {
      // Clicked agent toast: open the overlay on the notifications tab.
      if (!active) return sendResponse(false); // background falls back to settings
      closeHelp();
      toggleHelp('notes');
      sendResponse(true);
      return;
    }
    if (msg.type === 'finalize') {
      // Don't checkUrlChange() here: its fire-and-forget sync could race the
      // background's section read. `tracked` always belongs to `currentUrl`,
      // so responding with it directly is both safe and correct.
      setView('new'); // leave the page in its edited state, not a view
      updateAfters();
      sendResponse({ url: currentUrl, edits: snapshot(), notes: noteList() });
      disable();
    }
  });

  window.__slopOffEnable = enable;
  enable();
})();
