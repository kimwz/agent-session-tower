import { APP_VERSION } from '../../../shared/app-identity.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentVersion, entryPoint, pointCurrent, runtimePaths, versionDirectory } from '../../../server/link/service.js';
import { evaluateStorageUpdate, preparationCheck, readPreparationEvidence, recordPreparationEvidence, type RunningBuild, type StorageUpdateVerdict } from '../../../server/link/storage-update.js';
import { runUpdateHelper, serviceSteps, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';
import { storageWebBuild, storageWebHealth } from '../../../server/link/storage-web.js';
import * as legacy from './fixtures/legacy-1.114.1/server/link/update.js';
import { A, B, L, installArtifact, openGate, preparedStorage, runningBuild } from './fixtures/storage-builds.js';

/** The JSON-only updater as every release before the preparation releases runs it (commit 3ac344e, unchanged since 226ae49). */
const LEGACY_SHA256 = {
  'server/link/update.ts': 'a9ddd9c44c71d094b3465ccda31c205e57fbc72171ad07f07a569efbd0aad241',
  'server/link/service.ts': '882f3c83193877ee815159ba1535cfc83bce34c8b7d06f94fc9e393aa6e1cad1',
};

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-storage-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(runtimePaths(directory).versions, { recursive: true });
  return directory;
}

/**
 * The service's web, as the version `current` points at runs it: a JSON-only release answers its health as it always
 * did; a storage release answers with the real evaluation and storageHealth (503 on refusal). A restart starts whatever
 * `current` points at as a new process, on the same port.
 */
class ServiceWeb {
  private server?: Server;
  port = 0;
  pid = 500;
  version = '';
  readonly answers: Array<{ version: string; status: number; verdict?: StorageUpdateVerdict; code?: string; importAllowed?: boolean }> = [];
  constructor(private readonly state: string, private readonly builds: Record<string, RunningBuild | 'legacy'>) {}

  async start(version: string): Promise<void> {
    this.version = version;
    this.pid++;
    const server = createServer((request, response) => { void this.answer(request.url ?? '', response); });
    await new Promise<void>(resolve => server.listen(this.port, '127.0.0.1', resolve));
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }
  async restart(): Promise<void> {
    await this.stop();
    await this.start((await currentVersion(this.state))!);
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  private async answer(url: string, response: import('node:http').ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url === '/api/link') return send(200, { controllers: [] });
    if (url !== '/api/health') return send(404, {});
    const build = this.builds[this.version];
    if (build === 'legacy') { this.answers.push({ version: this.version, status: 200 }); return send(200, { application: 'agent-session-tower', version: this.version, pid: this.pid }); }
    const health = await storageWebHealth({ stateDir: this.state, build, managed: true });
    this.answers.push({ version: this.version, status: health.status, verdict: health.candidateStorage.state, code: health.candidateStorage.code, importAllowed: health.candidateStorage.importAllowed });
    send(health.status, { application: 'agent-session-tower', version: this.version, pid: this.pid, storage: health.candidateStorage });
  }
}

/** The helper's own steps for this port, with installing and restarting done by the fixture and a clock that moves only while it waits. */
function fixtureSteps<T extends UpdateHelperSteps | legacy.UpdateHelperSteps>(base: T, state: string, web: ServiceWeb, log: string[]): T {
  let clock = Date.parse('2026-10-08T00:00:00.000Z');
  return { ...base, free: async () => undefined, install: async (version: string) => versionDirectory(state, version), restart: () => web.restart(),
    sleep: async (ms: number) => { clock += ms; }, now: () => clock, log: (line: string) => { log.push(line); } };
}

/** Every file under the state directory but what an update itself rewrites (its record, the current link, its log). */
async function untouched(state: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const skip = new Set([updatePaths(state).status, runtimePaths(state).current, runtimePaths(state).logs]);
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (skip.has(path)) continue;
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else out[path] = info.isSymbolicLink() ? `link:${await readlink(path)}` : createHash('sha256').update(await readFile(path)).digest('hex');
    }
  };
  await walk(state);
  return out;
}

