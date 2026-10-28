#!/usr/bin/env node
// Slop Off MCP server: receives reports from the extension over HTTP
// and serves them to a coding agent over MCP (stdio). No dependencies.
//
// Register with:  claude mcp add --scope user slop-off -- npx -y slop-off
//        or:      claude mcp add slop-off -- node /path/to/mcp/server.js
// Extension:      set the webhook URL to http://localhost:8931 in the options.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.SLOP_OFF_PORT || 8931);
const DIR = path.join(os.homedir(), '.slop-off');
const QUEUE_FILE = path.join(DIR, 'queue.json');

// ── Hot reload (see bottom): a previous incarnation cleans up first ──
// A Claude session keeps this process alive for its whole lifetime, so after
// a code update the running server would be stale until a manual /mcp
// reconnect. Instead we watch our own file and re-require it in place: same
// process, same stdio pipes — the MCP connection never notices.
if (global.__slopOffCleanup) {
  try {
    global.__slopOffCleanup();
  } catch (e) {}
}

fs.mkdirSync(DIR, { recursive: true });

// ── Queue (persisted) ────────────────────────────────────────────────
// [{ id, ts, count, urls, report, consumed }]
// ponytail: file is the source of truth so several server instances (one per
// Claude session; only one wins the HTTP port) stay in sync via re-reads.
let queue = [];

const loadQueue = () => {
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch (e) {}
};
loadQueue();

const saveQueue = () => {
  queue = queue.slice(-50);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
};

// ── Events for the browser (persisted): [{ id, ts, message }] ────────
// notify_browser pushes; the extension polls GET /status and toasts new ones.
const EVENTS_FILE = path.join(DIR, 'events.json');
let events = [];
const loadEvents = () => {
  try {
    events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  } catch (e) {}
};
loadEvents();
const saveEvents = () => {
  events = events.slice(-20);
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
};

// ── Waiting heartbeat: is any agent blocked in wait_for_report? ──────
// The extension shows this as the status dot: "bridge up" is not the same
// as "an agent is actually waiting for your edits".
// ponytail: last-writer-wins single file across sessions; fine for a dot.
const WAIT_FILE = path.join(DIR, 'waiting.json');
const setWaiting = (ms) => {
  try {
    fs.writeFileSync(WAIT_FILE, JSON.stringify({ until: Date.now() + ms }));
  } catch (e) {}
};
const isWaiting = () => {
  try {
    return JSON.parse(fs.readFileSync(WAIT_FILE, 'utf8')).until > Date.now();
  } catch (e) {
    return false;
  }
};

// Several sessions share one queue, each loop serving its own app. A loop
// that passes `origin` only takes that app's reports. One without it takes
// anything, but only once a report is GRACE_MS old, so a session waiting
// for that origin (here or in another instance) always gets it first.
const GRACE_MS = 3000;
const hostOf = (s) => {
  try {
    return new URL(String(s).includes('://') ? s : `http://${s}`).host;
  } catch (e) {
    return String(s);
  }
};
const matcherFor = (origin) => {
  if (!origin) return (r) => Date.now() - Date.parse(r.ts) >= GRACE_MS;
  const host = hostOf(origin);
  return (r) => (r.urls || []).some((u) => hostOf(u) === host);
};

let waiters = []; // pending wait_for_report resolvers: { match, filtered, take }
// Aborted wait_for_report calls (user pressed stop/Esc): finish the wait
// right away so the waiting flag clears in seconds, not after the timeout.
const cancels = new Map(); // request id -> abort fn
const cancelledIds = new Set(); // ids we must not reply to

// Lifecycle: queued (fresh) → applying (consumed, done:false) → done.
// Done is signalled by notify_browser, and inferred whenever the agent picks
// up the next report or goes back to waiting — the /slop-off loop is serial,
// so either one means the previous report is finished. That way a loop that
// forgets notify_browser can't leave reports stuck on "applying".
// ponytail: 5 min TTL — an "applying" report older than that means the agent
// stopped mid-way; never show it as busy forever. Raise if long applies
// get cut short cosmetically.
const IN_FLIGHT_TTL = 5 * 60 * 1000;
const inFlight = () => {
  let healed = false;
  for (const r of queue) {
    if (r.consumed && r.done === false && (!r.pickedAt || Date.now() - r.pickedAt > IN_FLIGHT_TTL)) {
      r.done = true;
      healed = true;
    }
  }
  if (healed) saveQueue();
  return queue.filter((r) => r.consumed && r.done === false);
};
const completeInFlight = () => {
  const busy = inFlight();
  busy.forEach((r) => (r.done = true));
  if (busy.length) saveQueue();
};
const consume = (r) => {
  completeInFlight(); // ponytail: assumes one serial loop; fine for localhost
  r.consumed = true;
  r.done = false;
  r.pickedAt = Date.now();
  saveQueue();
};

