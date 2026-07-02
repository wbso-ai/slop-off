const DEFAULT_PROMPT = [
  'Apply the edits below to the source file referenced by the url.',
  'For each Before/After pair: locate the Before HTML in the file and replace it with the After HTML.',
  'The selector line describes where the element lives in the rendered DOM, as a hint for finding it in the source.',
  'Keep everything else unchanged and preserve the original formatting and indentation.',
].join('\n');

const promptEl = document.getElementById('prompt');
const webhookEl = document.getElementById('webhook');
const statusEl = document.getElementById('status');

function flash(message) {
  statusEl.textContent = message;
  setTimeout(() => (statusEl.textContent = ''), 2000);
}

chrome.storage.sync.get({ prompt: DEFAULT_PROMPT, webhookUrl: 'http://localhost:8931' }, ({ prompt, webhookUrl }) => {
  promptEl.value = prompt;
  webhookEl.value = webhookUrl;
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.sync.set({ prompt: promptEl.value, webhookUrl: webhookEl.value.trim() }, () =>
    flash('Saved ✓')
  );
});

document.getElementById('reset').addEventListener('click', () => {
  promptEl.value = DEFAULT_PROMPT;
  chrome.storage.sync.set({ prompt: DEFAULT_PROMPT }, () => flash('Reset ✓'));
});

// ── Report history ──────────────────────────────────────────────────
const historyEl = document.getElementById('history');
const historyStatusEl = document.getElementById('historyStatus');
let history = [];

function flashHistory(message) {
  historyStatusEl.textContent = message;
  historyStatusEl.style.cssText = 'color:#0E8A66;font-size:13px;font-weight:600;';
  setTimeout(() => (historyStatusEl.textContent = ''), 2000);
}

// The report body: everything from the first '---' section marker on,
// i.e. the report without its prompt prefix.
const reportBody = (report) => {
  const i = report.indexOf('---');
  return i >= 0 ? report.slice(i) : report;
};

function renderHistory() {
  historyEl.textContent = '';
  if (!history.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No reports yet — they appear here after you copy one.';
    historyEl.appendChild(p);
    return;
  }
  history.forEach((item, i) => {
    const entry = document.createElement('div');
    entry.className = 'entry';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.index = i;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${new Date(item.ts).toLocaleString()} — ${item.count} edit${
      item.count === 1 ? '' : 's'
    } — ${item.urls?.[0] || ''}${item.urls?.length > 1 ? ` (+${item.urls.length - 1})` : ''}`;
    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () =>
      navigator.clipboard.writeText(item.report).then(() => flashHistory('Copied ✓'))
    );
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'secondary';
    delBtn.addEventListener('click', () => {
      history.splice(i, 1);
      chrome.storage.local.set({ history }, renderHistory);
    });
    actions.append(copyBtn, delBtn);
    const pre = document.createElement('pre');
    pre.textContent = item.report;
    details.append(summary, actions, pre);
    entry.append(cb, details);
    historyEl.appendChild(entry);
  });
}

chrome.storage.local.get({ history: [] }, (data) => {
  history = data.history;
  renderHistory();
});

// Live refresh: reports copied while this tab is open appear immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.history) {
    history = changes.history.newValue || [];
    renderHistory();
  }
});

document.getElementById('copyCombined').addEventListener('click', () => {
  const selected = [...historyEl.querySelectorAll('input:checked')].map((cb) => history[cb.dataset.index]);
  if (!selected.length) return flashHistory('Tick reports to combine first');
  // Oldest first, prompt once, then each report's sections.
  const bodies = selected.reverse().map((item) => reportBody(item.report).trimEnd());
  chrome.storage.sync.get({ prompt: DEFAULT_PROMPT }, ({ prompt }) => {
    const combined = (prompt.trim() ? prompt.trim() + '\n\n' : '') + bodies.join('\n\n') + '\n';
    navigator.clipboard.writeText(combined).then(() => flashHistory(`Combined ${selected.length} reports ✓`));
  });
});

document.getElementById('clearHistory').addEventListener('click', () => {
  history = [];
  chrome.storage.local.set({ history }, () => {
    renderHistory();
    flashHistory('History cleared ✓');
  });
});
