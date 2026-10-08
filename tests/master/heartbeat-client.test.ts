import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { TowerClient } from '../../server/tower-tools/tower-client.js';
test('heartbeat singleAttempt does not retry proven non-admission', async t => {
  let attempts = 0;
  const server = createServer((_req, res) => { attempts++; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ disposition: 'not-admitted' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const client = new TowerClient(1000); client.setCredentials({ port: (server.address() as { port: number }).port, token: 'a'.repeat(64), callerSecret: 'b'.repeat(64) });
  const result = await client.call('POST', '/api/sessions/master/messages', { prompt: 'fixture' }, { write: true, singleAttempt: true });
  assert.equal(attempts, 1); assert.equal(result.state, 'not-admitted');
});