test('the fixture is the JSON-only updater itself, byte for byte', async () => {
  for (const [path, sha256] of Object.entries(LEGACY_SHA256)) {
    const file = fileURLToPath(new URL(`./fixtures/legacy-1.114.1/${path}`, import.meta.url));
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), sha256, path);
  }
});

test('the JSON-only updater asked for B goes back on B\'s 503 and leaves the state as it was; through A, B is kept', async t => {
  const state = await stateDir(t);
  await installArtifact(state, L, { legacy: true });
  await installArtifact(state, A);
  await installArtifact(state, B);
  await pointCurrent(state, L);
  // The JSON authority a JSON-only release keeps.
  await writeFile(join(state, 'runs.json'), JSON.stringify({ version: 1, runs: [{ id: 'run-1', status: 'queued' }] }), { mode: 0o600 });
  await writeFile(join(state, 'triggers.json'), JSON.stringify({ version: 1, triggers: [{ id: 'once-1', consumed: false }] }), { mode: 0o600 });
  const web = new ServiceWeb(state, { [L]: 'legacy', [A]: runningBuild(A), [B]: runningBuild(B) });
  await web.start(L);
  t.after(() => web.stop());
  const before = await untouched(state);
  const log: string[] = [];

  // 1. The latest-only updater on L asks for B, as its scheduler does every day.
  assert.equal((await new legacy.Updates({ stateDir: state, version: L, port: web.port, managed: true, spawnHelper: () => {} }).request(B)).status, 202);
  const refused = await legacy.runUpdateHelper(state, B, fixtureSteps(legacy.serviceSteps(state, web.port), state, web, log));
  assert.equal(refused?.stage, 'failed');
  assert.equal(refused?.code, 'start-failed', 'its response.ok check fails on 503 and it goes back');
  assert.equal(refused?.failedStage, 'verifying');
  assert.equal(await currentVersion(state), L);
  assert.equal(web.version, L, 'the previous version serves again');
  assert.equal(existsSync(updatePaths(state).hold), false);
  const fromB = web.answers.filter(answer => answer.version === B);
  assert.ok(fromB.length > 0, 'B was asked');
  assert.ok(fromB.every(answer => answer.status === 503 && answer.verdict === 'refused' && answer.code === 'prerequisite-required' && answer.importAllowed === false), JSON.stringify(fromB.slice(0, 3)));
  assert.deepEqual(await untouched(state), before, 'nothing of the state changed: no JSON rewritten, no storage, evidence or recovery file');
  for (const name of ['state.sqlite', 'storage-contracts', 'storage-recovery', 'storage-snapshots']) assert.equal(existsSync(join(state, name)), false, name);

  // 2. The operator (or deploy agent) asks for the preparation release A first; the old updater installs it.
  assert.equal((await new legacy.Updates({ stateDir: state, version: L, port: web.port, managed: true, spawnHelper: () => {} }).request(A)).status, 202);
  const prepared = await legacy.runUpdateHelper(state, A, fixtureSteps(legacy.serviceSteps(state, web.port), state, web, log));
  assert.equal(prepared?.stage, 'done');
  assert.equal(await currentVersion(state), A);
  assert.ok(web.answers.filter(answer => answer.version === A).every(answer => answer.status === 200), 'A answers while its update is verified');
  // A's worker records its evidence once its storage contract is checked, its storage prepared and its gate open.
  const a = runningBuild(A);
  await recordPreparationEvidence(state, { context: { identity: a.preflight.identity!, manifest: a.manifest! }, preflight: a.preflight, prepared: preparedStorage(), gate: openGate });
  assert.equal((await readPreparationEvidence(state, 'retention')).state, 'present');
  // From here the state directory records the storage A prepared: a start is ready only where its preflight sees it.
  const seenDatabase = { database: 'present' as const, sidecars: [], identity: 'created' as const, recovery: { state: 'clear' as const } };
  assert.equal((await evaluateStorageUpdate({ stateDir: state, build: runningBuild(A, { state: seenDatabase }), managed: true })).verdict, 'ready', 'A was kept and runs');
  assert.equal((await evaluateStorageUpdate({ stateDir: state, build: a, managed: true })).code, 'known-storage-missing', 'not where its database is missing');

  // 3. From A, B is asked for again (A's updater checks B's contract first), verified while its import waits, and kept.
  const answered = web.answers.length;
  assert.equal((await new Updates({ stateDir: state, version: A, port: web.port, managed: true, spawnHelper: () => {} }).request(B)).status, 202);
  const kept = await runUpdateHelper(state, B, fixtureSteps(serviceSteps(state, web.port), state, web, log));
  assert.equal(kept?.stage, 'done', log.join('\n'));
  assert.equal(await currentVersion(state), B);
  const verifying = web.answers.slice(answered).filter(answer => answer.version === B);
  assert.ok(verifying.length > 0 && verifying.every(answer => answer.status === 200 && answer.verdict === 'update-held' && answer.importAllowed === false), 'B answers 200 and holds its import while it is verified');
  t.diagnostic(`health answers: B refused ${fromB.length}×503, A ${web.answers.filter(answer => answer.version === A).length}×200, B verified ${verifying.length}×200 update-held`);
  const after = await evaluateStorageUpdate({ stateDir: state, build: runningBuild(B, { state: seenDatabase }), managed: true });
  assert.equal(after.verdict, 'ready');
  assert.equal(after.code, 'service-update-done');
  assert.equal(after.importAllowed, true, 'once kept, with no hold or helper left, B may import');
});


