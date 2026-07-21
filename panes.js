// Shared UI panes: one implementation for the in-page ⚙ overlay (injected
// before content.js) and the options page (plain <script>). No duplication:
// both surfaces call window.SlopOffPanes.
(() => {
  if (window.SlopOffPanes) return;

  const DEFAULT_PROMPT = [
    'Apply the edits below to the source file referenced by the url.',
    'For each Before/After pair: locate the Before HTML in the file and replace it with the After HTML.',
    'For each Element/Instruction pair: locate the element in the source and carry out the instruction on it.',
    'The selector line describes where the element lives in the rendered DOM, as a hint for finding it in the source.',
    'Keep everything else unchanged and preserve the original formatting and indentation.',
  ].join('\n');

  // Every toast also lands in the notification history, agent and internal
  // actions alike, so nothing that flashed by is lost.
  const logNotif = (message, kind = 'internal') => {
    // ponytail: don't resurrect the list you just cleared
    if (/^(Notifications cleared|Data cleared)/.test(message)) return;
    try {
      chrome.storage.local.get({ notifications: [] }, ({ notifications }) => {
        notifications.unshift({ ts: new Date().toISOString(), message, kind });
        chrome.storage.local.set({ notifications: notifications.slice(0, 50) });
      });
    } catch (e) {}
  };

  // Fallback toast for surfaces without their own (the options page).
  const toast = (text) => {
    logNotif(text);
    const t = document.createElement('div');
    t.setAttribute('data-slop-toast', '');
    t.textContent = text;
    // Stack upward from the bottom; the lowest 70px belong to the host page.
    let bottom = 78;
    for (const el of document.querySelectorAll('[data-slop-toast],[data-slop-stack]')) {
      bottom = Math.max(bottom, Math.round(innerHeight - el.getBoundingClientRect().top + 8));
    }
    t.style.cssText =
      `position:fixed;right:20px;bottom:${bottom}px;z-index:2147483647;background:#001E35;color:#fff;` +
      'border-left:4px solid #FBB734;border-radius:10px;padding:10px 16px;' +
      'font:600 13px/1.4 -apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,30,53,.35);';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  };

  const paneEmpty = (pane, text) => {
    pane.textContent = '';
    const p = document.createElement('div');
    p.style.cssText = 'color:#94A3B8;font-size:13px;padding:18px 4px;';
    p.textContent = text;
    pane.appendChild(p);
  };

  const rowBtn = (text, title, accent) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.style.cssText =
      `border:1px solid ${accent};color:${accent};background:#fff;border-radius:6px;cursor:pointer;` +
      'padding:3px 10px;font:600 11px/1 -apple-system,"Segoe UI",sans-serif;flex:none;';
    return b;
  };

  const expandPre = (text) => {
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText =
      'margin:0;padding:8px 10px;background:#F8FAFC;border-bottom:1px solid #EDF1F6;' +
      'max-height:150px;overflow:auto;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#475569;white-space:pre-wrap;word-break:break-word;';
    return pre;
  };

  // ── Shortcuts ────────────────────────────────────────────────────────
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const CMD = IS_MAC ? '⌘' : 'Ctrl';
  const CTRL = IS_MAC ? '⌃' : 'Ctrl';
  const MOUSE = new Set(['Click', 'Hover', 'Drag']);
  const HELP_SECTIONS = [
    ['Editing', [
      [['Click'], 'any text or element — then just type'],
      [[CMD, 'Click'], 'activate a button instead of editing it'],
      [['Alt', 'Click'], 'edit a collapsed disclosure label'],
    ]],
    ['Notes', [
      [[CTRL, 'Click'], 'attach a note (hold ' + CTRL + ' to aim)'],
      [[CTRL, '⇧', 'Click'], 'add / drop an element on the open note'],
      [['Tab'], 'next annotated element · ⇧ for previous'],
      [['Enter'], 'save the note · ⇧ Enter for a new line'],
    ]],
    ['Links & fields', [
      [['Hover'], 'reveal the URL / placeholder editor'],
      [[CMD, 'Click'], 'follow a link — the session continues'],
    ]],
    ['Session', [
      [[CMD, 'Enter'], 'send pending changes now'],
      [['Esc', 'Esc'], 'discard everything & end the session'],
      [['Esc'], 'close an open editor'],
    ]],
  ];

  const renderShortcuts = (pane) => {
    if (pane.childElementCount) return; // static content: build once
    const keycap = (k) =>
      MOUSE.has(k)
        ? `<span style="display:inline-flex;align-items:center;height:23px;padding:0 9px;border-radius:7px;` +
          `background:#EAF2FB;border:1px solid #CDE0F3;color:#195FA4;` +
          `font:600 11px/1 -apple-system,'Segoe UI',sans-serif;">${k.toLowerCase()}</span>`
        : `<kbd style="display:inline-flex;align-items:center;justify-content:center;min-width:23px;height:23px;` +
          `padding:0 6px;border-radius:7px;background:linear-gradient(180deg,#fff,#EEF2F7);` +
          `border:1px solid #CBD5E1;border-bottom-color:#AEBACB;box-shadow:0 1px 0 rgba(0,30,53,.05);` +
          `font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#001E35;">${k}</kbd>`;
    const rowsFor = (rows) =>
      rows
        .map(
          ([keys, desc], i) =>
            `<div style="display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px;` +
            `padding:9px 0;${i ? 'border-top:1px solid #EDF1F6;' : ''}">` +
            `<div style="color:#475569;font-size:12.5px;line-height:1.35;">${desc}</div>` +
            `<div style="display:flex;gap:5px;align-items:center;justify-self:end;">` +
            keys.map(keycap).join('') +
            `</div></div>`
        )
        .join('');
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:14px;';
    grid.innerHTML = HELP_SECTIONS.map(
      ([title, rows]) =>
        `<section style="background:#F8FAFC;border:1px solid #EDF1F6;border-radius:13px;padding:12px 16px 6px;">` +
        `<div style="font:700 11px/1 -apple-system,'Segoe UI',sans-serif;letter-spacing:.09em;` +
        `text-transform:uppercase;color:#195FA4;margin-bottom:2px;">${title}</div>` +
        `${rowsFor(rows)}</section>`
    ).join('');
    pane.appendChild(grid);
  };

  // ── Notifications ────────────────────────────────────────────────────
  const renderNotifications = (pane, opts = {}) => {
    const say = opts.toast || toast;
    const render = (notifications) => {
      if (!pane.isConnected) return;
      if (!notifications.length) {
        return paneEmpty(pane, 'No notifications yet — every toast (agent summaries and actions like sent/saved/cancelled) is kept here.');
      }
      pane.textContent = '';
      const clear = rowBtn('Clear all', 'Forget every notification', '#94A3B8');
      clear.style.margin = '0 0 8px';
      clear.addEventListener('click', () => {
        chrome.storage.local.set({ notifications: [] }, () => {
          say('Notifications cleared ✓');
          render([]);
        });
      });
      pane.appendChild(clear);
      for (const n of notifications) {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;gap:12px;align-items:baseline;padding:9px 4px;border-bottom:1px solid #EDF1F6;';
        const t = document.createElement('span');
        t.style.cssText = 'color:#94A3B8;font-size:11px;flex:none;';
        t.textContent = new Date(n.ts).toLocaleString();
        const m = document.createElement('span');
        // Agent summaries dark, internal actions (sent/saved/cancelled) dimmed.
        const internal = n.kind && n.kind !== 'agent';
        m.style.cssText =
          `font-size:12.5px;color:${internal ? '#64748B' : '#001E35'};white-space:pre-line;min-width:0;`;
        m.textContent = internal ? n.message : `🤖 ${n.message}`;
        row.append(t, m);
        pane.appendChild(row);
      }
    };
    if (!pane.childElementCount) render([]); // instant feedback while storage loads
    try {
      chrome.storage.local.get({ notifications: [] }, ({ notifications }) => render(notifications));
    } catch (e) {
      paneEmpty(pane, 'Could not load notifications — reload the page after updating the extension.');
    }
  };

  // ── History ──────────────────────────────────────────────────────────
  const histShown = new Set(); // timestamps with the report text expanded
  const renderHistory = (pane, opts = {}) => {
    const say = opts.toast || toast;
    const render = (history) => {
      if (!pane.isConnected) return;
      if (!history.length) return paneEmpty(pane, 'No reports yet — they appear here after you end an edit session.');
      pane.textContent = '';
      history.forEach((item, i) => {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;gap:8px;align-items:center;padding:8px 4px;border-bottom:1px solid #EDF1F6;font-size:12px;';
        const label = document.createElement('div');
        label.style.cssText =
          'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#001E35;cursor:pointer;' +
          (item.ignored ? 'opacity:.55;' : '');
        label.textContent =
          `${new Date(item.ts).toLocaleString()} · ${item.count} edit${item.count === 1 ? '' : 's'} · ` +
          (item.urls || []).map((u) => u.replace(/^https?:\/\//, '')).join(', ') +
          (item.ignored ? ' · discarded' : '');
        label.title = 'Show the report';
        label.addEventListener('click', () => {
          histShown.has(item.ts) ? histShown.delete(item.ts) : histShown.add(item.ts);
          render(history);
        });
        row.appendChild(label);
        if (opts.resend) {
          const re = rowBtn('Re-apply', 'Send this report to the agent again', '#195FA4');
          re.addEventListener('click', () =>
            opts.resend(item, (ok) => say(ok ? '⚡ Report re-sent to agent' : '⚠ Nothing sent — webhook unreachable'))
          );
          row.appendChild(re);
        }
        const cp = rowBtn('Copy', 'Copy the report text', '#195FA4');
        cp.addEventListener('click', () =>
          navigator.clipboard.writeText(item.report).then(
            () => say('Copied ✓'),
            () => say('⚠ Could not copy')
          )
        );
        const del = rowBtn('✕', 'Delete this report from the history', '#B91C1C');
        del.addEventListener('click', () => {
          history.splice(i, 1);
          chrome.storage.local.set({ history }, () => render(history));
        });
        row.append(cp, del);
        pane.appendChild(row);
        if (histShown.has(item.ts)) pane.appendChild(expandPre(item.report));
      });
    };
    if (!pane.childElementCount) render([]);
    try {
      chrome.storage.local.get({ history: [] }, ({ history }) => render(history));
    } catch (e) {
      paneEmpty(pane, 'Could not load history — reload the page after updating the extension.');
    }
  };

  // ── Settings ─────────────────────────────────────────────────────────
  const renderSettings = (pane, opts = {}) => {
    if (pane.childElementCount) return; // build once: don't clobber typing
    const say = opts.toast || toast;
    const mkLabel = (text) => {
      const l = document.createElement('div');
      l.style.cssText = 'font:700 12px/1 -apple-system,"Segoe UI",sans-serif;color:#0F2744;margin:14px 0 6px;';
      l.textContent = text;
      return l;
    };
    const promptTa = document.createElement('textarea');
    promptTa.style.cssText =
      'width:100%;box-sizing:border-box;min-height:130px;resize:vertical;padding:10px;border:1px solid #CBD5E1;' +
      'border-radius:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#001E35;';
    const webhookIn = document.createElement('input');
    webhookIn.type = 'url';
    webhookIn.placeholder = 'http://localhost:8931';
    webhookIn.style.cssText =
      'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #CBD5E1;border-radius:8px;' +
      'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#001E35;';
    const hint = document.createElement('div');
    hint.style.cssText = 'color:#94A3B8;font-size:12px;margin-top:6px;';
    hint.textContent = 'Reports are POSTed here for your agent; clear the field to disable sending.';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText =
      'background:#195FA4;color:#fff;border:none;border-radius:8px;padding:8px 18px;cursor:pointer;' +
      'font:700 12px/1 -apple-system,"Segoe UI",sans-serif;';
    const outlineBtn = (text, color) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.style.cssText =
        `background:#fff;color:${color};border:1px solid ${color};border-radius:8px;padding:8px 14px;cursor:pointer;` +
        'font:700 12px/1 -apple-system,"Segoe UI",sans-serif;';
      return b;
    };
    // Restore defaults: settings only (prompt, webhook, toggles).
    const resetBtn = outlineBtn('Restore defaults', '#195FA4');
    // Clear data: history + notifications + the bridge's queue. Not settings.
    const clearBtn = outlineBtn('Clear data', '#B91C1C');
    saveBtn.addEventListener('click', () => {
      chrome.storage.sync.set({ prompt: promptTa.value, webhookUrl: webhookIn.value.trim() }, () =>
        say('Settings saved ✓')
      );
    });
    resetBtn.addEventListener('click', () => {
      const defaults = { prompt: DEFAULT_PROMPT, webhookUrl: 'http://localhost:8931', instant: false };
      promptTa.value = defaults.prompt;
      webhookIn.value = defaults.webhookUrl;
      chrome.storage.sync.set(defaults, () => say('Defaults restored ✓'));
    });
    clearBtn.addEventListener('click', () => {
      if (!confirm('Clear all data? This drops the report history, notifications and the queue at the bridge. Settings stay.')) return;
      chrome.storage.local.set({ history: [], notifications: [] }, () => {
        try {
          chrome.runtime.sendMessage({ type: 'clearQueue' }, (ok) => {
            void chrome.runtime.lastError;
            say(ok ? 'Data cleared ✓' : 'Data cleared — bridge not reachable, queue may remain');
          });
        } catch (e) {
          say('Data cleared ✓');
        }
      });
    });
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:16px;';
    row.append(saveBtn, resetBtn, clearBtn);
    pane.append(mkLabel('Prompt prepended to every report'), promptTa, mkLabel('Webhook URL'), webhookIn, hint, row);
    try {
      chrome.storage.sync.get({ prompt: DEFAULT_PROMPT, webhookUrl: 'http://localhost:8931' }, (v) => {
        promptTa.value = v.prompt;
        webhookIn.value = v.webhookUrl;
      });
    } catch (e) {}
  };

  // ── Tab switcher: pill bar + one visible pane ────────────────────────
  const mountTabs = (barEl, paneHost, tabs, initial, onChange) => {
    const btns = new Map();
    const panes = new Map();
    barEl.style.cssText +=
      ';display:inline-flex;border:1px solid #CBD5E1;border-radius:999px;overflow:hidden;';
    let current = null;
    const setTab = (key) => {
      current = key;
      for (const [k, b] of btns) {
        const on = k === key;
        b.style.background = on ? '#001E35' : 'transparent';
        b.style.color = on ? '#fff' : '#001E35';
      }
      for (const [k, p] of panes) p.style.display = k === key ? 'block' : 'none';
      tabs.find((t) => t.key === key)?.fill(panes.get(key));
      if (onChange) onChange(key);
    };
    tabs.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.label;
      b.style.cssText =
        'border:none;background:transparent;padding:7px 15px;cursor:pointer;' +
        "font:600 12px/1 -apple-system,'Segoe UI',sans-serif;color:#001E35;" +
        (i ? 'border-left:1px solid #E2E8F0;' : '');
      b.addEventListener('click', () => setTab(t.key));
      barEl.appendChild(b);
      btns.set(t.key, b);
      const p = document.createElement('div');
      p.style.display = 'none';
      paneHost.appendChild(p);
      panes.set(t.key, p);
    });
    setTab(tabs.some((t) => t.key === initial) ? initial : tabs[0].key);
    return { setTab, getTab: () => current, refresh: () => setTab(current) };
  };

  window.SlopOffPanes = {
    DEFAULT_PROMPT,
    logNotif,
    toast,
    mountTabs,
    renderShortcuts,
    renderNotifications,
    renderHistory,
    renderSettings,
  };
})();
