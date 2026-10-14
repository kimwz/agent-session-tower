/**
 * Makes vault-sharing-v2.json, an encrypted `secrets/vault.json` (the `secretVault` part of a backup) in the per-secret
 * sharing format: keys shared with all machines (GLOBAL in the committed file, made by 1.131), to folders of this computer
 * and a node, unshared, edited from rules, and one still following its rule, so later builds keep importing it. A
 * temporary value is made too and must stay out. Run from this
 * repository, never against personal state:
 *
 *   node --import tsx tests/server/backup/fixtures/make-sharing-vault.ts tests/server/backup/fixtures/vault-sharing-v2.json
 *
 * Values and the password are the fixed test ones below.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProject, editPayload, legacyRecord, legacyRule, secretService } from '../../../helpers/secrets.ts';

export const SHARING_VAULT_PASSWORD = 'fixture vault password 1';
const NODE = '7b0c4a52-2f6e-4f5a-9d1e-3c8b6a4f2e10';

const [out] = process.argv.slice(2);
if (!out) throw new Error('usage: make-sharing-vault.ts <out file>');
const stateDir = await mkdtemp(join(tmpdir(), 'tower-sharing-vault-fixture-'));
try {
  const service = await secretService(stateDir, { password: SHARING_VAULT_PASSWORD });
  const host = service.device().id;
  await service.trustPeer({ device: { ...service.device(), id: NODE, name: 'Fixture node' }, routeId: 'fixture-node', direction: 'node', enabled: true });
  await service.create({ name: 'global-token', kind: 'scalar', value: 'FIXTURE_GLOBAL_VALUE', sharing: { allMachines: true, folders: [] } });
  await service.create({ name: 'folder-env', kind: 'env', value: 'TOKEN=FIXTURE_FOLDER_VALUE\n', sharing: { allMachines: false, folders: [{ hostId: host, root: '/fixture/project' }, { hostId: NODE, root: '/fixture/node' }] } });
  await service.create({ name: 'unshared-file', kind: 'file', content: Buffer.from('FIXTURE_FILE_VALUE').toString('base64') });
  const project = await addProject(service, { id: 'fixture-project', name: 'fixture', bindings: [{ hostId: host, root: '/fixture/project' }] });
  const ruled = legacyRecord(host, { name: 'ruled-token', groupId: 'fixture-project-group', value: 'FIXTURE_RULED_VALUE' });
  const edited = legacyRecord(host, { name: 'edited-token', groupId: 'fixture-project-group', value: 'FIXTURE_EDITED_VALUE' });
  await editPayload(service, payload => {
    payload.groups.push({ id: 'fixture-project-group', name: 'Project', scope: 'project', projectId: project.id }); payload.secrets.push(ruled, edited);
    payload.rules.push(legacyRule({ groupId: 'fixture-project-group', secretIds: [ruled.metadata.id, edited.metadata.id], hostId: host, projectId: project.id, activation: 'auto' }));
  });
  await service.setSharing(edited.metadata.id, 0, { allMachines: false, folders: [{ hostId: host, root: '/fixture/project' }] });
  await service.create({ name: 'temporary', kind: 'scalar', value: 'FIXTURE_TEMPORARY_VALUE', temporary: true }, await service.ensureTask('fixture-session', '/fixture/project'));
  await writeFile(out, (await service.exportEncryptedVault())!);
  await service.lock();
  console.log(JSON.stringify({ out }));
} finally { await rm(stateDir, { recursive: true, force: true }); }
