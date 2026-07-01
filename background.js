const DEFAULT_PROMPT = [
  'Apply the edits below to the source file referenced by the url.',
  'For each Before/After pair: locate the Before HTML in the file and replace it with the After HTML.',
  'The selector line describes where the element lives in the rendered DOM, as a hint for finding it in the source.',
  'Keep everything else unchanged and preserve the original formatting and indentation.',
].join('\n');

const activeKey = (tabId) => `active_${tabId}`;
const sectionsKey = (tabId) => `sections_${tabId}`;
const PENDING_KEY = 'pending_report';

async function isActive(tabId) {
  const data = await chrome.storage.session.get(activeKey(tabId));
  return Boolean(data[activeKey(tabId)]);
}

async function getSections(tabId) {
  const data = await chrome.storage.session.get(sectionsKey(tabId));
  return data[sectionsKey(tabId)] || [];
}

// Insert or replace the edits for one page visit.
function upsertSection(sections, { visitId, url, edits }) {
  const i = sections.findIndex((s) => s.visitId === visitId);
  if (i >= 0) sections[i] = { visitId, url, edits };
  else sections.push({ visitId, url, edits });
}

function buildReport(promptPrefix, sections, fallbackUrl) {
  const parts = [];
  if (promptPrefix && promptPrefix.trim()) {
    parts.push(promptPrefix.trim(), '');
  }

  const withEdits = sections.filter((s) => s.edits.length > 0);
  if (withEdits.length === 0) {
    parts.push('---', '', `url: ${fallbackUrl}`, '', '(no changes detected)');
  }
  for (const section of withEdits) {
    parts.push('---', '', `url: ${section.url}`);
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
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}

// Runs in the page: copy the report to the clipboard and show a toast.
function copyReportAndToast(report, message) {
  const showToast = (text) => {
    const toast = document.createElement('div');
    toast.textContent = text;
    Object.assign(toast.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
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
  };

  const copyViaTextarea = () => {
    const ta = document.createElement('textarea');
    ta.value = report;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  };

  return navigator.clipboard
    .writeText(report)
    .then(() => true)
    .catch(() => copyViaTextarea())
    .then((ok) => {
      if (ok) showToast(message);
      return ok;
    });
}

async function copyInTab(tabId, report, message) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: copyReportAndToast,
      args: [report, message],
    });
    return Boolean(result);
  } catch (e) {
    return false;
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
    // A report that couldn't be copied earlier (e.g. edit mode was ended on
    // a chrome:// page) takes priority: copy it now instead of starting a
    // new edit session.
    const { [PENDING_KEY]: pending } = await chrome.storage.session.get(PENDING_KEY);
    if (pending) {
      const copied = await copyInTab(
        tabId,
        pending.report,
        `Saved report copied — ${pending.count} edit${pending.count === 1 ? '' : 's'}`
      );
      if (copied) {
        await chrome.storage.session.remove(PENDING_KEY);
        flashBadge(tabId, `${pending.count}`, '#195FA4');
      } else {
        flashBadge(tabId, '✗', '#C2410C');
      }
      return;
    }

    // ── Edit mode ON ───────────────────────────────────────────────
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
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

  // ── Edit mode OFF: collect, build report, copy ───────────────────
  let finalPage = null;
  try {
    finalPage = await chrome.tabs.sendMessage(tabId, { type: 'finalize' });
  } catch (e) {
    // No content script on the current page (injection failed there).
  }

  const sections = await getSections(tabId);
  if (finalPage) upsertSection(sections, finalPage);

  await chrome.storage.session.remove([activeKey(tabId), sectionsKey(tabId)]);

  const { prompt } = await chrome.storage.sync.get({ prompt: DEFAULT_PROMPT });
  const report = buildReport(prompt, sections, tab.url || '');
  const editCount = sections.reduce((n, s) => n + s.edits.length, 0);

  const copied = await copyInTab(
    tabId,
    report,
    `Report copied — ${editCount} edit${editCount === 1 ? '' : 's'}`
  );

  if (copied) {
    flashBadge(tabId, `${editCount}`, '#195FA4');
  } else {
    // Keep the report; the next icon click copies it from any normal page.
    await chrome.storage.session.set({ [PENDING_KEY]: { report, count: editCount } });
    flashBadge(tabId, '💾', '#C2410C');
  }
});

// Keep edit mode alive across navigations and reloads: re-inject the content
// script whenever an active tab finishes loading a page.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  if (!(await isActive(tabId))) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await setBadge(tabId, 'REC', '#DC2626');
  } catch (e) {
    // Landed on a page that disallows injection; edits so far are kept.
  }
});

// Receive (debounced) edit snapshots from the content script.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'sync' || !sender.tab?.id) return;
  const tabId = sender.tab.id;
  (async () => {
    if (!(await isActive(tabId))) return;
    const sections = await getSections(tabId);
    upsertSection(sections, msg);
    await chrome.storage.session.set({ [sectionsKey(tabId)]: sections });
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([activeKey(tabId), sectionsKey(tabId)]);
});
