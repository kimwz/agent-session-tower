import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existingServerUrl } from '../../../server/instance/existing-server.js';
import { MonitorAlreadyRunning } from '../../../server/instance/state-lock.js';

test('repeat launch reuses only the matching live Monitor instance', async t => {
  let health: unknown = { ok: true, application: 'agent-monitor', pid: process.pid };
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(health)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const error = new MonitorAlreadyRunning({ pid: process.pid, port, createdAt: new Date().toISOString() }, '/test');
  assert.equal(await existingServerUrl(error), `http://localhost:${port}`);
  health = { ok: true, application: 'another-app', pid: process.pid };
  assert.equal(await existingServerUrl(error), undefined);
  health = { ok: true, application: 'agent-monitor', pid: process.pid + 1 };
  assert.equal(await existingServerUrl(error), undefined);
});

test('repeat launch rejects a local-only server when remote access was requested', async t => {
  let health: unknown = { ok: true, application: 'agent-monitor', pid: process.pid };
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(health)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const error = new MonitorAlreadyRunning({ pid: process.pid, port, createdAt: new Date().toISOString() }, '/test');
  const expected = { bindHost: '0.0.0.0', remoteAccess: true, probeHosts: ['127.0.0.1'] };
  await assert.rejects(existingServerUrl(error, expected), /Stop that process first.*--host 0.0.0.0/);
  health = { ok: true, application: 'agent-monitor', pid: process.pid, bindHost: '0.0.0.0', remoteAccess: false };
  await assert.rejects(existingServerUrl(error, expected), /Stop that process first/);
  health = { ok: true, application: 'agent-monitor', pid: process.pid, bindHost: '0.0.0.0', remoteAccess: true };
  assert.equal(await existingServerUrl(error, expected), `http://localhost:${port}`);
  await assert.rejects(existingServerUrl(error, { ...expected, bindHost: '127.0.0.1', remoteAccess: false }), /Stop that process first/);
});