const pushReport = (entry) => {
  const report = {
    id: `${Date.now()}-${queue.length}`,
    ts: new Date().toISOString(),
    count: entry.count ?? null,
    urls: entry.urls || [],
    report: String(entry.report || ''),
    consumed: false,
  };
  queue.push(report);
  saveQueue();
  // Unfiltered waiters pick it up from their poll once the grace has passed.
  const w = waiters.find((x) => x.filtered && x.match(report));
  if (w) {
    consume(report);
    w.take(report);
  }
};

// ── HTTP endpoint for the extension ──────────────────────────────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return res.end();
    if (req.method !== 'POST' && (req.url || '').startsWith('/inject.js')) {
      // The extension as one page script, for browsers without extension
      // support: the agent injects <script src=…/inject.js> (see shim.js).
      // Read on every request, so edits to the extension files apply at once.
      const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const base = `http://${req.headers.host || `localhost:${PORT}`}`;
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.end(
        [
          '(() => {',
          'if (window.__slopOffShim) return;',
          'window.__slopOffShim = true;',
          src('shim.js'),
          'const background = (chrome) => {',
          src('background.js'),
          '};',
          'const page = (chrome) => {',
          src('panes.js'),
          src('content.js'),
          '};',
          `boot(background, page, ${JSON.stringify(base)});`,
          '})();',
        ].join('\n')
      );
    }
    if (req.method !== 'POST') {
      loadQueue(); // another instance may have consumed reports
      if ((req.url || '').startsWith('/status')) {
        loadEvents();
        const fresh = queue.filter((r) => !r.consumed);
        const busy = inFlight();
        const asStatus = (phase) => ({ id, ts, count, urls, report }) =>
          ({ id, ts, count, urls, report, phase });
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            // A report stays pending in the browser until the agent is done.
            pending: fresh.length + busy.length,
            waiting: isWaiting(),
            processing: busy.length > 0,
            reports: [...busy.map(asStatus('applying')), ...fresh.map(asStatus('queued'))],
            events: events.slice(-10),
          })
        );
      }
      res.statusCode = 200;
      return res.end(`slop-off bridge: ${queue.length} report(s) queued\n`);
    }
    if ((req.url || '').startsWith('/clear')) {
      // "Clear data" in the extension: drop the whole queue and event log.
      loadQueue();
      const stale = queue.filter((r) => !r.consumed || r.done === false);
      stale.forEach((r) => {
        r.consumed = true;
        r.done = true;
      });
      saveQueue();
      events = [];
      saveEvents();
      return res.end(`cleared ${stale.length}`);
    }
    if ((req.url || '').startsWith('/cancel')) {
      // Extension cancels a queued report: mark it consumed so no agent
      // picks it up. A report already grabbed by a watcher stays applied.
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        loadQueue();
        let id;
        try {
          id = JSON.parse(body).id;
        } catch (e) {}
        // Queued: cancel it. Applying: only dismiss it from the pending
        // view — the agent already has it.
        const r = queue.find((q) => q.id === id && (!q.consumed || q.done === false));
        if (r) {
          r.consumed = true;
          r.done = true;
          saveQueue();
        }
        res.statusCode = r ? 200 : 404;
        res.end(r ? 'cancelled' : 'not found');
      });
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        pushReport(JSON.parse(body));
        res.end('ok');
      } catch (e) {
        pushReport({ report: body }); // plain-text report is fine too
        res.end('ok');
      }
    });
});
let bindTries = 0;
server.on('error', (e) => {
  // Port owned elsewhere (another session, or our pre-reload self still
  // closing): retry briefly, then serve MCP from the shared queue file only.
  if (e.code === 'EADDRINUSE' && bindTries++ < 5) return setTimeout(() => server.listen(PORT), 400);
  process.stderr.write(`slop-off: HTTP listener disabled (${e.code})\n`);
});
server.listen(PORT);

