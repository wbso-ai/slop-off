const DEFAULT_PROMPT = [
  'Apply the edits below to the source file referenced by the url.',
  'For each Before/After pair: locate the Before HTML in the file and replace it with the After HTML.',
  'For each Element/Instruction pair: locate the element in the source and carry out the instruction on it.',
  'The selector line describes where the element lives in the rendered DOM, as a hint for finding it in the source.',
  'Keep everything else unchanged and preserve the original formatting and indentation.',
].join('\n');

const activeKey = (tabId) => `active_${tabId}`;
const sectionsKey = (tabId) => `sections_${tabId}`;
const HISTORY_KEY = 'history';
const HISTORY_MAX = 20;

async function saveHistory(report, count, sections, ignored = false) {
  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
  history.unshift({
    ts: Date.now(),
    count,
    urls: [...new Set(sections.map((s) => s.url))],
    report,
    ignored,
  });
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, HISTORY_MAX) });
}

async function isActive(tabId) {
  const data = await chrome.storage.session.get(activeKey(tabId));
  return Boolean(data[activeKey(tabId)]);
}

async function getSections(tabId) {
  const data = await chrome.storage.session.get(sectionsKey(tabId));
  return data[sectionsKey(tabId)] || [];
}

// Sections are keyed by URL (hash ignored): one section per page, always.
const normUrl = (u) => (u || '').split('#')[0];

// Insert or replace the edits + notes for one page.
function upsertSection(sections, { url, edits, notes, env }) {
  const i = sections.findIndex((s) => normUrl(s.url) === normUrl(url));
  if (i >= 0) sections[i] = { url: sections[i].url, edits, notes: notes || [], env };
  else sections.push({ url, edits, notes: notes || [], env });
}

const sectionSize = (s) => s.edits.length + (s.notes?.length || 0);

function buildReport(promptPrefix, sections, fallbackUrl) {
  const parts = [];
  if (promptPrefix && promptPrefix.trim()) {
    parts.push(promptPrefix.trim(), '');
  }

  const withContent = sections.filter((s) => sectionSize(s) > 0);
  if (withContent.length === 0) {
    parts.push('---', '', `url: ${fallbackUrl}`, '', '(no changes detected)');
  }
  for (const section of withContent) {
    parts.push('---', '', `url: ${section.url}`);
    if (section.env) parts.push(`viewed on: ${section.env}`);
    for (const { selector, before, after } of section.edits) {
      parts.push('');
      if (selector) parts.push(`selector: ${selector}`, '');
      parts.push(
        'Before:',
        '',
        '```',
        before,
        '```',
        '',
        'After:',
        '',
        '```',
        after,
        '```'
      );
    }
    for (const note of section.notes || []) {
      parts.push('');
      if (note.selector) parts.push(`selector: ${note.selector}`, '');
      parts.push('Element:', '', '```', note.html || '(see selector)', '```', '', `Instruction: ${note.prompt}`);
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

// Runs in the page: show a status toast (gold accent).
function showStatusToast(message) {
  const toast = document.createElement('div');
  toast.setAttribute('data-slop-toast', '');
  toast.textContent = message;
  // Stack upward from the bottom; the lowest 70px belong to the host page.
  let bottom = 78;
  for (const el of document.querySelectorAll('[data-slop-toast],[data-slop-stack]')) {
    bottom = Math.max(bottom, Math.round(innerHeight - el.getBoundingClientRect().top + 8));
  }
  Object.assign(toast.style, {
    position: 'fixed',
    right: '20px',
    bottom: `${bottom}px`,
    zIndex: '2147483647',
    background: '#001E35',
    color: '#fff',
    borderLeft: '4px solid #FBB734',
    borderRadius: '10px',
    padding: '12px 18px',
    font: '600 14px/1.4 "Open Sans", -apple-system, "Segoe UI", sans-serif',
    boxShadow: '0 6px 24px rgba(0, 30, 53, 0.35)',
    opacity: '0',
    transition: 'opacity 0.25s',
  });
  document.documentElement.appendChild(toast);
  requestAnimationFrame(() => (toast.style.opacity = '1'));
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Every toast lands in the notification history too (agent and internal).
async function logNotification(message, kind = 'internal') {
  const { notifications = [] } = await chrome.storage.local.get('notifications');
  notifications.unshift({ ts: new Date().toISOString(), message, kind });
  await chrome.storage.local.set({ notifications: notifications.slice(0, 50) });
}

async function toastIn(tabId, message) {
  await logNotification(message);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showStatusToast,
      args: [message],
    });
    return true;
  } catch (e) {
    return false; // page disallows injection; the badge still signals
  }
}

async function setBadge(tabId, text, color) {
  if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
}

function flashBadge(tabId, text, color) {
  setBadge(tabId, text, color);
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const tabId = tab.id;

  if (!(await isActive(tabId))) {
    // ── Edit mode ON ───────────────────────────────────────────────
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['panes.js', 'content.js'] });
    } catch (e) {
      // Pages that disallow injection (chrome://, web store, etc.)
      flashBadge(tabId, '✗', '#C2410C');
      return;
    }
    await chrome.storage.session.set({
      [activeKey(tabId)]: true,
      [sectionsKey(tabId)]: [],
    });
    await setBadge(tabId, 'REC', '#DC2626');
    return;
  }

  // ── Edit mode OFF: collect, build report, send to the agent ──────
  let finalPage = null;
  try {
    finalPage = await chrome.tabs.sendMessage(tabId, { type: 'finalize' });
  } catch (e) {
    // No content script on the current page (injection failed there).
  }

  const sections = await getSections(tabId);
  if (finalPage) upsertSection(sections, finalPage);

  await chrome.storage.session.remove([activeKey(tabId), sectionsKey(tabId)]);

  const withContent = sections.filter((s) => sectionSize(s) > 0);
  await finalizeReport(tabId, withContent, tab.url || '');
});

