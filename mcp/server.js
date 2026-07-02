#!/usr/bin/env node
// Slop Off MCP server: receives reports from the extension over HTTP
// and serves them to a coding agent over MCP (stdio). No dependencies.
//
// Register with:  claude mcp add slop-off -- node /path/to/mcp/server.js
// Extension:      set the webhook URL to http://localhost:8931 in the options.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.SLOP_OFF_PORT || 8931);
const DIR = path.join(os.homedir(), '.slop-off');
const QUEUE_FILE = path.join(DIR, 'queue.json');

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

let waiters = []; // pending wait_for_report resolvers

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
  const w = waiters.shift();
  if (w) {
    report.consumed = true;
    saveQueue();
    w(report);
  }
};

// ── HTTP endpoint for the extension ──────────────────────────────────
http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return res.end();
    if (req.method !== 'POST') {
      res.statusCode = 200;
      return res.end(`slop-off bridge: ${queue.length} report(s) queued\n`);
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
  })
  .on('error', (e) => {
    // Another instance owns the port; we serve MCP from the shared queue file.
    process.stderr.write(`slop-off: HTTP listener disabled (${e.code})\n`);
  })
  .listen(PORT);

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
];

const asText = (r) =>
  r
    ? `# Edit report ${r.id} (${r.ts}, ${r.count ?? '?'} edits)\n\n${r.report}`
    : 'No report available.';

async function callTool(name, args = {}) {
  loadQueue(); // pick up reports received by another instance
  if (name === 'list_reports') {
    const fresh = queue.filter((r) => !r.consumed);
    const processed = queue.length - fresh.length;
    const tail = processed ? `\n(${processed} processed report(s) kept, last 50 total)` : '';
    return fresh.length
      ? fresh
          .map((r) => `${r.id}  ${r.ts}  ${r.count ?? '?'} edits  ${(r.urls || []).join(', ')}`)
          .join('\n') + tail
      : 'No new reports.' + tail;
  }
  if (name === 'get_latest_report') {
    const r = queue[queue.length - 1];
    if (r) {
      r.consumed = true;
      saveQueue();
    }
    return asText(r);
  }
  if (name === 'wait_for_report') {
    const next = queue.find((r) => !r.consumed);
    if (next) {
      next.consumed = true;
      saveQueue();
      return asText(next);
    }
    const timeoutMs = Math.max(1, Number(args.timeout_seconds || 120)) * 1000;
    return await new Promise((resolve) => {
      const finish = (text) => {
        clearTimeout(timer);
        clearInterval(poll);
        waiters = waiters.filter((w) => w !== resolver);
        resolve(text);
      };
      const timer = setTimeout(
        () => finish('No report arrived within the timeout. Call wait_for_report again to keep waiting.'),
        timeoutMs
      );
      const resolver = (r) => finish(asText(r));
      waiters.push(resolver);
      // Fallback for instances without the HTTP port: watch the queue file.
      const poll = setInterval(() => {
        loadQueue();
        const r = queue.find((q) => !q.consumed);
        if (r) {
          r.consumed = true;
          saveQueue();
          finish(asText(r));
        }
      }, 1000);
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let buf = '';
process.stdin.on('data', (chunk) => {
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
});

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
      const text = await callTool(params.name, params.arguments);
      reply({ content: [{ type: 'text', text }] });
    } else if (method === 'ping') {
      reply({});
    } else {
      reply({}); // notifications etc.
    }
  } catch (e) {
    fail(String(e.message || e));
  }
}

process.stdin.on('end', () => process.exit(0));
