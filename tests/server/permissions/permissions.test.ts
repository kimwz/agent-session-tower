import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CapabilityRegistry, handleMcpRequest, type McpContext } from '../../../server/api/mcp.js';
import { TowerApi } from '../../../server/api/tower-api.js';
import { CODEX_HEADER, syncCodex } from '../../../server/permissions/native.js';
import { noStorageFixture, permissionFixture, closePermissionFixture } from './storage-fixture.js';
import { PermissionService } from '../../../server/permissions/service.js';
import { TriggerService } from '../../../server/triggers/service.js';
import { claudeRule, codexRule, ruleIsBroad, ruleProblem } from '../../../shared/permissions.js';
import type { PermissionOverview } from '../../../shared/permissions.js';
import type { Run } from '../../../shared/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function fixture(t: TestContext, effectGate?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'tower-permissions-'));
  const stateDir = join(root, 'state');
  const codexHome = join(root, 'codex-home');
  const project = join(root, 'project');
  await mkdir(project);
  git(project, 'init', '-q');
  const sessions = new Map([['claude:one', { cwd: project, provider: 'claude' as const }], ['codex:two', { cwd: project, provider: 'codex' as const }]]);
  const resumed: Array<{ sessionId: string; prompt: string }> = [];
  const make = () => new PermissionService({ stateDir, repository:noStorageFixture(stateDir), effectGate, env: { CODEX_HOME: codexHome }, session: id => sessions.get(id),
    resume: async (sessionId, prompt) => { if (sessionId === 'gone') throw new Error('Session not found.'); resumed.push({ sessionId, prompt }); } });
  const service = make();
  await service.start();
  t.after(async () => { service.close(); closePermissionFixture(stateDir); await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, codexHome, project, sessions, service, make, resumed };
}
const agent = (sessionId: string, runId = 'run-1') => ({ kind: 'agent', via: 'mcp', sessionId, runId });

test('a command prefix becomes one rule for both providers; shell syntax and malformed Claude rules are refused', () => {
  const rule = { kind: 'command' as const, value: '  gh   pr merge ' };
  assert.equal(claudeRule(rule), 'Bash(gh pr merge *)');
  assert.equal(codexRule(rule), 'prefix_rule(pattern=["gh", "pr", "merge"], decision="allow")');
  const base = { providers: ['claude' as const], scope: 'global' as const };
  for (const value of ['gh pr merge; rm -rf ~', 'git push *', 'echo "x"', 'a | b', 'cat > f', '$(id)', '']) assert.ok(ruleProblem({ ...base, kind: 'command', value }), value);
  assert.equal(ruleProblem({ ...base, kind: 'command', value: 'npm run test' }), undefined);
  assert.equal(ruleProblem({ ...base, kind: 'claude', value: 'WebFetch(domain:example.com)' }), undefined);
  assert.ok(ruleProblem({ ...base, kind: 'claude', value: 'Bash(x)\nBash(y)' }));
  assert.ok(ruleProblem({ kind: 'claude', value: 'WebFetch(domain:example.com)', providers: ['codex'], scope: 'global' }), 'a Claude rule is Claude only');
  assert.ok(ruleProblem({ kind: 'command', value: 'ls', providers: ['claude'], scope: 'project' }), 'a project rule needs its folder');
  assert.ok(ruleIsBroad({ kind: 'command', value: 'git' }) && ruleIsBroad({ kind: 'command', value: 'python3 script.py' }) && ruleIsBroad({ kind: 'command', value: 'npm run' }));
  assert.ok(!ruleIsBroad({ kind: 'command', value: 'gh pr merge' }) && !ruleIsBroad({ kind: 'command', value: 'npm run test' }));
  assert.ok(ruleIsBroad({ kind: 'claude', value: 'WebFetch' }) && !ruleIsBroad({ kind: 'claude', value: 'WebFetch(domain:example.com)' }));
});

