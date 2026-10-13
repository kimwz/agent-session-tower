import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { kindOf } from '../../../shared/errors.js';
import type { SecretRule } from '../../../shared/secrets.js';
import { editPayload, legacyRecord, legacyRule, secretService, stored } from '../../helpers/secrets.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';

const password = 'fixture-rule-edit-password-1234';

async function vault(t: { after: (fn: () => Promise<void>) => void }, now = () => Date.now()) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-secret-rule-edit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await secretService(directory, { password, now });
  const hostId = service.device().id; const project = { id: randomUUID(), name: 'fixture', bindings: [{ hostId, root: '/fixture' }] };
  const groupId = 'legacy-project-group';
  /** Keys and rules as builds before per-secret sharing saved them, in a project group. */
  const legacy = async (inputs: { name: string; value: string; kind?: 'scalar' | 'env'; expiresAt?: number }[], rules: (ids: string[]) => SecretRule[]) => {
    const records = inputs.map(input => legacyRecord(hostId, { ...input, groupId }));
    const written = rules(records.map(record => record.metadata.id));
    await editPayload(service, payload => {
      payload.projects.push(project); payload.groups.push({ id: groupId, name: 'Project', scope: 'project', projectId: project.id });
      payload.secrets.push(...records); payload.rules.push(...written);
    });
    return { ids: records.map(record => record.metadata.id), rules: written };
  };
  return { directory, service, hostId, project, groupId, legacy };
}
const refusal = async (promise: Promise<unknown>, kind: string, message: string) => {
  await assert.rejects(promise, (error: Error) => { assert.equal(kindOf(error), kind); assert.equal(error.message, message); return true; });
};

test('removing a key drops it from every rule, keeping each rule’s revision, and a rule naming only it goes', async t => {
  const { service, hostId, project, groupId, legacy } = await vault(t);
  const { ids: [kept, removed], rules: [rule, lone] } = await legacy([{ name: 'kept', kind: 'env', value: 'A=1\nB=2' }, { name: 'removed', kind: 'env', value: 'C=3' }], ([kept, removed]) => [
    legacyRule({ groupId, secretIds: [kept!, removed!], hostId, projectId: project.id, activation: 'auto', operations: ['discover', 'env'], fields: { [kept!]: ['A'], [removed!]: ['C'] } }),
    legacyRule({ groupId, secretIds: [removed!], hostId, projectId: project.id, operations: ['env'] })]);
  await service.remove(removed!);
  const after = stored(service).rules;
  assert.deepEqual(after.find(item => item.id === rule!.id)?.secretIds, [kept]);
  assert.deepEqual(after.find(item => item.id === rule!.id)?.fields, { [kept!]: ['A'] });
  assert.equal(after.find(item => item.id === rule!.id)?.revision, rule!.revision);
  assert.equal(after.some(item => item.id === lone!.id), false, 'a rule with no key left is removed');
});

test('an expired key leaves its rules at the next sweep, so a rule that named only removed keys stops lingering', async t => {
  let now = Date.now(); const { service, hostId, project, groupId, legacy } = await vault(t, () => now);
  const { ids: [kept], rules: [shared, only] } = await legacy([{ name: 'kept', value: 'k' }, { name: 'expiring', value: 'e', expiresAt: now + 1000 }], ([kept, expiring]) => [
    legacyRule({ groupId, secretIds: [kept!, expiring!], hostId, projectId: project.id, operations: ['env'] }),
    legacyRule({ groupId, secretIds: [expiring!], hostId, projectId: project.id, operations: ['env'] })]);
  now += 2000; await service.sweep(new Set());
  const rules = stored(service).rules;
  assert.deepEqual(rules.find(rule => rule.id === shared!.id)?.secretIds, [kept]);
  assert.equal(rules.some(rule => rule.id === only!.id), false);
});

test('the owner page no longer edits rules, projects or task connections; changes report malformed input and a locked vault distinctly', async t => {
  const { directory, service } = await vault(t);
  const runtime = new SecretRuntime({ stateDir: directory, service, runs: { list: () => [], getSession: () => undefined, sessionOrigin: () => undefined } }); t.after(() => runtime.close());
  for (const action of ['overview', 'rule', 'project', 'attach', 'connect', 'revoke', 'end-task']) await refusal(runtime.control(action, { sessionId: 'codex:fixture', secretIds: ['x'] }), 'not-found', '알 수 없는 시크릿 작업입니다.');
  const secret = await service.create({ name: 'token', kind: 'scalar', value: 'v' });
  await refusal(runtime.control('sharing', { secretId: secret.id, revision: 'one', global: true, folders: [] }), 'invalid', '시크릿 입력이 올바르지 않습니다.');
  await refusal(runtime.control('sharing', { secretId: secret.id, revision: 1, global: true, folders: [{ cwd: '/fixture' }] }), 'invalid', '시크릿 입력이 올바르지 않습니다.');
  await service.lock();
  await refusal(runtime.control('sharing', { secretId: secret.id, revision: 1, global: true, folders: [] }), 'locked', '시크릿 보관함이 잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.');
  await refusal(runtime.control('create', { name: 'another', kind: 'scalar', value: 'v' }), 'locked', '시크릿 보관함이 잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.');
});
