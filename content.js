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
      });
    } catch (e) {
      // Extension context gone (e.g. reloaded); nothing we can do.
    }
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
          const section = sections.filter((s) => normUrl(s.url) === adoptedUrl && s.edits.length > 0).pop();
          if (!section) return;
          let pending = section.edits.slice();
          const attempt = () => {
            if (!active || normUrl(currentUrl) !== adoptedUrl) return;
            // An element re-edited in the meantime wins over its old edit.
            const trackedSelectors = new Set([...tracked.values()].map((r) => r.selector));
            pending = pending.filter((edit) => !trackedSelectors.has(edit.selector) && !reattach(edit));
            carried = pending;
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
  };

  // ── Links: never navigate while editing; ⌥-click edits the URL ──────
  let linkHintShown = false;

  const TOAST_CSS =
    'position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#001E35;color:#fff;' +
    'border-left:4px solid #FBB734;border-radius:10px;padding:10px 16px;' +
    'font:600 13px/1.4 -apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,30,53,.35);';

  const miniToast = (text) => {
    const t = document.createElement('div');
    t.setAttribute('data-ec-ui', '');
    t.textContent = text;
    t.style.cssText = TOAST_CSS;
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => t.remove(), 2600);
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
    if (e.type === 'click' && (e.metaKey || e.ctrlKey)) {
      if (a.href) {
        clearTimeout(syncTimer);
        sync(); // flush before we leave
        location.href = a.href;
      }
      return;
    }
    if (!linkHintShown) {
      linkHintShown = true;
      miniToast('Link clicks are off in edit mode — ⌘/Ctrl-click follows, hover to edit URL');
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
    if (ctl.tagName === 'BUTTON' && (e.metaKey || e.ctrlKey)) {
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
  let panelOpen = false;

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
    panelEl.contentEditable = 'false'; // keep our own UI out of designMode
    panelEl.style.cssText =
      'position:fixed;left:20px;bottom:20px;z-index:2147483647;display:flex;flex-direction:column;' +
      'align-items:flex-start;gap:8px;font:13px/1.4 -apple-system,"Segoe UI",sans-serif;color:#001E35;';
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
    viewBarEl.style.cssText =
      'display:none;background:#fff;border:1px solid #CBD5E1;border-radius:999px;overflow:hidden;' +
      'box-shadow:0 4px 16px rgba(0,30,53,.2);';
    for (const [mode, label] of [
      ['original', 'Original'],
      ['diff', 'Diff'],
      ['new', 'New'],
    ]) {
      const b = document.createElement('button');
      b.dataset.mode = mode;
      b.textContent = label;
      b.style.cssText =
        'border:none;background:transparent;padding:6px 12px;cursor:pointer;' +
        'font:600 12px/1 -apple-system,"Segoe UI",sans-serif;color:#001E35;';
      b.addEventListener('click', () => setView(mode));
      viewBarEl.appendChild(b);
    }
    panelEl.append(listEl, viewBarEl, chipEl);
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
    const past = sections.filter((s) => normUrl(s.url) !== normUrl(currentUrl) && s.edits.length > 0);
    const total = entries.length + carried.length + past.reduce((n, s) => n + s.edits.length, 0);
    chipEl.textContent = `✏️ ${total} edit${total === 1 ? '' : 's'}`;
    viewBarEl.style.display = entries.length ? 'flex' : 'none';
    for (const b of viewBarEl.children) {
      const on = b.dataset.mode === viewMode;
      b.style.background = on ? '#001E35' : 'transparent';
      b.style.color = on ? '#fff' : '#001E35';
    }
    listEl.style.display = panelOpen && total ? 'block' : 'none';
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
    }
    if (entries.length || carried.length) {
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
    }
  };

  const removePanel = () => {
    panelEl?.remove();
    panelEl = chipEl = listEl = viewBarEl = null;
    panelOpen = false;
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
    clearInterval(urlWatch);
    document.removeEventListener('beforeinput', onBeforeInput, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
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
    reapplyTimers.forEach(clearTimeout);
    reapplyTimers = [];
    carried = [];
    tracked = new Map();
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'finalize') {
      // Don't checkUrlChange() here: its fire-and-forget sync could race the
      // background's section read. `tracked` always belongs to `currentUrl`,
      // so responding with it directly is both safe and correct.
      setView('new'); // leave the page in its edited state, not a view
      updateAfters();
      sendResponse({ url: currentUrl, edits: snapshot() });
      disable();
    }
  });

  window.__slopOffEnable = enable;
  enable();
})();