test('Claude turns get every project’s rules and their own project’s as settings; Codex reads Tower’s own rules files', async t => {
  const f = await fixture(t);
  await f.service.save({ kind: 'command', value: 'gh pr merge', providers: ['claude', 'codex'], scope: 'global' });
  await f.service.save({ kind: 'command', value: 'npm run deploy', providers: ['claude', 'codex'], scope: 'project', cwd: f.project });
  await f.service.save({ kind: 'claude', value: 'WebFetch(domain:example.com)', providers: ['claude'], scope: 'project', cwd: f.project });
  assert.deepEqual(JSON.parse(f.service.claudeSettings(join(f.project, 'packages', 'app'))!), { permissions: { allow: ['Bash(gh pr merge *)', 'Bash(npm run deploy *)', 'WebFetch(domain:example.com)'] } });
  assert.deepEqual(JSON.parse(f.service.claudeSettings(`${f.project}-other`)!), { permissions: { allow: ['Bash(gh pr merge *)'] } }, 'a sibling folder with the same prefix is another project');
  assert.equal(await readFile(join(f.codexHome, 'rules', 'tower.rules'), 'utf8'), `${CODEX_HEADER}\nprefix_rule(pattern=["gh", "pr", "merge"], decision="allow")\n`);
  const projectRules = join(f.project, '.codex', 'rules', 'tower.rules');
  assert.equal(await readFile(projectRules, 'utf8'), `${CODEX_HEADER}\nprefix_rule(pattern=["npm", "run", "deploy"], decision="allow")\n`);
  assert.match(await readFile(join(f.project, '.git', 'info', 'exclude'), 'utf8'), /^\/\.codex\/rules\/tower\.rules$/m);
  assert.equal(git(f.project, 'status', '--porcelain'), '', 'the project rules file stays out of the repository');
  // Deleting the last project rule removes Tower's file; the global one stays.
  const overview = f.service.overview(f.project);
  for (const rule of overview.rules.filter(rule => rule.scope === 'project')) await f.service.remove(rule.id);
  await assert.rejects(readFile(projectRules, 'utf8'), { code: 'ENOENT' });
  assert.equal(f.service.claudeSettings(f.project), JSON.stringify({ permissions: { allow: ['Bash(gh pr merge *)'] } }));
  assert.equal(f.service.claudeSettings('/elsewhere') !== undefined, true);
});

test('Tower never replaces a rules file it did not write, a tracked one, or one behind a linked folder', async t => {
  const f = await fixture(t);
  const foreign = join(f.codexHome, 'rules', 'tower.rules');
  await mkdir(join(f.codexHome, 'rules'), { recursive: true });
  await writeFile(foreign, 'prefix_rule(pattern=["mine"], decision="allow")\n');
  await f.service.save({ kind: 'command', value: 'gh pr merge', providers: ['codex'], scope: 'global' });
  assert.equal(await readFile(foreign, 'utf8'), 'prefix_rule(pattern=["mine"], decision="allow")\n');
  assert.match(f.service.overview().targets.find(target => target.path === foreign)!.error!, /Tower가 만든 파일이 아니라서/);

  // A tracked project file is neither changed nor removed.
  const tracked = join(f.project, '.codex', 'rules', 'tower.rules');
  await mkdir(join(f.project, '.codex', 'rules'), { recursive: true });
  await writeFile(tracked, `${CODEX_HEADER}\n`);
  git(f.project, 'add', '.codex/rules/tower.rules');
  await assert.rejects(syncCodex(tracked, ['prefix_rule(pattern=["x"], decision="allow")'], f.project), /git에 커밋되어/);
  await assert.rejects(syncCodex(tracked, [], f.project), /git에 커밋되어/);
  assert.equal(await readFile(tracked, 'utf8'), `${CODEX_HEADER}\n`);

  // A project whose .codex links to the home folder cannot reach the global rules file, not even to remove it.
  const linked = join(f.root, 'linked');
  await mkdir(linked);
  await symlink(f.codexHome, join(linked, '.codex'));
  const home = join(f.codexHome, 'rules', 'tower.rules');
  await writeFile(home, `${CODEX_HEADER}\nprefix_rule(pattern=["keep"], decision="allow")\n`);
  await assert.rejects(syncCodex(join(linked, '.codex', 'rules', 'tower.rules'), [], linked), /심볼릭 링크/);
  await assert.rejects(syncCodex(join(linked, '.codex', 'rules', 'tower.rules'), ['prefix_rule(pattern=["x"], decision="allow")'], linked), /심볼릭 링크/);
  assert.match(await readFile(home, 'utf8'), /keep/);
});

