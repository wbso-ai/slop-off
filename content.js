// Injected while edit mode is active. Re-injected after each full navigation
// by the background service worker; SPA navigations (pushState) are detected
// here. Collected edits are synced to the background so they survive page
// changes.
(() => {
  if (window.__editCaptureInjected) {
    window.__editCaptureEnable();
    return;
  }
  window.__editCaptureInjected = true;

  const newVisitId = () => `${Math.random().toString(36).slice(2)}-${Date.now()}`;

  let active = false;
  let visitId = newVisitId(); // one id per page visit, for upserts in the background
  let currentUrl = location.href;
  let tracked = new Map(); // element -> { selector, before, after }
  let syncTimer = null;
  let urlWatch = null;

  const isFormControl = (el) =>
    el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

  // outerHTML with the *current* value baked in for form controls, so value
  // changes show up in the report (the value attribute doesn't track typing).
  const htmlOf = (el) => {
    if (!isFormControl(el)) return el.outerHTML;
    const clone = el.cloneNode(true);
    if (el.tagName === 'TEXTAREA') {
      clone.textContent = el.value;
    } else if (el.tagName === 'SELECT') {
      const options = clone.querySelectorAll('option');
      options.forEach((opt, i) => {
        if (i === el.selectedIndex) opt.setAttribute('selected', '');
        else opt.removeAttribute('selected');
      });
    } else {
      clone.setAttribute('value', el.value);
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
    for (const [el, rec] of tracked) {
      if (el.isConnected) rec.after = htmlOf(el);
    }
  };

  const snapshot = () => {
    const edits = [];
    for (const [el, rec] of tracked) {
      const after = el.isConnected
        ? htmlOf(el)
        : rec.after != null
          ? rec.after
          : '(element removed)';
      if (after !== rec.before) {
        edits.push({ selector: rec.selector, before: rec.before, after });
      }
    }
    return edits;
  };

  const sync = () => {
    try {
      chrome.runtime.sendMessage({
        type: 'sync',
        visitId,
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
    sync();
    visitId = newVisitId();
    currentUrl = location.href;
    tracked = new Map();
  };

  const onBeforeInput = (e) => {
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

  const onInput = (e) => {
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

  const enable = () => {
    if (active) return;
    active = true;
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('popstate', checkUrlChange);
    urlWatch = setInterval(checkUrlChange, 400);
    document.designMode = 'on';
    showBorder();
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
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('popstate', checkUrlChange);
    document.designMode = 'off';
    hideBorder();
    tracked = new Map();
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'finalize') {
      // Don't checkUrlChange() here: its fire-and-forget sync could race the
      // background's section read. `tracked` always belongs to `currentUrl`,
      // so responding with it directly is both safe and correct.
      updateAfters();
      sendResponse({ visitId, url: currentUrl, edits: snapshot() });
      disable();
    }
  });

  window.__editCaptureEnable = enable;
  enable();
})();
