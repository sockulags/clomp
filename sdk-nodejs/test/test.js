// Self-contained SDK test: spins up a stub HTTP server, records events and
// asserts what arrives. Run with: npm test
const http = require('http');
const assert = require('assert');
const Clomp = require('../src/index');

async function main() {
  const received = [];
  let failNext = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      received.push({ path: req.url, apiKey: req.headers['x-api-key'], body: JSON.parse(body) });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ event: { sequence: received.length } }));
    });
  });
  await new Promise(resolve => server.listen(0, resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  const clomp = new Clomp({
    apiUrl,
    apiKey: 'clomp_live_test',
    defaultActor: { type: 'service', id: 'test-suite' },
    flushInterval: 0
  });

  // 1. Events are sent FIFO with the API key header
  clomp.record('patch.applied', { target: { type: 'system', id: 'web-01' } });
  clomp.record('backup.tested', { context: { ok: true }, occurredAt: '2026-07-01T06:00:00Z' });
  await clomp.flush();

  assert.strictEqual(received.length, 2, 'both events delivered');
  assert.strictEqual(received[0].path, '/api/events');
  assert.strictEqual(received[0].apiKey, 'clomp_live_test');
  assert.strictEqual(received[0].body.action, 'patch.applied');
  assert.deepStrictEqual(received[0].body.actor, { type: 'service', id: 'test-suite' });
  assert.strictEqual(received[1].body.occurred_at, '2026-07-01T06:00:00.000Z');

  // 2. Server errors keep the event queued for retry
  failNext = 1;
  clomp.record('incident.opened', {});
  await clomp.flush();
  assert.strictEqual(clomp.queue.length, 1, 'event retained after 500');
  await clomp.flush();
  assert.strictEqual(clomp.queue.length, 0, 'event delivered on retry');
  assert.strictEqual(received[2].body.action, 'incident.opened');

  // 3. Permanent rejections are dropped instead of wedging the queue
  clomp.record('bad.event', {});
  const origPost = require('axios').post;
  require('axios').post = async () => {
    const err = new Error('Bad Request');
    err.response = { status: 400, data: { error: 'invalid' } };
    throw err;
  };
  await clomp.flush();
  require('axios').post = origPost;
  assert.strictEqual(clomp.queue.length, 0, '400-rejected event dropped');

  // 4. record() without an actor never throws, just logs
  const bare = new Clomp({ apiUrl, apiKey: 'k', flushInterval: 0 });
  bare.record('a.b'); // no actor and no defaultActor
  assert.strictEqual(bare.queue.length, 0, 'invalid event not queued');
  await bare.destroy();

  await clomp.destroy();
  server.close();
  console.log('✅ SDK tests passed');
}

main().catch(err => {
  console.error('❌ SDK test failed:', err.message);
  process.exit(1);
});
