import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteRequestLedger, REMOTE_REQUEST_RETENTION_MS, remoteRequestTime, requestFingerprint, type RemoteResult } from '../../../server/remote/request-ledger.js';

const CONTROLLER = 'controllera1b2c3d4e5f6';
/** A UUIDv7 whose timestamp is `at`. */
function requestId(at: number, tail = '8abc-0123456789ab'): string {
  const hex = at.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7123-${tail}`;
}
async function fixture(t: TestContext, now = () => Date.now()) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-ledger-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const open = async () => { const ledger = new RemoteRequestLedger(stateDir, now); await ledger.start(); return ledger; };
  return { stateDir, open };
}
const record = (value: { runId: string }): RemoteResult => ({ kind: 'run', runId: value.runId });

test('a retried remote request runs once and answers with what the first one produced', async t => {
  const f = await fixture(t);
  const ledger = await f.open();
  const id = requestId(Date.now());
  let runs = 0;
  const execute = async () => ({ runId: `run-${++runs}` });
  const replay = (result: RemoteResult) => result.kind === 'run' ? { runId: `${result.runId} (current)` } : undefined;
  assert.deepEqual(await ledger.once(CONTROLLER, 'enqueue', id, { prompt: 'hi' }, execute, record, replay), { runId: 'run-1' });
  assert.deepEqual(await ledger.once(CONTROLLER, 'enqueue', id, { prompt: 'hi' }, execute, record, replay), { runId: 'run-1 (current)' });
  assert.equal(runs, 1);
  // The same ID from another controller, or for another operation, is a different request.
  await ledger.once('controllerffffffffffff', 'enqueue', id, { prompt: 'hi' }, execute, record, replay);
  await ledger.once(CONTROLLER, 'create', id, { prompt: 'hi' }, execute, record, replay);
  assert.equal(runs, 3);
  const restarted = await f.open();
  assert.deepEqual(await restarted.once(CONTROLLER, 'enqueue', id, { prompt: 'hi' }, execute, record, replay), { runId: 'run-1 (current)' }, 'a restart remembers it');
  assert.equal(runs, 3);
});

test('the same request ID with different content is refused, and so is a replay whose record has expired', async t => {
  const f = await fixture(t);
  const ledger = await f.open();
  const id = requestId(Date.now());
  await ledger.once(CONTROLLER, 'enqueue', id, { prompt: 'hi' }, async () => ({ runId: 'run-1' }), record, () => undefined);
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', id, { prompt: 'different' }, async () => ({ runId: 'run-2' }), record, () => undefined), /다른 내용/);
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', id, { prompt: 'hi' }, async () => ({ runId: 'run-2' }), record, () => undefined), /이미 처리된 요청/);
});

test('a request refused before admission can be sent again with the same ID', async t => {
  const f = await fixture(t);
  const ledger = await f.open();
  const id = requestId(Date.now());
  let attempts = 0;
  const refuse = async (): Promise<{ runId: string }> => { attempts++; throw Object.assign(new Error('The task queue is full.'), { statusCode: 429 }); };
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', id, {}, refuse, record, () => undefined), /queue is full/);
  const handoff = async (): Promise<{ runId: string }> => { attempts++; throw Object.assign(new Error('Replacing the worker.'), { statusCode: 503, disposition: 'handoff' }); };
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', id, {}, handoff, record, () => undefined), /Replacing/);
  assert.deepEqual(await ledger.once(CONTROLLER, 'enqueue', id, {}, async () => ({ runId: 'run-1' }), record, () => undefined), { runId: 'run-1' });
  assert.equal(attempts, 2);
});

test('an outcome lost to a crash is reported as uncertain instead of running the request a second time', async t => {
  const f = await fixture(t);
  const id = requestId(Date.now());
  // The entry is written before the work starts; a crash in between leaves it without a result.
  await writeFile(join(f.stateDir, 'remote-requests.json'), JSON.stringify([{ key: `${CONTROLLER}\nenqueue\n${id}`, fingerprint: requestFingerprint({ prompt: 'x' }), at: Date.now() }]), { mode: 0o600 });
  const ledger = await f.open();
  let runs = 0;
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', id, { prompt: 'x' }, async () => { runs++; return { runId: 'second' }; }, record, () => undefined),
    (error: Error & { disposition?: string }) => error.disposition === 'uncertain' && /확실하지 않습니다/.test(error.message));
  assert.equal(runs, 0);
});

test('remote request IDs must be recent UUIDv7 values, so an old retry is refused rather than run again', async t => {
  const now = Date.parse('2026-09-24T00:00:00.000Z');
  const f = await fixture(t, () => now);
  const ledger = await f.open();
  assert.equal(remoteRequestTime(requestId(now)), now);
  assert.equal(remoteRequestTime('3d6f4c1e-9a2b-4c3d-8e4f-0123456789ab'), undefined, 'a random UUIDv4 has no time');
  const execute = async () => ({ runId: 'run' });
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', '3d6f4c1e-9a2b-4c3d-8e4f-0123456789ab', {}, execute, record, () => undefined), /형식/);
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', requestId(now - REMOTE_REQUEST_RETENTION_MS - 1), {}, execute, record, () => undefined), /너무 오래된/);
  await assert.rejects(ledger.once(CONTROLLER, 'enqueue', requestId(now + 2 * 24 * 60 * 60 * 1000), {}, execute, record, () => undefined), /너무 오래된/);
  assert.deepEqual(await ledger.once(CONTROLLER, 'enqueue', requestId(now - 60_000), {}, execute, record, () => undefined), { runId: 'run' });
});