// ── Two-way status: poll the bridge after a report is sent ───────────
// Shows the number of pending reports on the (global) action badge and
// injects a toast when the agent calls notify_browser. Per-tab badges
// (REC, flashes) override the global pending count, which is what we want.
const POLL_KEY = 'poll_state'; // { until, lastEventId, tabId }
const POLL_WINDOW_MS = 15 * 60 * 1000;
let pollTimer = 0;

// Runs in the page: agent status toast (green accent, replaces the previous).
// Clicking it opens the settings page with the notification history.
function showAgentToast(message) {
  const toast = document.createElement('div');
  toast.setAttribute('data-slop-toast', '');
  toast.textContent = `🤖 ${message}`;
  toast.title = 'Click to see all agent notifications';
  toast.style.cursor = 'pointer';
  toast.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'openNotifications' });
    } catch (e) {}
    toast.remove();
  });
  // Stack upward from the bottom; the lowest 70px belong to the host page.
  let bottom = 78;
  for (const el of document.querySelectorAll('[data-slop-toast],[data-slop-stack]')) {
    bottom = Math.max(bottom, Math.round(innerHeight - el.getBoundingClientRect().top + 8));
  }
  Object.assign(toast.style, {
    position: 'fixed',
    right: '20px',
    bottom: `${bottom}px`,
    zIndex: '2147483647',
    maxWidth: '360px',
    background: '#001E35',
    color: '#fff',
    borderLeft: '4px solid #16A37B',
    borderRadius: '10px',
    padding: '12px 18px',
    font: '600 13px/1.4 "Open Sans", -apple-system, "Segoe UI", sans-serif',
    whiteSpace: 'pre-line',
    boxShadow: '0 6px 24px rgba(0, 30, 53, 0.35)',
    opacity: '0',
    transition: 'opacity 0.25s',
  });
  document.documentElement.appendChild(toast);
  requestAnimationFrame(() => (toast.style.opacity = '1'));
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

async function toastInTab(tabId, message) {
  const tryTab = async (id) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: showAgentToast,
        args: [message],
      });
      return true;
    } catch (e) {
      return false; // tab gone or uninjectable
    }
  };
  if (tabId && (await tryTab(tabId))) return;
  // Fall back to whatever tab the user is looking at.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.id !== tabId) await tryTab(tab.id);
}

async function fetchStatus() {
  const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: 'http://localhost:8931' });
  const url = webhookUrl.trim();
  if (!url) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(url.replace(/\/$/, '') + '/status', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json(); // { pending, events }
  } catch (e) {
    return null; // old bridge (non-JSON) or unreachable
  }
}

