// Two waiters on one bridge: a portal loop (origin 3012) and an old-style
// unfiltered loop. A portal report must go to the portal loop, a website
// report to the unfiltered one (after the grace).
const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');
// Run: node mcp/server.test.js (own port and a throwaway HOME, so the real queue is untouched)
const home = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'slop-off-'));
const p = spawn('node', [require('path').join(__dirname, 'server.js')], { env: { ...process.env, HOME: home, SLOP_OFF_PORT: '8939' } });
let buf = ''; const got = {};
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id) got[m.id] = m.result.content[0].text; } });
const call = (id, args) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'wait_for_report', arguments: args } }) + '\n');
const post = (url) => new Promise((ok) => { const r = http.request({ port: 8939, method: 'POST', headers: { 'content-type': 'application/json' } }, () => ok()); r.end(JSON.stringify({ report: `edit on ${url}`, count: 1, urls: [url] })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(500);
  call(1, { timeout_seconds: 10 });                          // old website loop, no origin
  call(2, { timeout_seconds: 10, origin: 'localhost:3012' }); // portal loop
  await sleep(300);
  await post('http://localhost:3012/kennismaking');
  await sleep(500);
  assert.match(got[2] || '', /3012/, 'portal loop gets the portal report');
  assert.strictEqual(got[1], undefined, 'unfiltered loop did not steal it');
  await post('http://localhost:3013/kennisbank');
  await sleep(4500);
  assert.match(got[1] || '', /3013/, 'unfiltered loop gets the website report after the grace');
  console.log('ok: reports routed per origin');
  p.kill(); process.exit(0);
})().catch((e) => { console.error(e.message, got); p.kill(); process.exit(1); });
