import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../../server/secrets/service.js';
import { SecretVault } from '../../../server/secrets/vault.js';
import { encrypt, passwordKey } from '../../../server/secrets/crypto.js';
import { stageVaultImport } from '../../../server/secrets/imports.js';
import { SecretVault1130 } from './fixtures/vault-995f869.js';

const recovery = 'fixture-password-1234';
const tower = 'tower-password-1234';
const [idA, idB, idC, idD] = ['a', 'b', 'c', 'd'].map(digit => digit.repeat(64));
interface Wrapper { credentialId: string; salt: string; wrappedKey: unknown }
interface Envelope { vaultId: string; salt: string; wrappedKey: unknown; tower?: { wrappers: Wrapper[] } }

async function fixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `tower-wrapper-${name}-`));
  const service = new SecretService({ stateDir: directory }); await service.start(); await service.initialize(recovery);
  const path = join(directory, 'secrets', 'vault.json');
  return { directory, service, envelope: async () => JSON.parse(await readFile(path, 'utf8')) as Envelope, write: (envelope: Envelope) => writeFile(path, JSON.stringify(envelope)), cleanup: () => rm(directory, { recursive: true, force: true }) };
}
async function started(directory: string) { const service = new SecretService({ stateDir: directory }); await service.start(); return service; }

test('a Tower password wrapper opens only for its own credential, and an open vault is only checked against it', async () => {
  const f = await fixture('open');
  try {
    const device = f.service.device().id;
    await f.service.towerWrap(tower, idA);
    assert.equal(f.service.vault.hasTower(idA), true); assert.equal(f.service.vault.hasTower(idB), false);
    let generation = f.service.vault.lockGeneration;
    assert.equal(await f.service.towerUnlock(tower, idA), false, 'an open vault is verified, not reopened');
    await assert.rejects(f.service.towerUnlock(recovery, idA), /Cannot unlock vault/);
    assert.equal(f.service.status().locked, false); assert.equal(f.service.vault.lockGeneration, generation);
    await f.service.lock(); assert.notEqual(f.service.vault.lockGeneration, generation); generation = f.service.vault.lockGeneration;
    await assert.rejects(f.service.towerUnlock(tower, idB), /Cannot unlock vault/, 'no wrapper of another credential is tried');
    await assert.rejects(f.service.towerUnlock('wrong-password-1234', idA), /Cannot unlock vault/);
    assert.equal(f.service.status().locked, true);
    assert.equal(await f.service.towerUnlock(tower, idA), true); assert.equal(f.service.device().id, device);
    assert.notEqual(f.service.vault.lockGeneration, generation, 'an open locks the previous key first');

    // The credential and the purpose are both bound by the AAD.
    const envelope = await f.envelope(); const [wrapper] = envelope.tower!.wrappers;
    await f.write({ ...envelope, tower: { wrappers: [{ ...wrapper, credentialId: idB }] } });
    const relabeled = new SecretVault(f.directory); await relabeled.start(); assert.equal(relabeled.hasTower(idB), true);
    await assert.rejects(relabeled.unlockTower(tower, idB), /Cannot unlock vault/);
    await f.write({ ...envelope, salt: wrapper.salt, wrappedKey: wrapper.wrappedKey });
    const swapped = new SecretVault(f.directory); await swapped.start(); await assert.rejects(swapped.unlock(tower), /Cannot unlock vault/);

    // A wrapper with the right AAD opens only if it unwraps the open key.
    const carry = f.service.handoff()!; const key = Buffer.from(JSON.parse(carry.toString()).key, 'base64');
    const salt = randomBytes(16).toString('base64'); const derived = await passwordKey(tower, salt);
    const aad = (id: string) => `tower-secrets:1:${envelope.vaultId}:tower-key:${id}`;
    await f.write({ ...envelope, tower: { wrappers: [{ credentialId: idC, salt, wrappedKey: encrypt(derived, randomBytes(32), aad(idC)) }, { credentialId: idD, salt, wrappedKey: encrypt(derived, key, aad(idD)) }] } });
    const open = await started(f.directory); await open.adopt(carry); generation = open.vault.lockGeneration;
    assert.equal(await open.towerUnlock(tower, idD), false);
    await assert.rejects(open.towerUnlock(tower, idC), /Cannot unlock vault/);
    assert.equal(open.status().locked, false); assert.equal(open.vault.lockGeneration, generation);
  } finally { await f.cleanup(); }
});