async function pollStatus() {
  const { [POLL_KEY]: st } = await chrome.storage.session.get(POLL_KEY);
  if (!st || Date.now() > st.until) {
    clearInterval(pollTimer);
    pollTimer = 0;
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const status = await fetchStatus();
  if (!status) return;
  await chrome.action.setBadgeBackgroundColor({ color: '#B45309' });
  await chrome.action.setBadgeText({ text: status.pending ? String(status.pending) : '' });
  // Guard against empty events from older bridges: nothing to show or log.
  const fresh = (status.events || []).filter(
    (ev) => ev.id > (st.lastEventId || 0) && ev.message && ev.message.trim()
  );
  if (fresh.length || status.pending) {
    st.until = Date.now() + POLL_WINDOW_MS; // activity keeps the poll alive
    if (fresh.length) st.lastEventId = fresh[fresh.length - 1].id;
    await chrome.storage.session.set({ [POLL_KEY]: st });
  }
  if (fresh.length) {
    // Keep a readable history (newest first, last 50).
    const { notifications = [] } = await chrome.storage.local.get('notifications');
    notifications.unshift(
      ...fresh.map((ev) => ({ ts: ev.ts, message: ev.message, kind: 'agent' })).reverse()
    );
    await chrome.storage.local.set({ notifications: notifications.slice(0, 50) });
  }
  for (const ev of fresh) await toastInTab(st.tabId, ev.message);
}

async function startPolling(tabId) {
  const { [POLL_KEY]: st } = await chrome.storage.session.get(POLL_KEY);
  await chrome.storage.session.set({
    [POLL_KEY]: {
      until: Date.now() + POLL_WINDOW_MS,
      // Baseline now: never toast events from before this session's report.
      lastEventId: st?.lastEventId || Date.now(),
      tabId: tabId ?? st?.tabId,
    },
  });
  if (!pollTimer) pollTimer = setInterval(pollStatus, 1000);
  pollStatus();
}

// Worker restarted mid-window (MV3): resume the poll.
chrome.storage.session.get(POLL_KEY).then(({ [POLL_KEY]: st }) => {
  if (st && Date.now() < st.until && !pollTimer) pollTimer = setInterval(pollStatus, 1000);
});

// POST the report to the configured webhook (e.g. the MCP bridge).
// Returns null when no webhook is configured, else whether it succeeded.
async function postWebhook(report, count, sections) {
  const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: 'http://localhost:8931' });
  if (!webhookUrl.trim()) return null;
  try {
    const res = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report, count, urls: [...new Set(sections.map((s) => s.url))] }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Build the final report, save it to history, send it to the agent.
// No clipboard: the webhook is the delivery channel; history is the backup.
async function finalizeReport(tabId, sections, fallbackUrl) {
  const { prompt } = await chrome.storage.sync.get({ prompt: DEFAULT_PROMPT });
  const report = buildReport(prompt, sections, fallbackUrl);
  const count = sections.reduce((n, s) => n + sectionSize(s), 0);
  if (!count) {
    await toastIn(tabId, 'No changes — nothing sent');
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  await saveHistory(report, count, sections);
  const sent = await postWebhook(report, count, sections);
  if (sent === true) {
    await startPolling(tabId);
    await toastIn(tabId, `Sent to agent — ${count} edit${count === 1 ? '' : 's'}`);
    flashBadge(tabId, `${count}`, '#195FA4');
  } else {
    await toastIn(
      tabId,
      sent === null
        ? '⚠ No webhook configured — report kept in history'
        : '⚠ Agent bridge unreachable — report kept in history'
    );
    flashBadge(tabId, '✗', '#C2410C');
  }
}

// Keep edit mode alive across navigations and reloads: re-inject the content
// script whenever an active tab finishes loading a page.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  if (!(await isActive(tabId))) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['panes.js', 'content.js'] });
    await setBadge(tabId, 'REC', '#DC2626');
  } catch (e) {
    // Landed on a page that disallows injection; edits so far are kept.
  }
});