test('an agent asks once; the owner allows it as edited, and the requesting conversation hears the decision', async t => {
  const f = await fixture(t);
  const asked = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge the reviewed PR' }, agent('claude:one'));
  assert.equal(asked.request.status, 'pending');
  const again = await f.service.request({ kind: 'command', value: 'gh  pr merge', scope: 'project', reason: 'again' }, agent('claude:one', 'run-2'));
  assert.equal((again.request as { id: string }).id, (asked.request as { id: string }).id, 'the same pending request is not repeated');
  const request = f.service.overview().requests[0];
  assert.deepEqual(request.rule, { kind: 'command', value: 'gh pr merge', providers: ['claude'], scope: 'project', cwd: f.project }, 'the asking provider and folder are recorded');
  assert.equal(f.service.overview().pending, 1);

  const decided = await f.service.decide(request.id, true, { kind: 'command', value: 'gh pr merge', providers: ['claude', 'codex'], scope: 'global' }, true);
  assert.deepEqual(decided.resumed, { sent: true });
  assert.equal(decided.pending, 0);
  assert.deepEqual(decided.rules.map(rule => [rule.value, rule.scope, rule.source]), [['gh pr merge', 'global', 'request']]);
  assert.equal(f.resumed[0].sessionId, 'claude:one');
  assert.match(f.resumed[0].prompt, /allowed `gh pr merge` for Claude Code and Codex in every project \(you asked for `gh pr merge` in this project\)/);
  await assert.rejects(f.service.decide(request.id, false), /이미 처리한/);
  const exists = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'x' }, agent('claude:one'));
  assert.equal(exists.request.status, 'exists');
  assert.deepEqual(f.service.forAgent(agent('claude:one')).requests.map(item => item.status), ['approved']);

  const refused = await f.service.request({ kind: 'command', value: 'terraform apply', scope: 'project', reason: 'x' }, agent('codex:two'));
  const denied = await f.service.decide((refused.request as { id: string }).id, false, undefined, true);
  assert.equal(denied.rules.length, 1, 'a refusal adds nothing');
  assert.match(f.resumed[1].prompt, /refused .*`terraform apply`/);
});

test('requests need a Tower conversation on this computer; the pending list is bounded; state survives a restart', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.request({ kind: 'command', value: 'ls', scope: 'project', reason: 'x' }, { kind: 'agent', sessionId: 'unknown' }), /Tower에서 시작한 대화/);
  await assert.rejects(f.service.request({ kind: 'command', value: 'ls', scope: 'project', reason: 'x' }, { ...agent('claude:one'), controllerId: 'c' }), /다른 컴퓨터/);
  for (let index = 0; index < 50; index++) await f.service.request({ kind: 'command', value: `tool${index} run`, scope: 'project', reason: 'x' }, agent('claude:one'));
  await assert.rejects(f.service.request({ kind: 'command', value: 'one more', scope: 'project', reason: 'x' }, agent('claude:one')), /너무 많습니다/);
  f.service.close();
  const again = f.make();
  await again.start();
  t.after(() => again.close());
  assert.equal(again.pending(), 50);
});

test('a corrupt SQL row is refused without empty fallback or modifying native rules', async t => {
  const f=await fixture(t);
  await f.service.save({ kind:'command',value:'git status',providers:['codex'],scope:'global' });
  const native=join(f.codexHome,'rules','tower.rules'), before=await readFile(native);
  f.service.close();
  permissionFixture(f.stateDir).db.prepare('UPDATE permission_rules SET json=?').run('{ broken');
  const again=f.make(); await assert.rejects(again.start());
  assert.deepEqual(await readFile(native),before);
  assert.equal(permissionFixture(f.stateDir).db.prepare('SELECT json FROM permission_rules').get()!.json,'{ broken');
});

