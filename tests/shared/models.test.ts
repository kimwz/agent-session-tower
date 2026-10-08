import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_ROLES, masterWorkerModel, customRoleLines, initialModelSettings, modelArgs, parseModelSettings, resolveRole, type ModelSettings } from '../../shared/models.js';

test('heartbeat inherits the whole master role dynamically; explicit empty picks are CLI defaults', () => {
  const settings = parseModelSettings({ version: 1, roles: {}, custom: [] });
  settings.roles['master.session'] = { provider: 'codex', claude: { model: 'opus' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } };
  assert.deepEqual(resolveRole(settings, 'master.heartbeat', { provider: 'claude' }), { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  settings.roles['master.session'].codex.effort = 'low';
  assert.equal(resolveRole(settings, 'master.heartbeat').effort, 'low');
  settings.roles['master.heartbeat'] = { provider: 'codex', claude: {}, codex: {} };
  const saved = parseModelSettings(settings, true);
  assert.deepEqual(resolveRole(saved, 'master.heartbeat'), { provider: 'codex' });
  assert.deepEqual(modelArgs(resolveRole(saved, 'master.heartbeat')), []);
  const { 'master.heartbeat': _omitted, ...oldRoles } = saved.roles;
  assert.deepEqual(parseModelSettings({ roles: oldRoles, custom: [] }, true, saved).roles['master.heartbeat'], saved.roles['master.heartbeat']);
});

test('every role starts with what its call used before the roles existed', () => {
  const settings = initialModelSettings();
  const table = (provider?: 'claude' | 'codex') => Object.fromEntries(BUILTIN_ROLES.map(role => [role.id, resolveRole(settings, role.id, { provider })]));
  // Judgments on the provider of their work: Opus for Claude work, GPT-5.6 Sol for Codex work, no effort.
  const follow = ['autoPrompt.router', 'slack.match', 'slack.replyIntent', 'slack.replyDraft', 'slack.toneGuide', 'github.replyIntent', 'publicAgents.judge'];
  for (const id of follow) {
    assert.deepEqual(table('claude')[id], { provider: 'claude', model: 'opus' }, id);
    assert.deepEqual(table('codex')[id], { provider: 'codex', model: 'gpt-5.6-sol' }, id);
  }
  assert.deepEqual(table()['permissions.reviewer'], { provider: 'claude', model: 'opus' });
  assert.deepEqual(table()['skills.advisor'], { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(resolveRole(settings, 'skills.advisor', { provider: 'codex' }), { provider: 'claude', model: 'sonnet' }, 'a fixed role ignores the work provider');
  assert.deepEqual(table()['voice.firstReply'], { provider: 'claude', model: 'haiku', effort: 'off' });
  // New with the role: a light model without thinking, since it runs after every turn.
  assert.deepEqual(table()['sessions.summarizer'], { provider: 'claude', model: 'haiku', effort: 'off' });
  // New with compaction, which the owner asked to run on Claude Haiku 5.5 by its pinned ID, with the model's own effort.
  assert.deepEqual(table()['sessions.compactor'], { provider: 'claude', model: 'claude-haiku-5-5' });
  assert.deepEqual(resolveRole(settings, 'sessions.compactor', { provider: 'codex' }), { provider: 'claude', model: 'claude-haiku-5-5' });
  // Forms and starts that passed no model keep the CLI's default, on the provider each form preselected.
  for (const id of ['master.session', 'issues.register', 'chat.new', 'autoPrompt.new', 'publicAgents.new']) assert.deepEqual(table()[id], { provider: 'claude' }, id);
  for (const id of ['triggers.new', 'slack.newRule', 'github.newRule']) assert.deepEqual(table()[id], { provider: 'codex' }, id);
  assert.deepEqual(table()['master.heartbeat'], table()['master.session']);
  assert.equal(BUILTIN_ROLES.length, follow.length + 15, 'a new role gets a line here');
});

test('saved settings are read leniently, submitted ones strictly', () => {
  const saved = { version: 1, roles: { 'slack.match': { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol', effort: 'high' } }, 'voice.firstReply': { provider: 'codex', claude: {}, codex: {} } },
    custom: [{ id: 'review.codex', provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol', effort: 'high' } }, { id: 'bad id', provider: 'codex', claude: {}, codex: {} }] };
  const read = parseModelSettings(saved);
  assert.deepEqual(resolveRole(read, 'slack.match', { provider: 'claude' }), { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(resolveRole(read, 'voice.firstReply'), { provider: 'claude', model: 'haiku', effort: 'off' }, 'the voice reply is Claude only; an invalid entry falls back');
  assert.deepEqual(read.custom.map(role => role.id), ['review.codex']);
  assert.throws(() => parseModelSettings(saved, true), /Claude|제공자|역할/);
  const fine: ModelSettings = { ...initialModelSettings(), custom: [{ id: 'review.claude', label: 'PR 리뷰', provider: 'claude', claude: { model: 'fable', effort: 'max' }, codex: {} }] };
  assert.deepEqual(parseModelSettings(fine, true), fine);
  for (const bad of [
    { ...fine, custom: [{ ...fine.custom[0], id: 'autoPrompt.router' }] },
    { ...fine, custom: [fine.custom[0], fine.custom[0]] },
    { ...fine, custom: [{ ...fine.custom[0], claude: { model: '--dangerously-skip-permissions' } }] },
    { ...fine, custom: [{ ...fine.custom[0], claude: { effort: 'ultra' } }] },
    { ...fine, custom: [{ ...fine.custom[0], provider: 'codex', codex: { effort: 'off' } }] },
    { ...fine, roles: { ...fine.roles, 'chat.new': { provider: 'claude', claude: { effort: 'off' }, codex: {} } } },
    { ...fine, custom: [{ ...fine.custom[0], claude: { effort: 'off' } }] },
  ]) assert.throws(() => parseModelSettings(bad, true), { kind: 'invalid' }, JSON.stringify(bad.custom));
});

test('a role gives the same model as flags, as JSON and in the turn table', () => {
  const settings: ModelSettings = { ...initialModelSettings(), custom: [
    { id: 'review.codex', provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol', effort: 'high' } },
    { id: 'review.claude', label: 'validity check', provider: 'claude', claude: { model: 'fable' }, codex: {} },
  ] };
  assert.deepEqual(modelArgs(resolveRole(settings, 'review.codex')), ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high']);
  assert.deepEqual(modelArgs(resolveRole(settings, 'review.claude')), ['--model', 'fable']);
  assert.deepEqual(modelArgs({ provider: 'claude', model: 'opus', effort: 'max' }), ['--model', 'opus', '--effort', 'max']);
  assert.deepEqual(modelArgs({ provider: 'claude', model: 'haiku', effort: 'off' }), ['--model', 'haiku']);
  assert.deepEqual(customRoleLines(settings), ['- review.codex = codex / gpt-6.1-sol / high', '- review.claude = claude / fable / default — validity check']);
  assert.throws(() => resolveRole(settings, 'review.gemini'), { kind: 'not-found' });
});

test('a save keeps roles it does not name and ignores roles this version does not know', () => {
  const current = initialModelSettings();
  current.roles['slack.match'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol' } };
  const { 'slack.match': _left, ...others } = current.roles;
  const saved = parseModelSettings({ version: 1, roles: { ...others, 'future.role': { provider: 'claude', claude: {}, codex: {} } }, custom: [] }, true, current);
  assert.deepEqual(saved.roles['slack.match'], current.roles['slack.match']);
  assert.equal((saved.roles as Record<string, unknown>)['future.role'], undefined);
});


test('master.worker selects defaults per explicit provider and preserves each explicit field', () => {
  const settings = initialModelSettings();
  assert.deepEqual(resolveRole(settings, 'master.worker'), { provider: 'codex', model: 'gpt-6.1-sol' });
  settings.roles['master.worker'] = { provider: 'claude', claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'low' } };
  assert.deepEqual(masterWorkerModel(settings), { provider: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(masterWorkerModel(settings, { provider: 'codex' }), { provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  assert.deepEqual(masterWorkerModel(settings, { provider: 'codex', model: 'chosen', effort: 'xhigh' }), { provider: 'codex', model: 'chosen', effort: 'xhigh' });
  assert.deepEqual(masterWorkerModel(settings, { model: 'chosen' }), { provider: 'claude', model: 'chosen', effort: 'high' });
  assert.deepEqual(masterWorkerModel(settings, { effort: 'medium' }), { provider: 'claude', model: 'sonnet', effort: 'medium' });
});

test('legacy master.worker custom settings migrate once and old pages cannot overwrite the built-in role', () => {
  const custom = { id: 'master.worker', provider: 'codex' as const, claude: {}, codex: { model: 'legacy-worker', effort: 'high' } };
  const reviewer = { id: 'reviewer.codex', provider: 'codex' as const, claude: {}, codex: { model: 'review-model' } };
  const legacy = { version: 1, roles: {}, custom: [custom, reviewer] };
  const migrated = parseModelSettings(legacy);
  assert.deepEqual(resolveRole(migrated, 'master.worker'), { provider: 'codex', model: 'legacy-worker', effort: 'high' });
  assert.deepEqual(migrated.custom, [reviewer]);
  migrated.roles['master.worker'].codex = { model: 'new-choice' };
  const oldPageSave = parseModelSettings(legacy, true, migrated);
  assert.deepEqual(resolveRole(oldPageSave, 'master.worker'), { provider: 'codex', model: 'new-choice' });
  assert.deepEqual(oldPageSave.custom, [reviewer]);
  const both = parseModelSettings({ ...legacy, roles: migrated.roles });
  assert.equal(resolveRole(both, 'master.worker').model, 'new-choice');
});