test('at most two Tower password wrappers; prune keeps only the current one and needs no key', async () => {
  const f = await fixture('limit');
  try {
    await assert.rejects(f.service.towerWrap(tower, 'not-a-credential'), /Invalid credential ID/);
    await f.service.towerWrap(tower, idA); await f.service.towerWrap('next-tower-password-1234', idB);
    await assert.rejects(f.service.towerWrap(tower, idC), /Too many Tower password wrappers/);
    const before = (await f.envelope()).tower!.wrappers.find(item => item.credentialId === idA)!;
    await f.service.towerWrap(tower, idA);
    const replaced = (await f.envelope()).tower!.wrappers;
    assert.deepEqual(replaced.map(item => item.credentialId).sort(), [idA, idB]); assert.notEqual(replaced.find(item => item.credentialId === idA)!.salt, before.salt);
    await f.service.lock();
    await assert.rejects(f.service.towerWrap(tower, idA), /Vault locked/);
    await f.service.towerPrune(idB);
    assert.deepEqual((await f.envelope()).tower!.wrappers.map(item => item.credentialId), [idB]);
    const restarted = await started(f.directory);
    assert.notEqual(restarted.vault.index, undefined, 'wrapper writes leave the name index of the last save valid');
    assert.equal(restarted.vault.hasTower(idA), false); assert.equal(restarted.vault.hasTower(idB), true);
    assert.equal(await restarted.towerUnlock('next-tower-password-1234', idB), true);
    await restarted.towerPrune(idC);
    assert.equal('tower' in await f.envelope(), false, 'no wrappers leave the envelope as older builds wrote it');
  } finally { await f.cleanup(); }
});

test('saves, vault password changes, restarts, handoffs and imports keep the Tower wrappers and the vault password', async () => {
  const f = await fixture('compat');
  try {
    const device = f.service.device().id;
    await f.service.towerWrap(tower, idA); const wrappers = (await f.envelope()).tower;
    // Older builds save and change the vault password through these same `{ ...envelope }` paths.
    await f.service.flush(); assert.deepEqual((await f.envelope()).tower, wrappers);
    await f.service.changePassword(recovery, 'changed-password-1234'); assert.deepEqual((await f.envelope()).tower, wrappers);
    const successor = await started(f.directory); await successor.adopt(f.service.handoff()!);
    assert.equal(successor.vault.hasTower(idA), true); assert.notEqual(successor.vault.lockGeneration, f.service.vault.lockGeneration);
    const restarted = await started(f.directory);
    await assert.rejects(restarted.unlock(recovery));
    await restarted.unlock('changed-password-1234'); assert.equal(restarted.device().id, device);
    await restarted.lock(); assert.equal(await restarted.towerUnlock(tower, idA), true);
    const bytes = await readFile(join(f.directory, 'secrets', 'vault.json'));
    assert.match(await stageVaultImport(f.directory, bytes.toString('base64')), /^[a-f0-9-]{36}$/);
    assert.equal((await restarted.vault.decryptImport(bytes, 'changed-password-1234') as { device: { id: string } }).device.id, device);
  } finally { await f.cleanup(); }
});

test('malformed Tower wrappers are ignored with a warning; the vault password opens and a new wrapper replaces them', async context => {
  const f = await fixture('malformed');
  try {
    await f.write({ ...await f.envelope(), tower: { wrappers: 'broken' as unknown as Wrapper[] } });
    const warn = context.mock.method(console, 'warn', () => undefined);
    const restarted = await started(f.directory);
    assert.equal(warn.mock.calls.length, 1); assert.match(String(warn.mock.calls[0].arguments[0]), /malformed Tower password wrappers/);
    assert.equal(restarted.vault.hasTower(idA), false);
    await restarted.unlock(recovery); await restarted.towerWrap(tower, idA);
    assert.deepEqual((await f.envelope()).tower!.wrappers.map(item => item.credentialId), [idA]);
  } finally { await f.cleanup(); }
});