test('agents reach permissions only through their own keyed requests; owner-only operations stay with the owner', async t => {
  const f = await fixture(t);
  const runs: Run[] = [];
  const triggers = new TriggerService({ stateDir: f.stateDir, tickMs: 60_000, executor: { submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); }, enqueue: async () => { throw new Error('unused'); }, runs: () => runs, session: () => undefined } });
  await triggers.start();
  t.after(() => triggers.close());
  const api = new TowerApi({ stateDir: f.stateDir, triggers, runs: { list: () => runs }, permissions: f.service });
  const capabilities = new CapabilityRegistry();
  const context: McpContext = { api, capabilities, run: runId => runs.find(run => run.id === runId) };
  const run: Run = { id: randomUUID(), sessionId: 'claude:one', prompt: '', status: 'running', createdAt: '', output: '', origin: { kind: 'owner' }, towerTools: 'attached' };
  runs.push(run);
  const token = capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: run.sessionId });
  const { tools } = await handleMcpRequest(context, token, { method: 'tools/list' }) as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> };
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('permissions_request') && names.includes('permissions_list'));
  assert.ok(!names.some(name => ['permissions_decide', 'permissions_save', 'permissions_delete', 'permissions_overview'].includes(name)));
  assert.ok(tools.find(tool => tool.name === 'permissions_request')!.inputSchema.required!.includes('requestKey'));
  const call = (name: string, args: Record<string, unknown>) => handleMcpRequest(context, token, { method: 'tools/call', name, arguments: args });
  const first = await call('permissions_request', { requestKey: 'merge-1', kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge PR 4' });
  assert.deepEqual(await call('permissions_request', { requestKey: 'merge-1', kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge PR 4' }), first);
  await assert.rejects(call('permissions_decide', { requestKey: 'x', id: randomUUID(), approve: true }), /Unknown Tower tool|Only the owner/);
  await assert.rejects(api.call('permissions.decide', { id: randomUUID(), approve: true }, { kind: 'agent', via: 'mcp', sessionId: 'claude:one' }), /Only the owner/);
  const listed = await call('permissions_list', {}) as { requests: Array<{ status: string }> };
  assert.deepEqual(listed.requests.map(item => item.status), ['pending']);
  const overview = await api.call('permissions.overview', {}, { kind: 'owner', via: 'ui' }) as PermissionOverview;
  assert.equal(overview.pending, 1);
  await assert.rejects(api.call('permissions.overview', {}, { kind: 'owner', via: 'remote', controllerId: 'other' }), /on that computer itself/);
});

test('a project folder that is, or links to, the Codex home\'s parent never gets project rules in the file for every project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-permissions-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, '.codex', 'rules'), { recursive: true });
  const global = join(home, '.codex', 'rules', 'tower.rules');
  await writeFile(global, 'prefix_rule(pattern=["keep"], decision="allow")\n');
  await symlink(home, join(root, 'alias'));
  const service = new PermissionService({ stateDir: join(root, 'state'), repository:noStorageFixture(join(root,'state')), env: { CODEX_HOME: join(home, '.codex') }, session: () => undefined });
  await service.start();
  t.after(() => { service.close(); closePermissionFixture(join(root,'state')); });
  for (const cwd of [home, join(root, 'alias')]) {
    await assert.rejects(service.save({ kind: 'command', value: 'terraform apply', providers: ['codex'], scope: 'project', cwd }), /모든 프로젝트용 파일과 같습니다/);
    await assert.rejects(syncCodex(join(cwd, '.codex', 'rules', 'tower.rules'), [], cwd, global), /같은 파일이라서/);
  }
  assert.match(await readFile(global, 'utf8'), /keep/);
});

test('review fixes: unreadable characters, one request per conversation, cleanup after a lost record, no widening, one global writer', async t => {
  const base = { kind: 'command' as const, providers: ['codex' as const], scope: 'global' as const };
  for (const value of ['git\ud800', 'git\u0001', 'gh​pr']) assert.match(ruleProblem({ ...base, value })!, /제어 문자/);
  assert.equal(ruleProblem({ ...base, value: 'gh pr merge' }), undefined);

  const f = await fixture(t);
  const claude = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'x' }, agent('claude:one'));
  const codex = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'x' }, agent('codex:two'));
  assert.notEqual((codex.request as { id: string }).id, (claude.request as { id: string }).id, 'each conversation hears its own decision');
  assert.deepEqual(f.service.overview().requests.map(request => request.rule.providers), [['codex'], ['claude']]);

  // Import rejects malformed scope records; an existing SQL authority never consults stale JSON.
  await f.service.save({ kind: 'command', value: 'terraform plan', providers: ['codex'], scope: 'global' });
  const global=join(f.codexHome,'rules','tower.rules');
  await mkdir(f.stateDir,{ recursive:true });
  await writeFile(join(f.stateDir,'permissions.json'),JSON.stringify({ version:1,rules:[{ id:'x',kind:'command',value:'ls',providers:['claude'],scope:'project' }],requests:[],codex:[] }));
  f.service.close(); const again=f.make(); await again.start(); await again.bootstrapEffects(new Set());
  t.after(()=>again.close());
  assert.match(await readFile(global,'utf8'),/terraform/);
  assert.equal(again.overview().rules.length,1,'SQL authority does not normalize or drop its records using stale JSON');
  await again.remove(again.overview().rules[0].id);
  // A second Tower (not on the default state folder) never writes the file for every project.
  const other = new PermissionService({ stateDir: join(f.root, 'other-state'), repository:noStorageFixture(join(f.root,'other-state')), env: { CODEX_HOME: f.codexHome }, session: () => undefined, globalCodex: false });
  await other.start();
  t.after(() => { other.close(); closePermissionFixture(join(f.root,'other-state')); });
  const saved = await other.save({ kind: 'command', value: 'make build', providers: ['codex'], scope: 'global' });
  await assert.rejects(readFile(global, 'utf8'), { code: 'ENOENT' });
  assert.match(saved.targets.find(target => target.scope === 'global')!.error!, /기본 상태 폴더/);
});

