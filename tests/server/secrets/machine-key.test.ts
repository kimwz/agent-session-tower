import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { SecretService } from '../../../server/secrets/service.js';
import { machinePassword, readMachineKey } from '../../../server/secrets/machine-key.js';
import { FixtureRuns } from '../../helpers/secrets.js';

const PASSWORD = 'fixture-machine-key-password';
const HOST = 'c'.repeat(32);

/** A computer's worker as it starts: its vault service and runtime, following `host` or nobody. */
async function worker(stateDir: string, follow: { host?: string }, migrate?: () => Promise<void>) {
  const service = new SecretService({ stateDir }); await service.start();
  const runtime = new SecretRuntime({ stateDir, service, runs: new FixtureRuns(), followed: async () => follow.host, ...(migrate ? { migrate } : {}) });
  return { service, runtime };
}
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-machine-key-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'); await mkdir(stateDir);
  // Everything the workers print, to show the machine key never appears there.
  const printed: string[] = []; const original = { warn: console.warn, error: console.error, log: console.log };
  for (const name of ['warn', 'error', 'log'] as const) console[name] = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  t.after(() => Object.assign(console, original));
  return { stateDir, printed };
}

test('a clean computer that follows a host makes its vault with a machine key and opens it by itself after a restart', async t => {
  const f = await fixture(t); const follow: { host?: string } = {};
  const idle = await worker(f.stateDir, follow);
  assert.equal(await idle.runtime.machineVault(), 'off', 'nothing happens on a computer that follows nobody');
  assert.equal(idle.service.status().initialized, false); assert.equal(await readMachineKey(f.stateDir), undefined);
  follow.host = HOST;
  assert.equal(await idle.runtime.machineVault(), 'open');
  assert.deepEqual(idle.service.status(), { initialized: true, locked: false });
  const key = (await readMachineKey(f.stateDir))!;
  assert.equal((await stat(join(f.stateDir, 'secrets', 'machine-key'))).mode & 0o777, 0o600);
  const device = idle.service.device().id;
  idle.runtime.close();
  const restarted = await worker(f.stateDir, follow);
  assert.equal(restarted.service.status().locked, true, 'a new worker starts locked');
  assert.equal(await restarted.runtime.machineVault(), 'open', 'and opens with the machine key, no password');
  assert.equal(restarted.service.device().id, device);
  assert.equal(await restarted.runtime.machineVault(), 'open', 'again changes nothing');
  // The key's text is the vault password too, so a build without machine keys can open it.
  const older = new SecretService({ stateDir: f.stateDir }); await older.start(); await older.unlock(machinePassword(key));
  assert.equal(older.device().id, device);
  // The successor of a handoff opens with the carried key as before.
  const carry = restarted.service.handoff()!;
  const successor = await worker(f.stateDir, follow); await successor.runtime.adopt(carry);
  assert.equal(successor.service.status().locked, false);
  const disk = await readFile(join(f.stateDir, 'secrets', 'vault.json'), 'utf8') + await readFile(join(f.stateDir, 'secrets', 'index.json'), 'utf8');
  assert.equal(disk.includes(machinePassword(key)), false, 'the vault never holds the key');
  assert.equal(f.printed.join('\n').includes(machinePassword(key)), false, 'never printed');
  for (const item of [restarted, successor]) item.runtime.close();
});

test('an open password vault gets the machine wrapper at once; a locked one needs one open, after which restarts open by themselves', async t => {
  const f = await fixture(t); const follow: { host?: string } = {};
  const first = await worker(f.stateDir, follow); await first.runtime.control('initialize', { password: PASSWORD });
  follow.host = HOST;
  assert.equal(await first.runtime.machineVault(), 'open');
  const key = (await readMachineKey(f.stateDir))!;
  assert.equal(first.service.vault.hasMachine(key), true, 'the open vault got the wrapper');
  first.runtime.close();
  const next = await worker(f.stateDir, follow);
  assert.equal(await next.runtime.machineVault(), 'open');
  next.runtime.close();

  // A password vault that was locked when this computer started following.
  const other = await fixture(t); const following: { host?: string } = {};
  const made = await worker(other.stateDir, following); await made.runtime.control('initialize', { password: PASSWORD }); made.runtime.close();
  following.host = HOST;
  const locked = await worker(other.stateDir, following);
  assert.equal(await locked.runtime.machineVault(), 'needs-open', 'the owner opens it once');
  assert.deepEqual(await locked.runtime.align({ routeId: HOST, direction: 'controller' }), { vault: 'needs-open', trusted: false }, 'and the host card says so');
  await locked.runtime.control('unlock', { password: PASSWORD });
  assert.equal(locked.service.vault.hasMachine((await readMachineKey(other.stateDir))!), true, 'the open added the wrapper');
  locked.runtime.close();
  const after = await worker(other.stateDir, following);
  assert.equal(await after.runtime.machineVault(), 'open', 'never asked again');
  // A vault the owner locked stays locked until it is opened some other way or the worker starts again.
  await after.runtime.control('lock', {});
  assert.equal(await after.runtime.machineVault(), 'needs-open');
  assert.equal(after.service.status().locked, true);
  after.runtime.close();
  const again = await worker(other.stateDir, following);
  assert.equal(await again.runtime.machineVault(), 'open');
  again.runtime.close();
});

test('a machine key that does not open the vault waits for the owner, and a damaged key file is never replaced', async t => {
  const f = await fixture(t); const follow = { host: HOST };
  const made = await worker(f.stateDir, follow); assert.equal(await made.runtime.machineVault(), 'open'); made.runtime.close();
  await writeFile(join(f.stateDir, 'secrets', 'machine-key'), JSON.stringify({ format: 1, key: Buffer.alloc(32, 7).toString('base64url') }), { mode: 0o600 });
  const wrong = await worker(f.stateDir, follow);
  assert.equal(await wrong.runtime.machineVault(), 'needs-open');
  wrong.runtime.close();
  await writeFile(join(f.stateDir, 'secrets', 'machine-key'), 'damaged', { mode: 0o600 });
  const damaged = await worker(f.stateDir, follow);
  await assert.rejects(damaged.runtime.machineVault(), /machine key file/);
  assert.equal(await readFile(join(f.stateDir, 'secrets', 'machine-key'), 'utf8'), 'damaged');
  damaged.runtime.close();
});

test('an owner lock made while an automatic open finishes stays: the open does not undo it, and nothing reopens it', async t => {
  const f = await fixture(t); const follow = { host: HOST };
  const made = await worker(f.stateDir, follow); assert.equal(await made.runtime.machineVault(), 'open'); made.runtime.close();
  let release!: () => void; let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  let hold = true;
  const next = await worker(f.stateDir, follow, async () => { if (hold) { hold = false; entered(); await gate; } });
  const opening = next.runtime.machineVault();
  await reached; // Opened with the machine key, still finishing.
  await next.runtime.control('lock', {});
  release(); await opening;
  assert.equal(next.service.status().locked, true);
  assert.equal(await next.runtime.machineVault(), 'needs-open', 'the owner’s lock is kept');
  assert.equal(next.service.status().locked, true);
  next.runtime.close();
});
