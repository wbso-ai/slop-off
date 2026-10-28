// In-page stand-in for the chrome.* APIs the extension uses, so the same
// background.js, panes.js and content.js run in a browser without extension
// support (e.g. an agent's embedded browser pane). The bridge serves it as
// GET /inject.js, wrapped around those files; see mcp/server.js. The page
// plays a single tab (id 1); session storage is sessionStorage, so edit mode
// and edits survive a reload once the bundle is injected again.
// eslint-disable-next-line no-unused-vars
function boot(background, page, base) {
  const tab = () => ({ id: 1, url: location.href });

  const area = (store, name) => {
    const prefix = `slopoff:${name}:`;
    const read = (k) => {
      const v = store.getItem(prefix + k);
      return v === null ? undefined : JSON.parse(v);
    };
    const get = (keys) => {
      const out = {};
      if (keys == null) {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k.startsWith(prefix)) out[k.slice(prefix.length)] = JSON.parse(store.getItem(k));
        }
        return out;
      }
      const defaults =
        typeof keys === 'string'
          ? { [keys]: undefined }
          : Array.isArray(keys)
            ? Object.fromEntries(keys.map((k) => [k, undefined]))
            : keys;
      for (const [k, d] of Object.entries(defaults)) {
        const v = read(k);
        if (v !== undefined) out[k] = v;
        else if (d !== undefined) out[k] = d;
      }
      return out;
    };
    const set = (items) => {
      for (const [k, v] of Object.entries(items)) store.setItem(prefix + k, JSON.stringify(v));
    };
    const remove = (keys) => [].concat(keys).forEach((k) => store.removeItem(prefix + k));
    // Both chrome styles: callback, or a promise when no callback is given.
    const api = (fn) => (arg, cb) => {
      const result = Promise.resolve().then(() => fn(arg));
      if (!cb) return result;
      result.then(cb);
    };
    return { get: api(get), set: api(set), remove: api(remove) };
  };
  const storage = {
    local: area(localStorage, 'local'),
    sync: area(localStorage, 'sync'),
    session: area(sessionStorage, 'session'),
  };

  // background.js listens on runtime.onMessage; content.js too, but in Chrome
  // it only receives what tabs.sendMessage sends. Hence two listener lists.
  const bgListeners = [];
  const pageListeners = [];
  const dispatch = (listeners, msg) =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        if (!listeners.length) return reject(new Error('Receiving end does not exist.'));
        let isAsync = false;
        for (const l of listeners) if (l(msg, { tab: tab() }, resolve) === true) isAsync = true;
        if (!isAsync) resolve(undefined); // no-op when a listener already answered
      })
    );
  const send = (listeners, msg, cb) => {
    const result = dispatch(listeners, msg);
    if (!cb) return result;
    result.then(cb, () => cb(undefined));
  };

  let onClicked = null;
  const onUpdated = [];
  const noop = () => Promise.resolve();

  const chromeFor = (side) => ({
    storage,
    runtime: {
      lastError: undefined,
      getURL: (path) => `${base}/${path}`,
      sendMessage: (msg, cb) => send(bgListeners, msg, cb),
      onMessage: { addListener: (l) => (side === 'bg' ? bgListeners : pageListeners).push(l) },
    },
    tabs: {
      sendMessage: (_tabId, msg, cb) => send(pageListeners, msg, cb),
      query: async () => [tab()],
      create: noop, // ponytail: the options page isn't served; the ⚙ overlay covers it
      onUpdated: { addListener: (l) => onUpdated.push(l) },
      onRemoved: { addListener: noop },
    },
    action: {
      onClicked: { addListener: (l) => (onClicked = l) },
      setBadgeText: noop,
      setBadgeBackgroundColor: noop,
    },
    scripting: {
      executeScript: async ({ func, args = [], files }) => {
        if (files) {
          page(chromeFor('page'));
          return [{}];
        }
        return [{ result: func(...args) }];
      },
    },
  });

  background(chromeFor('bg'));

  // Like the extension's toolbar button and ⌘⇧E shortcut; agents can call it too.
  window.__slopOffToggle = () => onClicked?.(tab());
  addEventListener(
    'keydown',
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'e') return;
      e.preventDefault();
      window.__slopOffToggle();
    },
    true
  );

  // Edit mode was on before this (re)load: resume it, as the extension does.
  onUpdated.forEach((l) => l(1, { status: 'complete' }, tab()));
}