// Receive (debounced) edit snapshots from the content script, and the
// confirm/cancel answers from the preview panel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'clearQueue') {
    // "Clear data": also drop the bridge's queue + events. Callable from the
    // overlay and the options page (which has no tab), hence above the guard.
    (async () => {
      const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: 'http://localhost:8931' });
      const url = webhookUrl.trim();
      if (!url) return sendResponse(true); // nothing bridge-side to clear
      try {
        const res = await fetch(url.replace(/\/$/, '') + '/clear', { method: 'POST' });
        chrome.action.setBadgeText({ text: '' });
        sendResponse(res.ok);
      } catch (e) {
        sendResponse(false);
      }
    })();
    return true;
  }

  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (msg.type === 'getSections') {
    // The in-page edits panel shows past pages' edits too.
    getSections(tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'flushInstant') {
    // ⚡ Instant mode: ship everything pending to the webhook right now.
    // On success the session's sections are cleared (the content script
    // resets its baselines); on failure everything simply stays batched.
    (async () => {
      if (!(await isActive(tabId))) return sendResponse(false);
      const sections = await getSections(tabId);
      upsertSection(sections, msg);
      const withContent = sections.filter((s) => sectionSize(s) > 0);
      if (!withContent.length) return sendResponse(false);
      const { prompt } = await chrome.storage.sync.get({ prompt: DEFAULT_PROMPT });
      const report = buildReport(prompt, withContent, msg.url);
      const count = withContent.reduce((n, s) => n + sectionSize(s), 0);
      const sent = await postWebhook(report, count, withContent);
      if (!sent) return sendResponse(false);
      await startPolling(tabId);
      await saveHistory(report, count, withContent);
      await chrome.storage.session.set({ [sectionsKey(tabId)]: [] });
      await setBadge(tabId, `${count}`, '#195FA4');
      setTimeout(() => setBadge(tabId, 'REC', '#DC2626'), 1500);
      sendResponse(true);
    })();
    return true;
  }

  if (msg.type === 'discard') {
    // User threw the whole session away (✕ / double-Esc): nothing is copied
    // or sent, but the report is kept in history marked as ignored.
    (async () => {
      const sections = await getSections(tabId);
      await chrome.storage.session.remove([activeKey(tabId), sectionsKey(tabId)]);
      chrome.action.setBadgeText({ tabId, text: '' });
      const withContent = sections.filter((s) => sectionSize(s) > 0);
      if (!withContent.length) return;
      const { prompt } = await chrome.storage.sync.get({ prompt: DEFAULT_PROMPT });
      const report = buildReport(prompt, withContent, sender.tab?.url || '');
      const count = withContent.reduce((n, s) => n + sectionSize(s), 0);
      await saveHistory(report, count, withContent, true);
    })();
    return;
  }

  if (msg.type === 'removeEdit') {
    // ✕ in the panel on another page's edit.
    (async () => {
      const sections = await getSections(tabId);
      for (const s of sections) {
        if (normUrl(s.url) !== normUrl(msg.url)) continue;
        if (msg.noteMode) {
          s.notes = (s.notes || []).filter(
            (n) => !(n.selector === msg.selector && n.prompt === msg.prompt)
          );
        } else {
          s.edits = s.edits.filter((e) => !(e.selector === msg.selector && e.before === msg.before));
        }
      }
      const kept = sections.filter((s) => sectionSize(s) > 0);
      await chrome.storage.session.set({ [sectionsKey(tabId)]: kept });
      sendResponse(true);
    })();
    return true;
  }

  if (msg.type === 'sync') {
    (async () => {
      if (!(await isActive(tabId))) return;
      const sections = await getSections(tabId);
      upsertSection(sections, msg);
      await chrome.storage.session.set({ [sectionsKey(tabId)]: sections });
    })();
  }

  if (msg.type === 'openNotifications') {
    // Clicked toast: open the in-page overlay if an edit session is active
    // in that tab; otherwise fall back to the settings page, on the
    // notifications tab (#notes).
    chrome.tabs.sendMessage(tabId, { type: 'showNotifications' }, (ok) => {
      if (chrome.runtime.lastError || !ok)
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html#notes') });
    });
    return;
  }

  if (msg.type === 'resendReport') {
    // Re-apply from the history pane: POST the stored report again.
    (async () => {
      const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: 'http://localhost:8931' });
      const url = webhookUrl.trim();
      if (!url) return sendResponse(false);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            report: msg.report,
            count: msg.count,
            urls: msg.urls || [],
          }),
        });
        if (res.ok) await startPolling(tabId);
        sendResponse(res.ok);
      } catch (e) {
        sendResponse(false);
      }
    })();
    return true;
  }

  if (msg.type === 'cancelReport') {
    // ✕ on a pending report in the HUD: tell the bridge to drop it.
    (async () => {
      const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: 'http://localhost:8931' });
      const url = webhookUrl.trim();
      if (!url) return sendResponse(false);
      try {
        const res = await fetch(url.replace(/\/$/, '') + '/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: msg.id }),
        });
        sendResponse(res.ok);
      } catch (e) {
        sendResponse(false);
      }
    })();
    return true;
  }

  if (msg.type === 'checkBridge') {
    // Liveness ping for the HUD's status lamp and pending pill: /status
    // returns JSON on the current bridge; any 200 means the server runs.
    (async () => {
      const { webhookUrl } = await chrome.storage.sync.get({ webhookUrl: 'http://localhost:8931' });
      const url = webhookUrl.trim();
      if (!url) return sendResponse({ configured: false, ok: false, pending: 0 });
      const status = await fetchStatus();
      if (status)
        return sendResponse({
          configured: true,
          ok: true,
          waiting: Boolean(status.waiting),
          processing: Boolean(status.processing),
          pending: status.pending || 0,
          reports: status.reports || [],
        });
      // Older bridge without /status: fall back to the plain-text GET.
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 2000);
        const res = await fetch(url, { method: 'GET', signal: ctl.signal });
        clearTimeout(timer);
        sendResponse({ configured: true, ok: res.ok, pending: 0 });
      } catch (e) {
        sendResponse({ configured: true, ok: false, pending: 0 });
      }
    })();
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([activeKey(tabId), sectionsKey(tabId)]);
});