test('editing a rule an approval made saves the rule, never decides the finished request again', async () => {
  const { ruleDraft } = await import('../../../client/src/permissions/PermissionsPanel.js');
  const draft = ruleDraft({ id: 'r1', kind: 'command', value: 'gh pr merge', providers: ['claude'], scope: 'global', requestId: 'q1', source: 'request', createdAt: '', updatedAt: '' } as never);
  assert.deepEqual(draft, { id: 'r1', kind: 'command', value: 'gh pr merge', providers: ['claude'], scope: 'global' });
});


test('decision opt-in is durable; recovery applies rules before recording a request-aware notification', async t => {
  const f = await fixture(t); await f.service.flush(); f.service.close();
  let fail = true; const notified: string[] = [];
  const make = () => new PermissionService({ stateDir: f.stateDir, repository:noStorageFixture(f.stateDir), env: { CODEX_HOME: f.codexHome }, session: id => f.sessions.get(id),
    decision: async request => { if (fail) throw new Error('Fixture enqueue unavailable'); notified.push(request.id); } });
  const service = make(); await service.start(); await service.flush();
  const first = (await service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', providers: ['claude'], reason: 'Fixture' }, agent('claude:one'))).request!;
  const result = await service.decide(first.id!, true, undefined, true);
  assert.ok(result.resumed && 'error' in result.resumed);
  assert.equal(service.overview().requests.find(item => item.id === first.id)?.notification?.state, 'pending');
  const second = (await service.request({ kind: 'command', value: 'gh pr view', scope: 'project', providers: ['claude'], reason: 'Fixture' }, agent('claude:one'))).request!;
  await service.decide(second.id!, true, undefined, false);
  assert.equal(service.overview().requests.find(item => item.id === second.id)?.notification, undefined);
  await service.flush(); service.close(); fail = false;
  const restored = make(); await restored.start(); await restored.reconcileNotifications();
  assert.deepEqual(notified, [first.id]);
  assert.equal(restored.overview().requests.find(item => item.id === first.id)?.notification?.state, 'recorded');
  await restored.reconcileNotifications(); assert.deepEqual(notified, [first.id]); restored.close();
});


test('permission writes queued before pause recheck the hold after the awaited effect gate', async t => {
  let gate = async () => {};
  const f = await fixture(t, () => gate());
  await f.service.reconcileNotifications();
  await f.service.save({ kind: 'command', value: 'git status', providers: ['codex'], scope: 'global' });
  const paths = [join(f.codexHome, 'rules', 'tower.rules')];
  const durableBefore=await noStorageFixture(f.stateDir).load();
  const before = await Promise.all(paths.map(path => readFile(path)));
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  gate = async () => { reached(); await held; };
  const first = f.service.save({ kind: 'command', value: 'git diff', providers: ['codex'], scope: 'global' });
  const second = f.service.save({ kind: 'command', value: 'git log', providers: ['codex'], scope: 'global' });
  const rejected = [first, second].map(work => assert.rejects(work, { kind: 'unavailable' }));
  await entered; f.service.pause(); release(); await Promise.all(rejected);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
  assert.deepEqual(await noStorageFixture(f.stateDir).load(),durableBefore);
  f.service.resume(); gate = async () => {};
  await f.service.save({ kind: 'command', value: 'git diff', providers: ['codex'], scope: 'global' });
  assert.match(await readFile(paths[0], 'utf8'), /"diff"/);
});

test('a hold between permission commit and native apply leaves native rules untouched and can reconcile later', async t => {
  let gate = async () => {};
  const f = await fixture(t, () => gate());
  await f.service.reconcileNotifications();
  await f.service.save({ kind: 'command', value: 'git status', providers: ['codex'], scope: 'global' });
  const native = join(f.codexHome, 'rules', 'tower.rules'); const before = await readFile(native);
  let calls = 0;
  gate = async () => { if (++calls === 2) f.service.pause(); };
  await f.service.save({ kind: 'command', value: 'git diff', providers: ['codex'], scope: 'global' });
  assert.deepEqual(await readFile(native), before);
  assert.ok(f.service.overview().targets.some(target => target.error), 'native application reports the hold');
  assert.ok(f.service.overview().rules.some(rule => rule.value === 'git diff'), 'the prior committed owner decision is preserved');
  f.service.resume(); gate = async () => {};
  await f.service.reconcileNotifications();
  assert.match(await readFile(native, 'utf8'), /"diff"/);
});


test('held permission service preserves only an already running command completion and its notification', async t => {
  const f = await fixture(t);
  const asked = await f.service.requestRun({ command: 'echo fixture', reason: 'completion fixture' }, agent('claude:one'));
  await f.service.decide(asked.request.id, true, undefined, true);
  await f.service.updateRun(asked.request.id, { status: 'running', startedAt: '2026-09-30T00:00:00.000Z' });
  f.service.pause();
  await f.service.updateRun(asked.request.id, { status: 'done', exitCode: 7, finishedAt: '2026-09-30T00:00:01.000Z', preview: { stdout: 'out', stderr: 'err' }, stdoutBytes: 3, stderrBytes: 3 });
  const result = f.service.overview().requests.find(item => item.id === asked.request.id)!.run!;
  assert.equal(result.exitCode, 7); assert.deepEqual(result.preview, { stdout: 'out', stderr: 'err' });
  assert.equal(result.notify, true); assert.equal(f.service.untoldRuns().length, 1);
  await assert.rejects(f.service.updateRun(asked.request.id, { status: 'running' }), { kind: 'unavailable' });
  await assert.rejects(f.service.requestRun({ command: 'echo new', reason: 'held' }, agent('claude:one')), { kind: 'unavailable' });
  const persisted = await noStorageFixture(f.stateDir).load();
  assert.equal(persisted.requests.find((item: { id: string }) => item.id === asked.request.id)!.run!.exitCode, 7);
});