test('legacy helper consumes actual candidate web preflight and backs out on an unsupported runtime before changing data', async t => {
  const state = await stateDir(t);
  await installArtifact(state, L, { legacy: true });
  const build = await storageWebBuild(state, APP_VERSION)();
  const installed = await installArtifact(state, APP_VERSION, { manifest: build.manifest });
  const { artifactStorageContract } = await import('../../../server/link/storage-update.js');
  if (build.manifest && build.preflight.identity) {
    await writeFile(join(dirname(entryPoint(installed)), 'contract.json'), JSON.stringify(artifactStorageContract({ manifest: build.manifest, identity: build.preflight.identity }, build.preflight)));
  }
  await pointCurrent(state, L);
  await writeFile(join(state, 'runs.json'), '{"version":1,"runs":[]}', { mode: 0o600 });
  const before = await untouched(state);
  const web = new ServiceWeb(state, { [L]: 'legacy', [APP_VERSION]: build });
  await web.start(L); t.after(() => web.stop());
  const log: string[] = [];
  const updates = new legacy.Updates({ stateDir: state, version: L, port: web.port, managed: true, spawnHelper: () => {} });
  assert.equal((await updates.request(APP_VERSION)).status, 202);
  const result = await legacy.runUpdateHelper(state, APP_VERSION, fixtureSteps(legacy.serviceSteps(state, web.port), state, web, log));
  assert.ok(build.manifest);
  const previous = preparationCheck(build.manifest, { state: 'legacy', version: L });
  const accepted = build.preflight.supported && previous.state === 'not-required';
  const refusal = !build.preflight.supported ? 'runtime-unsupported'
    : previous.state === 'prerequisite-required' ? 'prerequisite-required' : `previous-${previous.state}`;
  assert.equal(result?.stage, accepted ? 'done' : 'failed', log.join('\n'));
  const answers = web.answers.filter(answer => answer.version === APP_VERSION);
  assert.ok(answers.length > 0);
  assert.ok(answers.every(answer => answer.status === (accepted ? 200 : 503)));
  if (!accepted) {
    assert.equal(result?.code, 'start-failed');
    assert.equal(await currentVersion(state), L);
    assert.ok(answers.every(answer => answer.code === refusal),
      JSON.stringify({ target: APP_VERSION, managed: true, preflight: build.preflight, result, answers, log }));
  }
  assert.deepEqual(await untouched(state), before, 'even legacy verification changes no original JSON, DB, migration or recovery state');
  assert.equal(existsSync(join(state, 'state.sqlite')), false);
});
