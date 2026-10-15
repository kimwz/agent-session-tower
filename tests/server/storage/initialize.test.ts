import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { before, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { captureStorageBundle, type StorageBundleCapture } from '../../../server/storage/bundle.js';
import type { StorageClient } from '../../../server/storage/client.js';
import {
  freshManifestSha256, initializeStorageDomains, openWorkerStorage, requireDomainAuthority, STORAGE_DOMAINS, StorageInitializationError, storagePreopenRefusal,
  type OpenWorkerStorageResult, type StorageDomainScope,
} from '../../../server/storage/initialize.js';
import { preflightStorage } from '../../../server/storage/preflight.js';
import { currentStorage } from '../../helpers/current-storage.js';

let bundle: StorageBundleCapture;
before(async () => { bundle = await captureStorageBundle(); });

const DATABASE = 'state.sqlite';
async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-initialize-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** A current store with every domain authority, closed. */
async function currentStore(t: TestContext): Promise<string> {
  const dir = await stateDir(t);
  await (await currentStorage(dir)).close();
  return dir;
}
/** One worker start on `dir`; the client it opened is closed before answering. */
async function start(dir: string, extra: { proceed?: () => boolean } = {}): Promise<OpenWorkerStorageResult & { status?: ReturnType<StorageClient['status']> }> {
  const preflight = await preflightStorage({ bundle, stateDir: dir });
  const result = await openWorkerStorage({ stateDir: dir, bundle, preflight, ...extra });
  const status = result.database?.status();
  await result.database?.close();
  return { ...result, ...(status ? { status } : {}) };
}
/** Runs SQL on the live database with a plain connection, then closes it (SQLite checkpoints and removes the WAL). */
function sql(dir: string, text: string): void {
  const db = new DatabaseSync(join(dir, DATABASE));
  try { db.exec(text); } finally { db.close(); }
}
/** Every table's rows (sorted) and the schema itself, read with a plain connection. */
function dump(dir: string): Record<string, string[]> {
  const db = new DatabaseSync(join(dir, DATABASE));
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const rows: Record<string, string[]> = { sqlite_schema: (db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all()).map(row => JSON.stringify(row)) };
    for (const name of tables) rows[name] = db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort();
    return rows;
  } finally { db.close(); }
}
const metaOf = (rows: string[]) => Object.fromEntries(rows.map(row => JSON.parse(row) as { key: string; value: string }).map(row => [row.key, row.value]));
/** Asserts that `after` differs from `before` only by one new claim: the owner_* keys and one core prepare receipt. */
function onlyClaimed(before: Record<string, string[]>, after: Record<string, string[]>): void {
  for (const name of Object.keys({ ...before, ...after })) if (name !== 'storage_meta' && name !== 'operation_receipts') assert.deepEqual(after[name], before[name], name);
  const [was, now] = [metaOf(before.storage_meta), metaOf(after.storage_meta)];
  for (const key of Object.keys({ ...was, ...now })) if (!key.startsWith('owner_')) assert.equal(now[key], was[key], key);
  assert.equal(Number(now.owner_epoch), Number(was.owner_epoch) + 1);
  const added = after.operation_receipts.filter(row => !before.operation_receipts.includes(row)).map(row => JSON.parse(row) as { scope: string; command: string });
  assert.equal(after.operation_receipts.length, before.operation_receipts.length + 1);
  assert.deepEqual(added.map(row => [row.scope, row.command]), [['core', 'prepare']]);
}
/** Bytes, size, inode and mtime of every file and folder under `dir`. */
async function filesUnder(dir: string): Promise<Record<string, string>> {
  const facts: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await lstat(path);
    facts[relative(dir, path)] = info.isDirectory() ? 'dir'
      : JSON.stringify({ sha256: createHash('sha256').update(await readFile(path)).digest('hex'), size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 });
  }
  return facts;
}
/** The ops the storage posted to its threads during the test. */
function threadOps(t: TestContext): string[] {
  const ops: string[] = [];
  const post = Worker.prototype.postMessage;
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, message: unknown, transfer?: readonly never[]) {
    ops.push(String((message as { op?: unknown })?.op));
    post.call(this, message, transfer);
  });
  return ops;
}
/** Ends a process holding the database without closing it: its change stays only in the WAL (with the shm). */
async function crashWith(dir: string, text: string): Promise<void> {
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(join(dir, DATABASE))}); db.exec(${JSON.stringify(text)}); process.kill(process.pid, 'SIGKILL');`;
  await new Promise<void>(resolve => execFile(process.execPath, ['-e', script], () => resolve()));
}
const created = STORAGE_DOMAINS.map(scope => ({ scope, result: 'created' }));
const present = STORAGE_DOMAINS.map(scope => ({ scope, result: 'present' }));

test('a fresh state directory gets the seven empty authorities at generation 1, and a second start finds them present', async t => {
  const dir = await stateDir(t);
  const first = await start(dir);
  assert.equal(first.refusal, undefined, JSON.stringify(first.refusal));
  assert.deepEqual(first.domains, created);
  const rows = dump(dir);
  const authorities = rows.domain_imports.map(row => JSON.parse(row) as { domain: string; authority: string; generation: number; manifest_sha256: string });
  assert.deepEqual(authorities.map(row => row.domain).sort(), [...STORAGE_DOMAINS].sort());
  for (const row of authorities) assert.deepEqual([row.authority, row.generation, row.manifest_sha256], ['database', 1, freshManifestSha256(row.domain as typeof STORAGE_DOMAINS[number])], row.domain);
  assert.equal(freshManifestSha256('runs'), createHash('sha256').update('tower-fresh-initialization\nruns').digest('hex'));
  const wrappers = rows.automation_workflows_rows.map(row => JSON.parse(row) as { channel: string; kind: string });
  assert.deepEqual(wrappers.map(row => [row.channel, row.kind]).sort(), [['github', 'settings'], ['slack', 'settings']]);
  for (const table of ['runs_rows', 'remote_rows', 'auto_prompt_rows', 'permission_rules', 'permission_requests']) assert.deepEqual(rows[table], [], `${table} is empty`);
  for (const name of Object.keys(rows).filter(name => name.endsWith('_stages') || name.endsWith('_stage_chunks'))) assert.deepEqual(rows[name], [], name);
  const commands = rows.operation_receipts.map(row => JSON.parse(row) as { command_id: string; scope: string });
  for (const receipt of commands.filter(receipt => receipt.scope !== 'core')) assert.match(receipt.command_id, new RegExp(`^fresh-${receipt.scope}-[0-9a-f-]{36}`));
  assert.deepEqual((await readdir(dir)).sort(), [DATABASE, 'storage-recovery'], 'no migration evidence or legacy folder is written');

  const second = await start(dir);
  assert.equal(second.refusal, undefined);
  assert.deepEqual(second.domains, present);
  onlyClaimed(rows, dump(dir));
});

test('an existing current store is opened without any change but the claim: schema, migrations, authorities and rows identical', async t => {
  const dir = await currentStore(t);
  const before = dump(dir);
  const result = await start(dir);
  assert.equal(result.refusal, undefined);
  assert.deepEqual(result.domains, present);
  onlyClaimed(before, dump(dir));
});

for (const [name, crashed] of [['checkpointed into the database', false], ['only in an un-checkpointed WAL', true]] as const) {
  test(`a behind store (${name}) is refused at open before the live open: every file byte-, inode- and mtime-identical`, async t => {
    const dir = await currentStore(t);
    const behind = "DELETE FROM schema_migrations WHERE scope = 'retention' AND version = 2";
    if (crashed) {
      await crashWith(dir, behind);
      // The main file alone still says current: the behind state is only in the WAL.
      const probe = await stateDir(t);
      await copyFile(join(dir, DATABASE), join(probe, DATABASE));
      assert.equal(dump(probe).schema_migrations.filter(row => (JSON.parse(row) as { scope: string }).scope === 'retention').length, 2);
      assert.ok((await lstat(join(dir, `${DATABASE}-wal`))).size > 0);
    } else sql(dir, `${behind}; PRAGMA wal_checkpoint(TRUNCATE);`);
    const files = await filesUnder(dir);
    assert.ok(files[join('storage-recovery', 'identity.json')]);
    const ops = threadOps(t);
    const result = await start(dir);
    assert.equal(result.refusal?.code, 'migration-required', JSON.stringify(result.refusal));
    assert.equal(result.refusal?.state, 'unavailable');
    assert.equal(result.refusal?.healthStatus, 503);
    assert.equal(result.refusal?.failure?.sourcePreserved, true);
    assert.equal(result.status?.failure?.phase, 'schema');
    assert.ok(ops.includes('check'), 'the private copy was checked');
    assert.ok(!ops.includes('open') && !ops.includes('prepare'), `the live files were never opened: ${ops.join(', ')}`);
    assert.deepEqual(await filesUnder(dir), files, 'no file changed and no .storage-check-* copy is left');
  });
}

const MISSING_WITH_ROWS = [
  ['permissions', "DELETE FROM domain_imports WHERE domain = 'permissions'"],
  // Authority and state gone, a business row kept: head() alone would read this domain as empty.
  ['permissions', "DELETE FROM domain_imports WHERE domain = 'permissions'; DELETE FROM permission_state; INSERT INTO permission_metadata (id, ordinal, json) VALUES ('lost', 0, '{}')"],
  ['retention', "DELETE FROM domain_imports WHERE domain = 'retention'; DELETE FROM retention_state; INSERT INTO retention_metadata (kind, id, ordinal, json) VALUES ('entry', 'kept', 0, '{}')"],
  ['remote', "DELETE FROM domain_imports WHERE domain = 'remote'"],
] as const;
for (const cases of [MISSING_WITH_ROWS.slice(0, 2), MISSING_WITH_ROWS.slice(2)]) test(`an authority missing while its domain still has rows is refused before any domain write (${cases.map(([scope]) => scope).join(', ')}), a state-less domain included`, async t => {
  for (const [scope, damage] of cases) {
    const dir = await currentStore(t);
    sql(dir, damage);
    const before = dump(dir);
    const result = await start(dir);
    assert.deepEqual([result.refusal?.code, result.refusal?.scope, result.refusal?.state], ['authority-missing', scope, 'recovery-required'], JSON.stringify(result.refusal));
    onlyClaimed(before, dump(dir));
  }
});

/**
 * Every domain's legacy JSON sources and migration evidence, by the exact names server/storage/initialize.ts probes
 * (written out here, so a name dropped there fails here). A folder is made empty: being there is enough.
 */
const LEGACY_PATHS: [StorageDomainScope, string, 'file' | 'folder'][] = [
  ['runs', 'runs.json', 'file'], ['runs', 'created-sessions.json', 'file'], ['runs', 'run-instructions.json', 'file'], ['runs', 'runs-storage-migrations', 'folder'],
  ['retention', 'retention', 'folder'], ['retention', 'retention-observations.json', 'file'], ['retention', 'retention-cold', 'folder'],
  ['retention', 'retention-originals', 'folder'], ['retention', 'storage-migrations', 'folder'],
  ['triggers', 'trigger-engine.json', 'file'], ['triggers', 'triggers-storage-migrations', 'folder'],
  ['permissions', 'permissions.json', 'file'], ['permissions', 'permissions-storage-migrations', 'folder'], ['permissions', 'storage-permissions-pending.json', 'file'],
  ['remote', 'remote-requests.json', 'file'], ['remote', 'remote-storage-migrations', 'folder'],
  ['auto-prompt', 'auto-prompts.json', 'file'], ['auto-prompt', 'auto-prompt-storage-migrations', 'folder'],
  ['automation-workflows', 'slack-automation.json', 'file'], ['automation-workflows', 'github-automation.json', 'file'],
  ['automation-workflows', 'automation-workflows-storage-migrations', 'folder'],
];

test('a worker start with a missing authority while a legacy source is there is refused before any domain is created', async t => {
  const fresh = await stateDir(t);
  await (await currentStorage(fresh, { initialize: false })).close();
  await writeFile(join(fresh, 'runs.json'), '[]', { mode: 0o600 });
  const before = dump(fresh);
  const result = await start(fresh);
  assert.deepEqual([result.refusal?.code, result.refusal?.scope], ['legacy-source-present', 'runs']);
  assert.deepEqual(dump(fresh).domain_imports, [], 'no domain was created, the ones before runs included');
  onlyClaimed(before, dump(fresh));
});

test('a missing authority beside any domain\'s legacy source or migration evidence is refused with nothing written', async t => {
  assert.deepEqual([...new Set(LEGACY_PATHS.map(([scope]) => scope))], [...STORAGE_DOMAINS], 'every domain has its legacy paths here');
  // One prepared store without authorities; each case adds one legacy path, initializes once, and takes the path away.
  const fresh = await stateDir(t);
  const storage = await currentStorage(fresh, { initialize: false });
  try {
    for (const [scope, name, kind] of LEGACY_PATHS) {
      const path = join(fresh, name);
      if (kind === 'file') await writeFile(path, '[]', { mode: 0o600 });
      else await mkdir(path, { mode: 0o700 });
      const [before, kept] = [dump(fresh), await lstat(path)];
      await assert.rejects(initializeStorageDomains(storage, fresh),
        (error: unknown) => error instanceof StorageInitializationError && error.code === 'legacy-source-present' && error.scope === scope, name);
      assert.deepEqual(dump(fresh), before, `${name}: nothing was written, no domain before ${scope} included`);
      const after = await lstat(path);
      assert.deepEqual([after.ino, after.mtimeMs, kind === 'file' ? await readFile(path, 'utf8') : await readdir(path)], [kept.ino, kept.mtimeMs, kind === 'file' ? '[]' : []], `${name} is left as it was`);
      await rm(path, { recursive: true });
    }
  } finally { await storage.close(); }
});

for (const [code, scope, damage] of [
  ['stages-held', 'runs', `INSERT INTO runs_stages (intent, owner_epoch, bytes, sha256, chunks) VALUES ('stranded', 1, 1, '${'0'.repeat(64)}', 1)`],
  ['legacy-exported', 'remote', "UPDATE domain_imports SET authority = 'legacy-exported' WHERE domain = 'remote'"],
] as const) {
  test(`${code} (${scope}) is refused with nothing written`, async t => {
    const dir = await currentStore(t);
    sql(dir, damage);
    const before = dump(dir);
    const result = await start(dir);
    assert.deepEqual([result.refusal?.code, result.refusal?.scope, result.refusal?.state], [code, scope, 'recovery-required']);
    onlyClaimed(before, dump(dir));
  });
}

test('a missing database is refused before anything is opened where history or legacy sources say a storage existed', async t => {
  const cases: [string, (dir: string) => Promise<void>, string | undefined][] = [
    ['storage-contracts/', dir => mkdir(join(dir, 'storage-contracts'), { mode: 0o700 }).then(() => undefined), 'known-storage-missing'],
    ['storage-offline-activation.json', dir => writeFile(join(dir, 'storage-offline-activation.json'), '{}', { mode: 0o600 }), 'known-storage-missing'],
    ['a non-empty migration folder', async dir => { await mkdir(join(dir, 'remote-storage-migrations', 'x'), { recursive: true, mode: 0o700 }); }, 'known-storage-missing'],
    ['runs.json', dir => writeFile(join(dir, 'runs.json'), '[]', { mode: 0o600 }), 'migration-required'],
    ['an empty migration folder', async dir => { await mkdir(join(dir, 'runs-storage-migrations'), { mode: 0o700 }); }, undefined],
  ];
  for (const [name, seed, code] of cases) {
    const dir = await stateDir(t);
    await seed(dir);
    const before = await filesUnder(dir);
    const preflight = await preflightStorage({ bundle, stateDir: dir });
    assert.equal((await storagePreopenRefusal(dir, preflight))?.code, code, name);
    if (!code) continue;
    const result = await openWorkerStorage({ stateDir: dir, bundle, preflight });
    assert.equal(result.refusal?.code, code, name);
    assert.equal(result.database, undefined, `${name}: nothing was opened`);
    assert.deepEqual(await filesUnder(dir), before, `${name}: no database was created`);
  }
});

test('requireDomainAuthority holds a domain without its database authority; a stopped attempt claims nothing', async t => {
  const dir = await stateDir(t);
  const storage = await currentStorage(dir);
  try {
    for (const scope of STORAGE_DOMAINS) await requireDomainAuthority(storage, scope);
  } finally { await storage.close(); }
  sql(dir, "DELETE FROM domain_imports WHERE domain IN ('triggers', 'remote'); DELETE FROM remote_state");
  const reopened = await currentStorage(dir, { initialize: false });
  try {
    for (const scope of ['triggers', 'remote'] as const) {
      await assert.rejects(requireDomainAuthority(reopened, scope), (error: unknown) => error instanceof StorageInitializationError && error.code === 'authority-missing' && error.scope === scope);
    }
    // Triggers kept its state and settings row: refused. Remote holds nothing: created alone, once triggers is gone too.
    await assert.rejects(initializeStorageDomains(reopened, dir), (error: unknown) => error instanceof StorageInitializationError && error.code === 'authority-missing' && error.scope === 'triggers');
  } finally { await reopened.close(); }
  sql(dir, 'DELETE FROM triggers_rows; DELETE FROM triggers_state');
  const again = await currentStorage(dir, { initialize: false });
  try {
    assert.deepEqual(await initializeStorageDomains(again, dir), STORAGE_DOMAINS.map(scope => ({ scope, result: scope === 'triggers' || scope === 'remote' ? 'created' : 'present' })), 'empty domains without authority are created alone');
    for (const scope of STORAGE_DOMAINS) await requireDomainAuthority(again, scope);
    assert.equal((await again.inspect()).authority.find(entry => entry.domain === 'remote')?.generation, 1);
  } finally { await again.close(); }

  const stopped = await stateDir(t);
  let asked = 0;
  const result = await start(stopped, { proceed: () => asked++ < 1 });
  assert.equal(result.aborted, true);
  assert.equal(result.status?.schema?.kind, 'empty', 'stopped after the open: nothing was prepared');
  assert.equal(result.status?.ownerEpoch, undefined);
});
