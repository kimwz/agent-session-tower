import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CapabilityRegistry, handleMcpRequest, type McpContext } from '../../../server/api/mcp.js';
import { TowerApi } from '../../../server/api/tower-api.js';
import type { Backend } from '../../../server/http/server.js';
import type { RequestContext } from '../../../server/http/request-context.js';
import { reviewInput, type ReviewSources } from '../../../server/permissions/context.js';
import { NOT_FOLLOWED, PermissionService } from '../../../server/permissions/service.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import { createRemoteRouter } from '../../../server/remote/router.js';
import { TriggerService } from '../../../server/triggers/service.js';
import { ruleGuards, type PermissionOverview, type PermissionRequest } from '../../../shared/permissions.js';
import type { Run } from '../../../shared/types.js';
import { apiTriggerStorageFixture } from '../api/trigger-storage-fixture.js';
import { closePermissionFixture, noStorageFixture } from './storage-fixture.js';

const HOST = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const REPOSITORY = 'github.com/owner/shop';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const agent = (sessionId: string, runId = 'run-1') => ({ kind: 'agent', via: 'mcp', sessionId, runId });
/** A time-ordered request ID, as a controlling Tower's page sends one. */
const requestId = () => { const hex = Date.now().toString(16).padStart(12, '0') + randomBytes(10).toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };

/** One Tower's permissions: its own folders, which repository each is a clone of, and which controller it follows. */
async function tower(t: TestContext, name: string, folders: Record<string, string | undefined>) {
  const root = await mkdtemp(join(tmpdir(), `tower-follow-${name}-`));
  const stateDir = join(root, 'state');
  const codexHome = join(root, 'codex-home');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const paths: Record<string, string> = {};
  for (const folder of Object.keys(folders)) { paths[folder] = join(root, folder); await mkdir(paths[folder]); git(paths[folder], 'init', '-q'); }
  const repositories = new Map(Object.entries(folders).map(([folder, url]) => [paths[folder]!, url]));
  const sessions = new Map<string, { cwd: string; provider: 'claude' | 'codex' }>();
  let followed: string | undefined;
  let reviews = 0;
  let lookups = 0;
  /** Runs while a folder's repository is looked up, as a change made meanwhile would. */
  let meanwhile: (() => void) | undefined;
  /** Runs at each wait for storage before an effect, with how many there were since it was set. */
  let atEffect: ((count: number) => void) | undefined;
  let effects = 0;
  const service = new PermissionService({ stateDir, repository: noStorageFixture(stateDir), env: { CODEX_HOME: codexHome }, session: id => sessions.get(id), effectGate: async () => { effects += 1; atEffect?.(effects); },
    followedHost: async () => followed, remoteUrl: async cwd => { lookups += 1; meanwhile?.(); return repositories.get(cwd); }, onReviewQueued: () => { reviews += 1; } });
  await service.start();
  t.after(async () => { service.close(); closePermissionFixture(stateDir); await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, codexHome, paths, sessions, service, follow: (id: string | undefined) => { followed = id; }, followed: () => followed, reviews: () => reviews, lookups: () => lookups,
    point: (folder: string, url: string | undefined) => { repositories.set(paths[folder]!, url); }, meanwhile: (change: (() => void) | undefined) => { meanwhile = change; },
    atEffect: (change: ((count: number) => void) | undefined) => { effects = 0; atEffect = change; },
    /** The same computer started again: a new service over the same state. */
    restart: async () => {
      const again = new PermissionService({ stateDir, repository: noStorageFixture(stateDir), env: { CODEX_HOME: codexHome }, session: id => sessions.get(id), followedHost: async () => followed, remoteUrl: async cwd => repositories.get(cwd) });
      await again.start();
      t.after(() => again.close());
      return again;
    } };
}

/** A Tower API over `service`, with the trigger store it needs, for agents' tools and remote pages. */
async function apiFor(t: TestContext, f: Awaited<ReturnType<typeof tower>>, runs: Run[]) {
  const { storage } = await apiTriggerStorageFixture(t, f.stateDir);
  const triggers = new TriggerService({ storage, stateDir: f.stateDir, tickMs: 60_000, executor: { submitAutoPrompt: async () => { throw new Error('unused'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('unused'); }, enqueue: async () => { throw new Error('unused'); }, runs: () => runs, session: () => undefined } });
  await triggers.start();
  t.after(() => triggers.close());
  return new TowerApi({ stateDir: f.stateDir, triggers, runs: { list: () => runs }, permissions: f.service, followedHost: async () => f.followed() });
}

test('work the followed host starts asks for permissions here as the owner’s own and is reviewed; any other controller is refused and shown how to unblock (744bfd56)', async t => {
  const f = await tower(t, 'node', { project: REPOSITORY });
  f.sessions.set('claude:one', { cwd: f.paths.project!, provider: 'claude' });
  f.follow(HOST);
  await f.service.saveAutoReview({ enabled: true, resume: true });
  const runs: Run[] = [];
  const api = await apiFor(t, f, runs);
  const capabilities = new CapabilityRegistry();
  const context: McpContext = { api, capabilities, run: id => runs.find(run => run.id === id) };
  const turn = (controllerId: string) => {
    const run: Run = { id: randomUUID(), sessionId: 'claude:one', prompt: '', status: 'running', createdAt: '', output: '', origin: { kind: 'owner', controllerId }, towerTools: 'attached' };
    runs.push(run);
    const token = capabilities.issue({ kind: 'owner-run', runId: run.id, sessionId: run.sessionId });
    return {
      list: async () => ((await handleMcpRequest(context, token, { method: 'tools/list' })) as { tools: Array<{ name: string }> }).tools.map(tool => tool.name),
      call: (name: string, args: Record<string, unknown>) => handleMcpRequest(context, token, { method: 'tools/call', name, arguments: args }),
    };
  };

  const host = turn(HOST);
  const names = await host.list();
  for (const name of ['permissions_request', 'permissions_run', 'permissions_runResult', 'permissions_list']) assert.ok(names.includes(name), name);
  assert.ok(names.includes('sessions_list'), 'the rest stays as a controlling computer’s');
  const asked = await host.call('permissions_request', { requestKey: 'merge-1', kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge PR 4' }) as { request: { id: string; status: string } };
  assert.equal(asked.request.status, 'pending');
  const ran = await host.call('permissions_run', { requestKey: 'run-1', command: 'kill 13229', reason: 'Stop the old dev server' }) as { request: { id: string; status: string } };
  assert.equal(ran.request.status, 'pending');
  const requests = f.service.overview().requests;
  assert.deepEqual(requests.map(request => [request.rule.value, request.review?.status]), [['kill 13229', 'queued'], ['gh pr merge', 'queued']], 'both go to the reviewer, as a local turn’s do');
  assert.equal(f.reviews(), 2);
  assert.equal(((await host.call('permissions_runResult', { id: ran.request.id })) as { request: { status: string } }).request.status, 'pending');
  assert.deepEqual(((await host.call('permissions_list', {})) as { requests: Array<{ status: string }> }).requests.map(request => request.status), ['pending', 'pending']);

  const other = turn(OTHER);
  const shown = await other.list();
  assert.ok(!shown.some(name => name.startsWith('permissions_')), 'another controller’s turn is not shown tools it may not call');
  await assert.rejects(other.call('permissions_request', { requestKey: 'merge-2', kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'x' }), { message: NOT_FOLLOWED });
  await assert.rejects(f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'x' }, { ...agent('claude:one'), controllerId: OTHER }), { message: NOT_FOLLOWED });
  await assert.rejects(f.service.requestRun({ command: 'ls', reason: 'x' }, { ...agent('claude:one'), controllerId: OTHER }), { message: NOT_FOLLOWED });
  assert.match(NOT_FOLLOWED, /호스트 설정 따르기/);
  // Everything shown can be called: whatever an empty call answers, it is never the refusal of a tool it may not use.
  for (const [index, name] of shown.entries()) {
    const error = await other.call(name, { requestKey: `probe-${index}` }).then(() => undefined, (failure: Error) => failure);
    assert.doesNotMatch(error?.message ?? '', /on that computer itself|호스트 설정 따르기|Unknown Tower tool/, name);
  }
  f.follow(undefined);
  assert.ok(!(await host.list()).some(name => name.startsWith('permissions_')), 'once this computer stops following, the host’s turns lose them too');
  await assert.rejects(host.call('permissions_request', { requestKey: 'merge-3', kind: 'command', value: 'gh pr view', scope: 'project', reason: 'x' }), { message: NOT_FOLLOWED });
});

test('the followed host’s pages see and decide this computer’s requests through the link; a controller it does not follow finds nothing there', async t => {
  const f = await tower(t, 'node', { project: REPOSITORY });
  f.sessions.set('claude:one', { cwd: f.paths.project!, provider: 'claude' });
  f.follow(HOST);
  const runs: Run[] = [];
  const api = await apiFor(t, f, runs);
  const asked = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge PR 4' }, agent('claude:one'));
  const exclusions = new RemoteExclusionStore(f.stateDir);
  await exclusions.start();
  // As the worker's `api` operation does: the controlling computer's owner, by its link identity.
  const backend = { snapshot: () => ({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'node', version: 'test', updatedAt: '' }), subscribe: () => () => {}, coordinators: () => new Set<string>(),
    api: (operation: string, input: unknown, context?: RequestContext) => api.call(operation, input, context?.origin?.controllerId ? { kind: 'owner', via: 'remote', controllerId: context.origin.controllerId } : { kind: 'owner', via: 'ui' }, context?.requestId) } as unknown as Backend;
  const router = createRemoteRouter({ backend, exclusions, followedHost: async () => f.followed() });
  let principal = HOST;
  const server = createServer((req, res) => { void router.handle(req, res, { controllerId: principal }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { router.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (operation: string, body: unknown) => {
    const response = await fetch(`${base}/api/v1/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-request-id': requestId() }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as { result?: PermissionOverview; error?: string } };
  };

  const overview = await call('permissions.overview', {});
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.json.result!.requests.map(request => request.id), [asked.request.id]);
  const decided = await call('permissions.decide', { id: asked.request.id, approve: true });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.result!.requests[0]!.status, 'approved');
  assert.deepEqual(f.service.overview().rules.map(rule => [rule.value, rule.scope, rule.cwd]), [['gh pr merge', 'project', f.paths.project]], 'the rule is kept on this computer, as its own decision would be');

  principal = OTHER;
  for (const operation of ['permissions.overview', 'permissions.decide', 'permissions.save']) assert.equal((await call(operation, {})).status, 404, `${operation} does not exist for a controller this computer does not follow`);
  principal = HOST;
  f.follow(undefined);
  assert.equal((await call('permissions.overview', {})).status, 404, 'nor for the host once this computer stops following it');
  await assert.rejects(api.call('permissions.overview', {}, { kind: 'owner', via: 'remote', controllerId: HOST }), { message: NOT_FOLLOWED }, 'the worker checks it again');
});

/** A host with live project rules, a narrowed approval, a deleted rule, a conversation rule and a one-off run, and a node following it. */
async function hostAndNode(t: TestContext) {
  const host = await tower(t, 'host', { shop: REPOSITORY, other: 'github.com/owner/other' });
  host.sessions.set('claude:h', { cwd: host.paths.shop!, provider: 'claude' });
  const shop = host.paths.shop!;
  await host.service.saveAutoReview({ enabled: true, resume: true });
  await host.service.save({ kind: 'command', value: 'gh pr merge', providers: ['claude'], scope: 'project', cwd: shop, note: 'Merging is part of delivery' });
  await host.service.save({ kind: 'command', value: 'gh pr checks', providers: ['claude', 'codex'], scope: 'project', cwd: shop });
  await host.service.save({ kind: 'command', value: 'gh pr view', providers: ['claude', 'codex'], scope: 'global' });
  // Asked for `git push`, allowed only as `git push origin`.
  const push = await host.service.request({ kind: 'command', value: 'git push', scope: 'project', reason: 'Push the release branch' }, agent('claude:h'));
  await host.service.decide(push.request.id!, true, { kind: 'command', value: 'git push origin', providers: ['claude'], scope: 'project', cwd: shop });
  // Allowed, then deleted.
  const deploy = await host.service.request({ kind: 'command', value: 'npm run deploy', scope: 'project', reason: 'Deploy 1.2' }, agent('claude:h'));
  await host.service.decide(deploy.request.id!, true);
  await host.service.remove(host.service.overview().rules.find(rule => rule.value === 'npm run deploy')!.id);
  const conversation = await host.service.request({ kind: 'claude', value: 'WebFetch(domain:docs.example.com)', scope: 'conversation', reason: 'Read the docs' }, agent('claude:h'));
  await host.service.decide(conversation.request.id!, true);
  const once = await host.service.requestRun({ command: 'kill 4242', reason: 'Stop the stuck build' }, agent('claude:h'));
  await host.service.decide(once.request.id!, true);
  const node = await tower(t, 'node', { shop: REPOSITORY, other: 'github.com/owner/other' });
  node.follow(HOST);
  await node.service.save({ kind: 'command', value: 'make lint', providers: ['claude', 'codex'], scope: 'global' });
  return { host, node };
}

test('a host’s export: rules for every project, the reviewer setting, live project rules as narrowed, and approvals that left no rule', async t => {
  const { host } = await hostAndNode(t);
  const sent = await host.service.exportManaged();
  assert.deepEqual(sent.rules.map(rule => [rule.value, rule.source]), [['gh pr view', 'owner']]);
  assert.deepEqual(sent.autoReview, { enabled: true, resume: true });
  assert.deepEqual(sent.precedents.map(item => [item.remoteUrl, item.value, item.providers, item.by]).sort(), [
    [REPOSITORY, 'gh pr checks', ['claude', 'codex'], 'owner'], [REPOSITORY, 'gh pr merge', ['claude'], 'owner'], [REPOSITORY, 'git push origin', ['claude'], 'owner']]);
  assert.equal(sent.precedents.find(item => item.value === 'git push origin')!.reason, 'Push the release branch', 'the reason the agent gave');
  assert.deepEqual(sent.approvals.map(item => [item.kind, item.value]).sort(), [['command', 'npm run deploy'], ['run', 'kill 4242']], 'deleted and one-off, never the live conversation rule');
  assert.deepEqual(await host.service.exportManaged(), sent, 'unchanged settings export the same way');
});

test('host precedents allow exactly the same rule in the same repository at once, as a project rule; anything else is reviewed', async t => {
  const { host, node } = await hostAndNode(t);
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  assert.equal(node.service.autoReview().enabled, true, 'the reviewer follows the host');
  const shop = node.paths.shop!, other = node.paths.other!;
  for (const [id, cwd, provider] of [['claude:a', shop, 'claude'], ['claude:b', shop, 'claude'], ['claude:c', shop, 'claude'], ['claude:d', shop, 'claude'], ['claude:e', shop, 'claude'],
    ['codex:a', shop, 'codex'], ['claude:other', other, 'claude']] as const) node.sessions.set(id, { cwd, provider });
  const ask = (sessionId: string, value: string, scope: 'project' | 'global' | 'conversation' = 'project') => node.service.request({ kind: 'command', value, scope, reason: `Needs ${value}` }, agent(sessionId));
  const request = (id: string | undefined) => node.service.overview().requests.find(item => item.id === id)!;

  const merged = await ask('claude:a', 'gh pr merge');
  assert.equal(merged.request.status, 'approved');
  assert.equal(node.reviews(), 0, 'no review is asked for');
  const approved = request(merged.request.id);
  assert.equal(approved.decidedBy, 'auto');
  assert.match(approved.review!.reason!, /^호스트에서 같은 저장소에 허용한 규칙\(\d{4}-\d{2}-\d{2}\)$/);
  const made = node.service.overview().rules.find(rule => rule.id === approved.ruleId)!;
  assert.deepEqual([made.value, made.scope, made.cwd, made.providers, made.source], ['gh pr merge', 'project', shop, ['claude'], 'auto']);
  assert.match(node.service.claudeSettings(shop)!, /Bash\(gh pr merge \*\)/);

  const pending = (result: { request: { status: string } }, why: string) => assert.equal(result.request.status, 'pending', why);
  pending(await ask('codex:a', 'gh pr merge'), 'the precedent allows Claude only; Codex is reviewed');
  pending(await ask('claude:b', 'git push'), 'the host allowed only the narrower git push origin');
  pending(await ask('claude:c', 'npm run deploy'), 'a rule the host deleted is no precedent');
  pending(await ask('claude:other', 'gh pr checks'), 'another repository');
  pending(await node.service.requestRun({ command: 'kill 4242', reason: 'Stop the stuck build' }, agent('claude:c')), 'a one-off run is never allowed by precedent');
  pending(await ask('claude:d', 'gh pr checks', 'conversation'), 'a conversation rule is not allowed by precedent');
  assert.equal(node.reviews(), 6, 'each went to the reviewer');

  const widened = await ask('claude:d', 'gh pr checks', 'global');
  assert.equal(widened.request.status, 'approved', 'asked for every project …');
  const narrowed = node.service.overview().rules.find(rule => rule.id === request(widened.request.id).ruleId)!;
  assert.deepEqual([narrowed.scope, narrowed.cwd], ['project', shop], '… allowed for this project only');

  node.follow(OTHER);
  pending(await ask('claude:e', 'git push origin'), 'precedents apply only while this computer follows the host that sent them');
  node.follow(HOST);
  node.sessions.set('claude:f', { cwd: shop, provider: 'claude' });
  assert.equal((await ask('claude:f', 'git push origin')).request.status, 'approved', 'the narrowed rule itself is a precedent');
});

test('the reviewer weighs the host’s precedents and earlier approvals in this repository as reference', async t => {
  const { host, node } = await hostAndNode(t);
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  node.sessions.set('claude:a', { cwd: node.paths.shop!, provider: 'claude' });
  const asked = await node.service.request({ kind: 'command', value: 'git push', scope: 'project', reason: 'Push the fix' }, agent('claude:a'));
  const request = node.service.overview().requests.find(item => item.id === asked.request.id) as PermissionRequest;
  const sources: ReviewSources = { runs: () => [], trigger: () => undefined, authority: async () => ({ skills: [] }), answers: () => [],
    conversation: async () => ({ messages: [{ id: 'u', role: 'user', text: 'Fix and push the bug.', timestamp: '1' }], complete: true }),
    rules: cwd => node.service.overview(cwd).rules, guards: rule => ruleGuards(rule), requests: () => [], hostPrecedents: cwd => node.service.hostPrecedents(cwd) };
  const input = JSON.parse(await reviewInput(request, sources));
  assert.match(input.context.hostPrecedents.reference, /^Reference only/);
  assert.equal(input.context.hostPrecedents.repository, REPOSITORY);
  assert.ok(input.context.hostPrecedents.liveRules.some((item: { rule: string }) => item.rule === 'git push origin'));
  assert.deepEqual(input.context.hostPrecedents.earlierApprovals.map((item: { rule?: string; command?: string }) => item.rule ?? item.command).sort(), ['kill 4242', 'npm run deploy']);
  assert.ok(input.authority.existingRules.some((rule: { rule: string }) => rule.rule === 'gh pr view'), 'the host’s rules for every project are rules here');
  node.follow(undefined);
  assert.equal(JSON.parse(await reviewInput(request, sources)).context.hostPrecedents, undefined, 'not while this computer follows no host');
});

test('the host’s rules for every project apply here for Claude and Codex beside this computer’s own, are replaced as a set, and an unchanged sync writes nothing', async t => {
  const { host, node } = await hostAndNode(t);
  const codexFile = join(node.codexHome, 'rules', 'tower.rules');
  const keptFile = join(node.stateDir, 'managed', 'permissions.json');
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  const settings = JSON.parse(node.service.claudeSettings(node.paths.shop!)!) as { permissions: { allow: string[] } };
  assert.deepEqual(settings.permissions.allow.sort(), ['Bash(gh pr view *)', 'Bash(make lint *)']);
  assert.match(await readFile(codexFile, 'utf8'), /prefix_rule\(pattern=\["gh", "pr", "view"\], decision="allow"\)/);
  const hostRule = node.service.overview().rules.find(rule => rule.value === 'gh pr view')!;
  assert.equal(hostRule.host, true, 'marked as the host’s');
  await assert.rejects(node.service.remove(hostRule.id), /찾지 못했습니다/, 'changed only on the host');
  assert.equal((await node.service.request({ kind: 'command', value: 'gh pr view', scope: 'project', reason: 'x' }, agent((node.sessions.set('claude:a', { cwd: node.paths.shop!, provider: 'claude' }), 'claude:a')))).request.status, 'exists');

  // The same settings again: nothing is written.
  const before = await stat(keptFile), codexBefore = await stat(codexFile);
  await node.service.saveAutoReview({ enabled: false, resume: true });
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  const after = await stat(keptFile), codexAfter = await stat(codexFile);
  assert.deepEqual([after.ino, after.mtimeMs, codexAfter.ino, codexAfter.mtimeMs], [before.ino, before.mtimeMs, codexBefore.ino, codexBefore.mtimeMs]);
  assert.equal(node.service.autoReview().enabled, true, 'a reviewer setting changed here goes back to the host’s');

  // Deleted on the host: gone here with the next sync; this computer's own rule stays.
  await host.service.remove(host.service.overview().rules.find(rule => rule.value === 'gh pr view')!.id);
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  assert.deepEqual(JSON.parse(node.service.claudeSettings(node.paths.shop!)!).permissions.allow, ['Bash(make lint *)']);
  assert.doesNotMatch(await readFile(codexFile, 'utf8'), /"view"/);
  assert.match(await readFile(codexFile, 'utf8'), /"make", "lint"/);

  // Kept across a restart, from the file beside the permission store; never in this computer's own backup.
  const again = new PermissionService({ stateDir: node.stateDir, repository: noStorageFixture(node.stateDir), env: { CODEX_HOME: node.codexHome }, session: () => undefined });
  await host.service.save({ kind: 'claude', value: 'WebFetch(domain:example.com)', providers: ['claude'], scope: 'global' });
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  await again.start();
  t.after(() => again.close());
  assert.ok(again.overview().rules.some(rule => rule.host && rule.value === 'WebFetch(domain:example.com)'));
  assert.ok(!JSON.stringify(node.service.exportBackup()).includes('WebFetch(domain:example.com)'));
  await assert.rejects(node.service.applyManaged({ rules: 'nope' }, HOST), /형식이 올바르지 않습니다/, 'a malformed section is refused whole');
  assert.ok(node.service.overview().rules.some(rule => rule.host), 'and what was kept stays');
});

test('a folder pointed at another repository is judged by the repository it names now, on both sides', async t => {
  const { host, node } = await hostAndNode(t);
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  for (const id of ['claude:a', 'claude:b']) node.sessions.set(id, { cwd: node.paths.shop!, provider: 'claude' });
  const ask = (sessionId: string) => node.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge' }, agent(sessionId));
  // Looked up once for this repository; then the folder's origin moves to another one.
  assert.ok(await node.service.hostPrecedents(node.paths.shop!));
  node.point('shop', 'github.com/owner/fork');
  const before = node.lookups();
  assert.equal((await ask('claude:a')).request.status, 'pending', 'never allowed by the precedents of the repository it named before');
  assert.ok(node.lookups() > before, 'read again for the decision');
  node.point('shop', REPOSITORY);
  assert.equal((await ask('claude:b')).request.status, 'approved');
  host.point('shop', 'github.com/owner/renamed');
  assert.ok((await host.service.exportManaged()).precedents.every(item => item.remoteUrl === 'github.com/owner/renamed'), 'a host lists its precedents by what its folders name now');
});

test('a change of followed host while a request is looked at: the former host is refused, this computer’s own request is reviewed, nothing is allowed by the former host’s precedents', async t => {
  const { host, node } = await hostAndNode(t);
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  for (const id of ['claude:a', 'claude:b']) node.sessions.set(id, { cwd: node.paths.shop!, provider: 'claude' });
  node.meanwhile(() => node.follow(OTHER));
  await assert.rejects(node.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge' }, { ...agent('claude:a'), controllerId: HOST }), { message: NOT_FOLLOWED });
  node.follow(HOST);
  const local = await node.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge' }, agent('claude:b'));
  assert.equal(local.request.status, 'pending');
  assert.ok(!node.service.overview().rules.some(rule => rule.value === 'gh pr merge'), 'no rule was made');
  assert.ok(!node.service.overview().requests.some(request => request.sessionId === 'claude:a'), 'the former host’s request was not recorded');
});

test('host rules that could not reach Codex fail the section and are written again with the same settings', async t => {
  const { host, node } = await hostAndNode(t);
  const codexFile = join(node.codexHome, 'rules', 'tower.rules');
  // Someone else's file where Tower writes the rules for every project: Tower never replaces it.
  await writeFile(codexFile, 'prefix_rule(pattern=["mine"], decision="allow")\n');
  const sent = await host.service.exportManaged();
  await assert.rejects(node.service.applyManaged(sent, HOST), /Codex 규칙 파일에 쓰지 못했습니다/);
  assert.match(JSON.parse(node.service.claudeSettings(node.paths.shop!)!).permissions.allow.join(' '), /gh pr view/, 'Claude has them already');
  await assert.rejects(node.service.applyManaged(sent, HOST), /Codex 규칙 파일에 쓰지 못했습니다/, 'still failing, still reported');
  await rm(codexFile);
  await node.service.applyManaged(sent, HOST);
  assert.match(await readFile(codexFile, 'utf8'), /"gh", "pr", "view"/, 'the same settings are written once the file can be');
});

test('a rule of the host for every project decides over an overlapping rule the reviewer allowed here, for Codex as for Claude, without deleting it', async t => {
  const { host, node } = await hostAndNode(t);
  await host.service.save({ kind: 'command', value: 'git push', providers: ['claude', 'codex'], scope: 'project', cwd: host.paths.shop! });
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  node.sessions.set('codex:a', { cwd: node.paths.shop!, provider: 'codex' });
  node.sessions.set('claude:a', { cwd: node.paths.shop!, provider: 'claude' });
  assert.equal((await node.service.request({ kind: 'command', value: 'git push', scope: 'project', reason: 'Push' }, agent('codex:a'))).request.status, 'approved');
  assert.equal((await node.service.request({ kind: 'command', value: 'git push', scope: 'project', reason: 'Push' }, agent('claude:a'))).request.status, 'approved');
  const projectFile = join(node.paths.shop!, '.codex', 'rules', 'tower.rules');
  assert.match(await readFile(projectFile, 'utf8'), /"git", "push", "--force-with-lease"\], decision="forbidden"/, 'the reviewer’s kind of rule comes with its forbidden variants');
  await host.service.save({ kind: 'command', value: 'git push --force-with-lease', providers: ['claude', 'codex'], scope: 'global' });
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  const codex = [await readFile(join(node.codexHome, 'rules', 'tower.rules'), 'utf8'), await readFile(projectFile, 'utf8').catch(() => '')].join('\n');
  assert.match(codex, /"git", "push", "--force-with-lease"\], decision="allow"/);
  assert.doesNotMatch(codex, /decision="forbidden"/, 'nothing forbids what the owner allows');
  assert.doesNotMatch(node.service.claudeSettings(node.paths.shop!)!, /"deny"/);
  assert.ok(node.service.overview().rules.some(rule => rule.source === 'auto' && rule.value === 'git push'), 'this computer’s own rule is kept');
});

test('Codex’s rules files are brought in line on disk with every sync, after a restart too, and a project file the host’s rules decide that cannot be written is reported', async t => {
  const { host, node } = await hostAndNode(t);
  const codexFile = join(node.codexHome, 'rules', 'tower.rules');
  await writeFile(codexFile, 'prefix_rule(pattern=["mine"], decision="allow")\n');
  const sent = await host.service.exportManaged();
  await assert.rejects(node.service.applyManaged(sent, HOST), /Codex 규칙 파일에 쓰지 못했습니다/);
  // Started again with the same settings kept: nothing in memory says a write failed, the file on disk does.
  node.service.close();
  const restarted = await node.restart();
  await rm(codexFile);
  await restarted.applyManaged(sent, HOST);
  assert.match(await readFile(codexFile, 'utf8'), /"gh", "pr", "view"/);

  // A reviewer rule here that the host's new rule decides over leaves its project file; that file cannot be changed now.
  await host.service.save({ kind: 'command', value: 'git push', providers: ['claude', 'codex'], scope: 'project', cwd: host.paths.shop! });
  await restarted.applyManaged(await host.service.exportManaged(), HOST);
  node.sessions.set('codex:a', { cwd: node.paths.shop!, provider: 'codex' });
  assert.equal((await restarted.request({ kind: 'command', value: 'git push', scope: 'project', reason: 'Push' }, agent('codex:a'))).request.status, 'approved');
  const rulesFolder = join(node.paths.shop!, '.codex', 'rules');
  const projectFile = join(rulesFolder, 'tower.rules');
  assert.match(await readFile(projectFile, 'utf8'), /decision="forbidden"/);
  await host.service.save({ kind: 'command', value: 'git push --force-with-lease', providers: ['claude', 'codex'], scope: 'global' });
  const widened = await host.service.exportManaged();
  await chmod(rulesFolder, 0o500);
  try { await assert.rejects(restarted.applyManaged(widened, HOST), (error: Error) => error.message.includes(projectFile), 'the project file is named'); }
  finally { await chmod(rulesFolder, 0o700); }
  await restarted.applyManaged(widened, HOST);
  await assert.rejects(readFile(projectFile, 'utf8'), { code: 'ENOENT' }, 'the same settings again: now the file is right');
});

test('following that changes at any wait before the approval is written: the former host is refused and no rule is made; this computer’s own request is reviewed', async t => {
  const { host, node } = await hostAndNode(t);
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  // Each wait for storage on the way to the write, the last one inside the write itself.
  for (const at of [1, 2, 3]) {
    const session = `claude:host-${at}`;
    node.sessions.set(session, { cwd: node.paths.shop!, provider: 'claude' });
    node.atEffect(count => { if (count === at) node.follow(OTHER); });
    await assert.rejects(node.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge' }, { ...agent(session), controllerId: HOST }), { message: NOT_FOLLOWED }, `at wait ${at}`);
    node.atEffect(undefined);
    node.follow(HOST);
  }
  node.sessions.set('claude:own', { cwd: node.paths.shop!, provider: 'claude' });
  node.atEffect(count => { if (count === 3) node.follow(OTHER); });
  assert.equal((await node.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'Merge' }, agent('claude:own'))).request.status, 'pending');
  node.atEffect(undefined);
  assert.ok(!node.service.overview().rules.some(rule => rule.value === 'gh pr merge'), 'no rule was made');
});

test('an allow the host withdrew leaves the rules file for every project even when no host rule is left, after a restart too', async t => {
  const { host, node } = await hostAndNode(t);
  const rulesFolder = join(node.codexHome, 'rules');
  const codexFile = join(rulesFolder, 'tower.rules');
  await node.service.applyManaged(await host.service.exportManaged(), HOST);
  assert.match(await readFile(codexFile, 'utf8'), /"gh", "pr", "view"/);
  await host.service.remove(host.service.overview().rules.find(rule => rule.value === 'gh pr view')!.id);
  const withdrawn = await host.service.exportManaged();
  assert.deepEqual(withdrawn.rules, [], 'no host rule is left');
  await chmod(rulesFolder, 0o500);
  let restarted: PermissionService;
  try {
    await assert.rejects(node.service.applyManaged(withdrawn, HOST), /Codex 규칙 파일에 쓰지 못했습니다/);
    node.service.close();
    restarted = await node.restart();
    await assert.rejects(restarted.applyManaged(withdrawn, HOST), /Codex 규칙 파일에 쓰지 못했습니다/, 'still reported after a restart while the allow is on disk');
    assert.match(await readFile(codexFile, 'utf8'), /"gh", "pr", "view"/);
  } finally { await chmod(rulesFolder, 0o700); }
  await restarted.applyManaged(withdrawn, HOST);
  const text = await readFile(codexFile, 'utf8');
  assert.doesNotMatch(text, /"gh", "pr", "view"/, 'the withdrawn allow is gone');
  assert.match(text, /"make", "lint"/, 'this computer’s own rule stays');
});