// ── MCP over stdio (JSON-RPC 2.0) ────────────────────────────────────
const TOOLS = [
  {
    name: 'wait_for_report',
    description:
      'Return the next unconsumed edit report from the Slop Off browser extension. ' +
      'Returns immediately if one is queued; otherwise waits until a report arrives or the ' +
      'timeout passes. Call repeatedly to drain multiple reports in order.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: {
          type: 'number',
          description: 'Max seconds to wait (default 120).',
        },
        origin: {
          type: 'string',
          description:
            "Only take reports for this app, e.g. 'http://localhost:3012' (or just 'localhost:3012'). " +
            'Pass it whenever several sessions use Slop Off, so each gets only its own reports.',
        },
      },
    },
  },
  {
    name: 'get_latest_report',
    description:
      'Return the most recent edit report (consumed or not), without waiting. ' +
      'Marks it consumed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_reports',
    description: 'List queued edit reports (id, timestamp, edit count, urls, consumed).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'notify_browser',
    description:
      'Show a toast notification in the browser running the Slop Off extension. ' +
      'Call this after applying an edit report, with a short summary (1-2 lines) of what you changed.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Summary shown to the user, max 2 short lines.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'clear_reports',
    description:
      'Clear the queue: mark every unprocessed edit report as consumed so nothing pending ' +
      'gets picked up. Returns how many reports were cleared.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Header includes the backlog so the agent can report progress ("2 more
// queued") without an extra tool call. The footer bakes the notify_browser
// instruction into every report, so a summary comes back regardless of
// which skill version (or none) the agent runs.
const asText = (r, match = () => true) => {
  if (!r) return 'No report available.';
  const backlog = queue.filter((q) => !q.consumed && match(q)).length;
  return (
    `# Edit report ${r.id} (${r.ts}, ${r.count ?? '?'} edits, ` +
    `${backlog} more report${backlog === 1 ? '' : 's'} queued)\n\n${r.report}\n\n` +
    '---\n' +
    'IMPORTANT: after applying (or failing to apply) these edits, call the ' +
    'slop-off tool `notify_browser` with a concrete 1-2 line summary of what ' +
    'you changed and in which files (e.g. "Hero heading updated in ' +
    'index.html"). The user sees this as a toast in the browser; never skip ' +
    'it and never send an empty message.\n'
  );
};

async function callTool(name, args = {}, reqId) {
  loadQueue(); // pick up reports received by another instance
  if (name === 'list_reports') {
    const fresh = queue.filter((r) => !r.consumed);
    const processed = queue.length - fresh.length;
    const tail = processed ? `\n(${processed} processed report(s) kept, last 50 total)` : '';
    return fresh.length
      ? fresh
          .map(
            (r) =>
              `${r.id}  ${r.ts}  ${r.count ?? '?'} edits  ${(r.urls || []).join(', ')}`
          )
          .join('\n') + tail
      : 'No new reports.' + tail;
  }
  if (name === 'notify_browser') {
    const message = String(args.message || '').trim().slice(0, 300);
    if (!message) {
      return 'Ignored: empty message. Call notify_browser again with a 1-2 line summary of what you changed.';
    }
    loadEvents();
    // ponytail: Date.now() as id — monotonic enough for one machine
    events.push({ id: Date.now(), ts: new Date().toISOString(), message });
    saveEvents();
    // The notification doubles as "work finished": complete every in-flight
    // report so the browser's pending count drops now, not at pickup.
    const busy = inFlight();
    busy.forEach((r) => (r.done = true));
    if (busy.length) saveQueue();
    return 'Notification queued; the browser shows it within a few seconds.';
  }
  if (name === 'clear_reports') {
    const stale = queue.filter((r) => !r.consumed || r.done === false);
    stale.forEach((r) => {
      r.consumed = true;
      r.done = true;
    });
    saveQueue();
    return stale.length
      ? `Cleared ${stale.length} pending report${stale.length === 1 ? '' : 's'}.`
      : 'Queue was already empty.';
  }
  if (name === 'get_latest_report') {
    const r = queue[queue.length - 1];
    if (r) consume(r);
    return asText(r);
  }
  if (name === 'wait_for_report') {
    const filtered = Boolean(args.origin);
    const match = matcherFor(args.origin);
    const backlogMatch = filtered ? match : () => true;
    const next = queue.find((r) => !r.consumed && match(r));
    if (next) {
      consume(next);
      return asText(next, backlogMatch);
    }
    const timeoutMs = Math.max(1, Number(args.timeout_seconds || 120)) * 1000;
    completeInFlight(); // agent is waiting again → nothing is being applied
    // Short-lease heartbeat instead of one long lease: if the session is
    // stopped or dies mid-wait, "waiting" expires within ~5s instead of
    // lingering for the full wait timeout.
    setWaiting(5000);
    return await new Promise((resolve) => {
      let fsw = null;
      const hb = setInterval(() => setWaiting(5000), 2000);
      const finish = (text) => {
        clearTimeout(timer);
        clearInterval(poll);
        clearInterval(hb);
        try {
          fsw?.close();
        } catch (e) {}
        waiters = waiters.filter((w) => w !== waiter);
        cancels.delete(reqId);
        setWaiting(0);
        resolve(text);
      };
      if (reqId !== undefined) {
        cancels.set(reqId, () => {
          cancelledIds.add(reqId);
          finish('cancelled');
        });
      }
      const timer = setTimeout(
        () => finish('No report arrived within the timeout. Call wait_for_report again to keep waiting.'),
        timeoutMs
      );
      const waiter = { match, filtered, take: (r) => finish(asText(r, backlogMatch)) };
      waiters.push(waiter);
      // For instances without the HTTP port: react to queue-file writes
      // instantly, with a slow poll as belt-and-braces. Watch the directory,
      // not the file — the file may not exist yet and gets rewritten.
      const check = () => {
        loadQueue();
        const r = queue.find((q) => !q.consumed && match(q));
        if (r) {
          consume(r);
          finish(asText(r, backlogMatch));
        }
      };
      try {
        fsw = fs.watch(DIR, (event, filename) => {
          if (!filename || filename === path.basename(QUEUE_FILE)) check();
        });
      } catch (e) {}
      const poll = setInterval(check, 1000);
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let buf = '';
const onStdinData = (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      continue;
    }
    handle(req);
  }
};
process.stdin.on('data', onStdinData);

async function handle(req) {
  const { id, method, params } = req;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (message) =>
    id !== undefined && send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

  try {
    if (method === 'initialize') {
      reply({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'slop-off', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (method === 'tools/call') {
      const text = await callTool(params.name, params.arguments, id);
      // A cancelled request must not get a response.
      if (!cancelledIds.delete(id)) reply({ content: [{ type: 'text', text }] });
    } else if (method === 'notifications/cancelled') {
      cancels.get(params?.requestId)?.();
    } else if (method === 'ping') {
      reply({});
    } else {
      reply({}); // notifications etc.
    }
  } catch (e) {
    fail(String(e.message || e));
  }
}

const onStdinEnd = () => process.exit(0);
process.stdin.on('end', onStdinEnd);

// ── Hot reload: pick up code changes without an /mcp reconnect ───────
global.__slopOffCleanup = () => {
  fs.unwatchFile(__filename);
  process.stdin.off('data', onStdinData);
  process.stdin.off('end', onStdinEnd);
  // Old wait_for_report waiters keep their file-poll timers and resolve
  // through the same stdout pipe, so in-flight calls survive the reload.
  try {
    server.close();
  } catch (e) {}
};

fs.watchFile(__filename, { interval: 2000 }, (cur, prev) => {
  if (cur.mtimeMs === prev.mtimeMs) return;
  try {
    // Syntax gate: never reload into a crash. Strip the shebang — require()
    // tolerates it but new Function() does not.
    new Function(fs.readFileSync(__filename, 'utf8').replace(/^#!.*/, ''));
  } catch (e) {
    return process.stderr.write(`slop-off: reload skipped (syntax error: ${e.message})\n`);
  }
  process.stderr.write('slop-off: source changed, hot-reloading\n');
  global.__slopOffReloaded = true;
  delete require.cache[__filename];
  try {
    require(__filename); // runs the new code; its top calls our cleanup
  } catch (e) {
    process.stderr.write(`slop-off: reload failed (${e.message})\n`);
  }
});

// Fresh incarnation after a reload: tell the client tools may have changed.
if (global.__slopOffReloaded) {
  global.__slopOffReloaded = false;
  send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}
