import { constants } from 'node:fs';
import { lstat, readdir, realpath, open, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { validateStrictStateLease, type StrictStateLease } from '../instance/state-lock.js';
import { fileSha256, readStorageIdentity, readSnapshot, recordRecoveryBarrier, activateRecoveryBarrier, type KnownStorageEvidence } from '../storage/recovery.js';
import { privateDirectory, privateFile, proveDurable, sameGeneration, storageFs, storageLayout, writePrivateDocument } from '../storage/paths.js';
import type { StorageBuildContext } from '../storage/bundle.js';

const held: (reason: string) => never = reason => { throw new Error(`Offline backup held: ${reason}`); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const documents = ['runs.json', 'created-sessions.json', 'run-instructions.json', 'trigger-engine.json', 'permissions.json',
  'remote-requests.json', 'remote-exclusions.json', 'retention/journal.json', 'retention-observations.json',
  'auto-prompts.json', 'slack-automation.json', 'github-automation.json', 'storage-offline-activation.json', 'storage-permissions-pending.json'] as const;
const trees = ['storage-contracts', 'storage-migrations', 'runs-storage-migrations', 'triggers-storage-migrations',
  'permissions-storage-migrations', 'remote-storage-migrations', 'auto-prompt-storage-migrations', 'automation-workflows-storage-migrations', 'storage-snapshots', 'storage-recovery'] as const;
const databases = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm'] as const;
export interface OfflineInventoryEntry { name: string; kind: 'absent' | 'directory' | 'file'; sha256?: string; bytes?: number }
export interface OfflineFullBackup {
  format: 'tower-offline-full-backup'; version: 1; stateDir: string; storageId: string; snapshotId: string;
  entries: OfflineInventoryEntry[];
}
export interface OfflineBackupDescriptor { root: string; manifest: { path: string; sha256: string }; snapshotId: string }

function boundary(root: string, name: string): string {
  const path = resolve(root, name);
  if (!name || relative(root, path) !== name || name.split('/').includes('..')) held('path boundary');
  return path;
}
async function directory(path: string, create = false): Promise<boolean> {
  const absolute = resolve(path);
  if (await realpath(dirname(absolute)) !== dirname(absolute)) held('linked parent');
  return privateDirectory(absolute, create);
}
function treeFile(root: string, name: string): boolean {
  const tail = name.slice(root.length + 1);
  if (root === 'storage-contracts') return /^[a-z][a-z0-9-]{0,47}\.json$/.test(tail);
  if (root === 'storage-recovery' && /^[\w-]+\/offline-originals\//.test(tail)) {
    const original = tail.split('/').slice(2).join('/');
    return documents.includes(original as typeof documents[number]) || trees.some(tree => tree !== 'storage-recovery' && tree !== 'storage-snapshots' && original.startsWith(`${tree}/`) && treeFile(tree,original));
  }
  if (root === 'storage-recovery') return ['identity.json', 'barrier.json'].includes(tail) || /^[\w-]+\/source\/state\.sqlite(?:-wal|-shm)?$/.test(tail);
  if (root === 'storage-snapshots') return /^[\w-]+\/(snapshot\.db|manifest\.json)$/.test(tail);
  return /^[\w-]+\/(manifest\.json|rows\.ndjson|runs\.json|created-sessions\.json|run-instructions\.json|trigger-engine\.json|permissions\.json|remote-requests\.json|auto-prompts\.json|slack-automation\.json|github-automation\.json|journal\.json|retention-observations\.json)$/.test(tail);
}
/** Only named product roots are visited. Unexpected files inside an evidence root refuse, never broaden the backup. */
export async function offlineInventory(stateDir: string): Promise<OfflineInventoryEntry[]> {
  const entries: OfflineInventoryEntry[] = [];
  const visit = async (name: string, tree?: string): Promise<void> => {
    const path = boundary(stateDir, name);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) { entries.push({ name, kind: 'absent' }); return; }
    if (info.isDirectory()) {
      if (!tree || name.split('/').length > (tree === 'storage-recovery' ? 6 : 3)) held('unexpected directory');
      await directory(path);
      entries.push({ name, kind: 'directory' });
      for (const child of (await readdir(path)).sort()) await visit(`${name}/${child}`, tree);
      return;
    }
    if (tree && !treeFile(tree, name)) held(`unregistered evidence file ${name}`);
    const before = await privateFile(path);
    if (!before) held('file disappeared');
    const sha256 = await fileSha256(path);
    const after = await privateFile(path);
    if (!after || !sameGeneration(before, after)) held('file changed during hash');
    entries.push({ name, kind: 'file', sha256, bytes: before.size });
  };
  await directory(stateDir);
  if (await lstat(join(stateDir, 'state.sqlite-journal')).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; })) held('unexpected rollback journal');
  for (const name of [...databases, ...documents]) {
    if (name.includes('/')) {
      const parent = join(stateDir, dirname(name));
      if (await lstat(parent).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; })) await directory(parent);
    }
    await visit(name);
  }
  for (const name of trees) await visit(name, name);
  return entries;
}
async function folders(root: string, name: string): Promise<void> {
  let current = root;
  for (const part of dirname(name).split('/')) {
    if (part === '.') continue;
    current = join(current, part); await directory(current, true);
  }
}
export async function collectOfflineBackup(input: { stateDir: string; root: string; snapshotId: string; lease: StrictStateLease }): Promise<OfflineBackupDescriptor> {
  const stateDir = resolve(input.stateDir), root = resolve(input.root);
  await validateStrictStateLease(input.lease, join(stateDir, 'runner-runtime'));
  if (root === stateDir || !relative(stateDir, root).startsWith('..')) held('backup must be outside live state');
  // Caller closes the sole snapshot SDK before this file phase. Its verified snapshot includes the WAL.
  const snapshot = await readSnapshot(stateDir, input.snapshotId);
  const identity = await readStorageIdentity(await storageLayout(stateDir));
  if (identity.state !== 'present' || identity.identity.state !== 'created' || identity.identity.storageId !== snapshot.storageId) held('storage identity');
  if (await lstat(root).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; })) held('backup root already exists');
  await directory(root, true);
  const entries = await offlineInventory(stateDir);
  for (const entry of entries) {
    if (entry.kind === 'absent') continue;
    await folders(root, entry.name);
    const to = boundary(root, entry.name);
    if (entry.kind === 'directory') await directory(to, true);
    else {
      await storageFs.copyFile(boundary(stateDir, entry.name), to);
      await storageFs.syncDirectory(dirname(to));
      if (await fileSha256(to) !== entry.sha256 || (await privateFile(to))?.size !== entry.bytes) held('copy readback');
    }
  }
  if (!same(entries, await offlineInventory(stateDir))) held('source changed during backup');
  await validateStrictStateLease(input.lease, join(stateDir, 'runner-runtime'));
  const manifest = join(root, 'manifest.json');
  await writePrivateDocument(manifest, JSON.stringify({ format: 'tower-offline-full-backup', version: 1, stateDir, storageId: snapshot.storageId, snapshotId: snapshot.id, entries } satisfies OfflineFullBackup));
  const descriptor={ root, manifest: { path: manifest, sha256: await fileSha256(manifest) }, snapshotId: snapshot.id };
  await verifyOfflineBackup(descriptor,stateDir,snapshot.storageId,true);
  return descriptor;
}
export async function verifyOfflineBackup(descriptor: OfflineBackupDescriptor, stateDir: string, storageId: string, compareLive = false): Promise<OfflineFullBackup> {
  if (resolve(descriptor.root) !== descriptor.root || descriptor.manifest.path !== join(descriptor.root, 'manifest.json')) held('manifest boundary');
  await directory(descriptor.root);
  const before = await privateFile(descriptor.manifest.path);
  if (!before || before.size > 64 * 1024 * 1024 || await fileSha256(descriptor.manifest.path) !== descriptor.manifest.sha256) held('manifest hash');
  const file = await open(descriptor.manifest.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest: OfflineFullBackup;
  try { manifest = JSON.parse(await file.readFile('utf8')) as OfflineFullBackup; } finally { await file.close(); }
  if (!sameGeneration(before, (await privateFile(descriptor.manifest.path))!) || manifest.format !== 'tower-offline-full-backup' || manifest.version !== 1
    || manifest.stateDir !== resolve(stateDir) || manifest.storageId !== storageId || manifest.snapshotId !== descriptor.snapshotId || !Array.isArray(manifest.entries)) held('manifest identity');
  if (!same(manifest.entries, await offlineInventory(descriptor.root))) held('full inventory mismatch');
  if (compareLive && !same(manifest.entries, await offlineInventory(stateDir))) held('live inventory mismatch');
  const paths=new Set(manifest.entries.filter(e=>e.kind!=='absent').map(e=>boundary(descriptor.root,e.name)));
  paths.add(descriptor.manifest.path);
  for(const path of [...paths]) for(let parent=dirname(path); parent!==dirname(descriptor.root) && parent.startsWith(`${descriptor.root}/`); parent=dirname(parent)) paths.add(parent);
  const durable=[...paths].sort((a,b)=>b.split('/').length-a.split('/').length);
  await proveDurable([...durable,descriptor.root]);
  const snapshot = await readSnapshot(descriptor.root, descriptor.snapshotId);
  if (snapshot.storageId !== storageId) held('snapshot identity');
  return manifest;
}
/** Restore remains held. A fresh historical barrier is durable BEFORE any domain/SQL restoration. */
export async function restoreOfflineBackup(input: { descriptor: OfflineBackupDescriptor; stateDir: string; storageId: string; lease: StrictStateLease; context: StorageBuildContext; known: KnownStorageEvidence }): Promise<{ barrierId: string; state: 'held' }> {
  const { stateDir, descriptor } = input;
  await validateStrictStateLease(input.lease, join(stateDir, 'runner-runtime'));
  const manifest = await verifyOfflineBackup(descriptor, stateDir, input.storageId);
  const layout = await storageLayout(stateDir);
  await privateDirectory(layout.snapshotsDir, true);
  const snapshotDir = join(layout.snapshotsDir, descriptor.snapshotId);
  await privateDirectory(snapshotDir, true);
  for (const name of ['snapshot.db', 'manifest.json']) {
    const target = join(snapshotDir, name), source = join(descriptor.root, 'storage-snapshots', descriptor.snapshotId, name);
    if (await privateFile(target)) { if (await fileSha256(target) !== await fileSha256(source)) held('existing snapshot differs'); }
    else { await storageFs.copyFile(source, target); await storageFs.syncDirectory(snapshotDir); }
  }
  const barrier = await recordRecoveryBarrier(stateDir, { snapshotId: descriptor.snapshotId, reason: 'Explicit full offline backup restore; effects require independent reconciliation.', context: input.context, known: input.known });
  await activateRecoveryBarrier(stateDir, barrier.id);
  // Preserve every original outside SQL as well; never overwrite the new barrier with backed-up metadata.
  const preserved = join(layout.recoveryDir, barrier.id, 'offline-originals');
  await privateDirectory(preserved, true);
  const current = await offlineInventory(stateDir);
  for (const entry of current) {
    if (entry.kind !== 'file' || databases.includes(entry.name as typeof databases[number]) || entry.name.startsWith('storage-recovery/') || entry.name.startsWith('storage-snapshots/')) continue;
    const desired=manifest.entries.find(e=>e.name===entry.name);
    if(desired?.kind==='file' && desired.sha256===entry.sha256) continue;
    const source = boundary(stateDir, entry.name), saved = boundary(preserved, entry.name);
    await folders(preserved, entry.name);
    if (!await privateFile(saved)) { await storageFs.copyFile(source, saved); await storageFs.syncDirectory(dirname(saved)); }
    if (await fileSha256(saved) !== entry.sha256 || await fileSha256(source) !== entry.sha256) held('restore original changed/readback');
    await unlink(source); await storageFs.syncDirectory(dirname(source));
  }
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file' || databases.includes(entry.name as typeof databases[number]) || entry.name.startsWith('storage-recovery/') || entry.name.startsWith('storage-snapshots/')) continue;
    await folders(stateDir, entry.name);
    const target = boundary(stateDir, entry.name);
    if(await privateFile(target)) { if(await fileSha256(target)===entry.sha256) continue; held('restore target changed'); }
    await storageFs.copyFile(boundary(descriptor.root, entry.name), target);
    await storageFs.syncDirectory(dirname(target));
    if (await fileSha256(target) !== entry.sha256) held('restore readback');
  }
  for(const entry of [...current].reverse()) {
    if(entry.kind!=='directory' || entry.name.startsWith('storage-recovery') || entry.name.startsWith('storage-snapshots') || manifest.entries.some(e=>e.name===entry.name && e.kind==='directory')) continue;
    await rmdir(boundary(stateDir,entry.name)); await storageFs.syncDirectory(dirname(boundary(stateDir,entry.name)));
  }
  await validateStrictStateLease(input.lease, join(stateDir, 'runner-runtime'));
  return { barrierId: barrier.id, state: 'held' };
}