test('a vault saved and re-passworded by 1.130.2 keeps its Tower password wrappers: new, old and new again', async () => {
  const f = await fixture('frozen');
  try {
    const kept = await f.service.create({ name: 'kept by every build', kind: 'scalar', value: 'FROZEN_ROUND_TRIP' });
    await f.service.towerWrap(tower, idA); const wrappers = (await f.envelope()).tower;
    // The older build opens, saves and changes the vault password through its own `{ ...envelope }` paths.
    const old = new SecretVault1130(f.directory); await old.start();
    const payload = await old.unlock(recovery) as { secrets: { metadata: { id: string; name: string } }[] };
    payload.secrets.find(secret => secret.metadata.id === kept.id)!.metadata.name = 'renamed by 1.130.2';
    await old.save(payload, await old.journal(), old.index);
    await old.changePassword(recovery, 'changed-by-1130-password');
    assert.deepEqual((await f.envelope()).tower, wrappers);
    // This build reads what the older one wrote: its change, its vault password, and the Tower password wrapper.
    const restarted = await started(f.directory);
    assert.equal(restarted.vault.hasTower(idA), true);
    assert.equal(await restarted.towerUnlock(tower, idA), true);
    assert.equal(restarted.settings().secrets.find(secret => secret.id === kept.id)?.name, 'renamed by 1.130.2');
    await restarted.lock(); await restarted.unlock('changed-by-1130-password');
    assert.equal(await restarted.towerUnlock(tower, idA), false, 'the wrapper unwraps the key the older build kept');
  } finally { await f.cleanup(); }
});

test('Tower password wrappers requested while a save is paused between its files wait for it: payload and wrappers both survive a restart', async () => {
  const f = await fixture('barrier');
  try {
    await f.service.towerWrap('previous-tower-password', idB);
    // The save writes the journal, then pauses before vault.json until released.
    const vault = f.service.vault as unknown as { write(name: string, bytes: Buffer): Promise<void> };
    const write = vault.write.bind(vault); let reached!: () => void; let release!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    vault.write = async (name, bytes) => { if (name === 'vault.json' && !held) { held = true; reached(); await gate; } return write(name, bytes); };
    // Entry spies: an unserialized wrap or prune would enter the vault at once, before its key derivation could hide it.
    const entered: string[] = [];
    const spied = f.service.vault as unknown as Record<'towerWrap' | 'towerPrune', (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['towerWrap', 'towerPrune'] as const) { const original = spied[name].bind(spied); spied[name] = (...args) => { entered.push(name); return original(...args); }; }
    const saving = f.service.create({ name: 'saved across the barrier', kind: 'scalar', value: 'BARRIER_PAYLOAD' });
    await paused;
    const wrapping = f.service.towerWrap(tower, idA); const pruning = f.service.towerPrune(idA);
    assert.deepEqual(entered, [], 'neither entered the vault while the save was paused');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(entered, [], 'nor once the event loop turned');
    assert.deepEqual((await f.envelope()).tower!.wrappers.map(item => item.credentialId), [idB], 'nothing was written while the save was paused');
    release();
    const saved = await saving; await wrapping; await pruning;
    assert.deepEqual(entered, ['towerWrap', 'towerPrune'], 'each in its turn, after the save');
    assert.deepEqual((await f.envelope()).tower!.wrappers.map(item => item.credentialId), [idA]);
    const restarted = await started(f.directory);
    assert.equal(await restarted.towerUnlock(tower, idA), true);
    assert.equal(restarted.settings().secrets.find(secret => secret.id === saved.id)?.name, 'saved across the barrier');
    await restarted.lock(); await restarted.unlock(recovery);
    assert.equal(restarted.settings().secrets.some(secret => secret.id === saved.id), true);
  } finally { await f.cleanup(); }
});
