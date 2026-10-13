import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindOf } from '../../../shared/errors.js';
import { SecretService } from '../../../server/secrets/service.js';
import { editPayload, legacyRecord, secretService } from '../../helpers/secrets.js';
import { SecretRuntime } from '../../../server/secrets/runtime.js';

const password = 'fixture-rule-edit-password-1234';

async function vault(t: { after: (fn: () => Promise<void>) => void }, now = () => Date.now()) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-secret-rule-edit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await secretService(directory, { password, now });
  const hostId = service.device().id; const project = await service.project({ name: 'fixture', bindings: [{ hostId, root: '/fixture' }] });
  const groupId = 'legacy-project-group';
  /** Keys saved before per-secret sharing, in a project group; only such keys take rules. */
  const legacy = async (...inputs: { name: string; value: string; kind?: 'scalar' | 'env'; expiresAt?: number }[]) => {
    const records = inputs.map(input => legacyRecord(hostId, { ...input, groupId }));
    await editPayload(service, password, payload => { if (!payload.groups.some(group => group.id === groupId)) payload.groups.push({ id: groupId, name: 'Project', scope: 'project', projectId: project.id }); payload.secrets.push(...records); });
    return records.map(record => record.metadata);
  };
  return { directory, service, hostId, project, legacy };
}
/** The rule exactly as the overview hands it to the editor, sent back unchanged. */
const unchanged = (service: SecretService, id: string) => { const { revision: _revision, ...rule } = service.overview().rules.find(rule => rule.id === id)!; return rule; };
const refusal = async (promise: Promise<unknown>, kind: string, message: string) => {
  await assert.rejects(promise, (error: Error) => { assert.equal(kindOf(error), kind); assert.equal(error.message, message); return true; });
};

test('removing a key drops it from every rule, so the rule still saves unchanged', async t => {
  const { service, hostId, project, legacy } = await vault(t);
  const [kept, removed] = await legacy({ name: 'kept', kind: 'env', value: 'A=1\nB=2' }, { name: 'removed', kind: 'env', value: 'C=3' });
  const rule = await service.setRule({ groupId: kept.groupId, secretIds: [kept.id, removed.id], hostId, projectId: project.id, activation: 'auto', operations: ['discover', 'env'], fields: { [kept.id]: ['A'], [removed.id]: ['C'] }, enabled: true });
  const lone = await service.setRule({ groupId: kept.groupId, secretIds: [removed.id], hostId, projectId: project.id, activation: 'manual', operations: ['env'], enabled: true });

  await service.remove(removed.id);
  const after = service.overview().rules;
  assert.deepEqual(after.find(item => item.id === rule.id)?.secretIds, [kept.id]);
  assert.deepEqual(after.find(item => item.id === rule.id)?.fields, { [kept.id]: ['A'] });
  assert.equal(after.find(item => item.id === rule.id)?.revision, rule.revision, 'narrowing a rule keeps grants of the remaining keys');
  assert.equal(after.some(item => item.id === lone.id), false, 'a rule with no key left is removed');
  const saved = await service.setRule(unchanged(service, rule.id));
  assert.equal(saved.revision, rule.revision + 1);
});

test('an expired key leaves its rules at the next sweep, so a rule that named only removed keys stops lingering', async t => {
  let now = Date.now(); const { service, hostId, project, legacy } = await vault(t, () => now);
  const [kept, expiring] = await legacy({ name: 'kept', value: 'k' }, { name: 'expiring', value: 'e', expiresAt: now + 1000 });
  const shared = await service.setRule({ groupId: kept.groupId, secretIds: [kept.id, expiring.id], hostId, projectId: project.id, activation: 'manual', operations: ['env'], enabled: true });
  const only = await service.setRule({ groupId: kept.groupId, secretIds: [expiring.id], hostId, projectId: project.id, activation: 'manual', operations: ['env'], enabled: true });
  now += 2000; await service.sweep(new Set());
  const rules = service.overview().rules;
  assert.deepEqual(rules.find(rule => rule.id === shared.id)?.secretIds, [kept.id]);
  assert.equal(rules.some(rule => rule.id === only.id), false);
});

test('a refused rule says which field is wrong', async t => {
  const { service, hostId, project, legacy } = await vault(t);
  const [secret] = await legacy({ name: 'token', kind: 'env', value: 'A=1' });
  const other = await service.project({ name: 'other', bindings: [{ hostId, root: '/other' }] });
  const base = { groupId: secret.groupId, secretIds: [secret.id], hostId, projectId: project.id, activation: 'manual' as const, operations: ['env' as const], enabled: true };
  await refusal(service.setRule({ ...base, secretIds: ['gone'] }), 'invalid', '공유할 키가 이 그룹에 없습니다. 키를 다시 선택하세요.');
  await refusal(service.setRule({ ...base, secretIds: [] }), 'invalid', '공유할 키가 이 그룹에 없습니다. 키를 다시 선택하세요.');
  await refusal(service.setRule({ ...base, maxTtlMs: 1.5 * 60_000 + 0.5 }), 'invalid', '작업 내 최대 사용 시간이 올바르지 않습니다.');
  await refusal(service.setRule({ ...base, projectId: other.id }), 'invalid', '프로젝트 그룹의 규칙은 그 그룹의 프로젝트에만 쓸 수 있습니다.');
  await refusal(service.setRule({ ...base, fields: { [secret.id]: ['MISSING'] } }), 'invalid', '선택한 필드가 키에 없거나 중복됩니다. 필드를 다시 선택하세요.');
  await refusal(service.setRule({ ...base, groupId: 'gone' }), 'invalid', '공유 규칙의 그룹을 찾을 수 없습니다.');
  await refusal(service.setRule({ ...base, id: 'gone' }), 'not-found', '수정할 공유 규칙을 찾을 수 없습니다. 화면을 새로고침하세요.');
  const shared = await service.create({ name: 'shared', kind: 'scalar', value: 'v' });
  await refusal(service.setRule({ ...base, groupId: shared.groupId, secretIds: [shared.id], projectId: undefined, root: '/fixture' }), 'invalid', '공유 범위로 관리하는 키는 규칙에 넣을 수 없습니다. 키의 공유 범위를 편집하세요.');
});

test('the owner rule action reports malformed input and a locked Vault distinctly', async t => {
  const { directory, service, hostId, project, legacy } = await vault(t);
  const [secret] = await legacy({ name: 'token', value: 'v' });
  const runs = { list: () => [], getSession: () => undefined, sessionOrigin: () => undefined };
  const runtime = new SecretRuntime({ stateDir: directory, service, runs: runs as never }); t.after(() => runtime.close());
  const rule = { groupId: secret.groupId, secretIds: [secret.id], hostId, projectId: project.id, activation: 'manual', operations: ['env'], enabled: true };
  await refusal(runtime.control('rule', { ...rule, maxTtlMs: 90_000.5 }), 'invalid', '작업 내 최대 사용 시간이 올바르지 않습니다.');
  await refusal(runtime.control('rule', { ...rule, operations: 'env' }), 'invalid', '공유 규칙 입력 형식이 올바르지 않습니다.');
  await service.lock();
  await refusal(runtime.control('rule', rule), 'locked', '시크릿 보관함이 잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.');
});
