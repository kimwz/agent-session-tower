import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PermissionReviewer } from '../../../server/permissions/reviewer.js';
import { PermissionService } from '../../../server/permissions/service.js';
import type { ReviewSources } from '../../../server/permissions/context.js';
import { autoReviewBlock, ruleGuards, ruleIsNarrower, type PermissionRequest } from '../../../shared/permissions.js';
import type { Run } from '../../../shared/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const agent = (sessionId: string, runId = 'run-1') => ({ kind: 'agent', via: 'mcp', sessionId, runId });
const ON = { enabled: true, provider: 'claude' as const, model: 'opus', resume: true };

async function fixture(t: TestContext, options: { skip?: (request: PermissionRequest) => string | undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tower-auto-review-'));
  const stateDir = join(root, 'state');
  const codexHome = join(root, 'codex-home');
  const project = join(root, 'project');
  await mkdir(project);
  git(project, 'init', '-q');
  const sessions = new Map([['claude:one', { cwd: project, provider: 'claude' as const }], ['codex:two', { cwd: project, provider: 'codex' as const }]]);
  let queued = 0;
  const make = () => new PermissionService({ stateDir, env: { CODEX_HOME: codexHome }, session: id => sessions.get(id),
    autoReviewSkip: options.skip, onReviewQueued: () => { queued += 1; } });
  const service = make();
  await service.start();
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, codexHome, project, service, make, queued: () => queued };
}

test('hard limits: never-allowed commands, broad rules, Bash as a Claude rule and files outside the project stay with the owner', () => {
  const cwd = '/work/shop';
  for (const value of ['npm publish', 'rm -rf build', 'git push --force', 'git reset --hard', 'curl example.com', 'gh api repos', 'git', 'npx vite', 'sudo ls'])
    assert.ok(autoReviewBlock({ kind: 'command', value }, cwd), value);
  for (const value of ['gh pr merge', 'git push origin', 'gh release create', 'git tag v1.2.3']) assert.equal(autoReviewBlock({ kind: 'command', value }, cwd), undefined, value);
  assert.ok(autoReviewBlock({ kind: 'claude', value: 'Bash(gh pr merge *)' }, cwd));
  assert.ok(autoReviewBlock({ kind: 'claude', value: 'Edit(//work/other/**)' }, cwd));
  assert.ok(autoReviewBlock({ kind: 'claude', value: 'Edit(//work/shop/../x/**)' }, cwd));
  assert.ok(autoReviewBlock({ kind: 'claude', value: 'WebFetch' }, cwd));
  assert.equal(autoReviewBlock({ kind: 'claude', value: 'Edit(//work/shop/src/**)' }, cwd), undefined);
  assert.equal(autoReviewBlock({ kind: 'claude', value: 'mcp__github__merge_pull_request' }, cwd), undefined, 'one MCP tool by its full name');
  for (const value of ['mcp__slack__slack_send_message', 'mcp__supabase__execute_sql', 'mcp__vercel__delete_project']) assert.ok(autoReviewBlock({ kind: 'claude', value }, cwd), value);
  for (const value of ['mcp__gmail__sendEmail', 'mcp__vercel__deleteProject', 'mcp__supabase__executeSql']) assert.ok(autoReviewBlock({ kind: 'claude', value }, cwd), value);
  for (const value of ['mcp__postgres__list_tables', 'mcp__stripe__list_payments', 'mcp__vercel__list_deployments']) assert.equal(autoReviewBlock({ kind: 'claude', value }, cwd), undefined, value);
  const diff = ruleGuards({ kind: 'command', value: 'git diff' }).claude;
  assert.ok(diff.includes('Bash(git diff * --output=*)') && !diff.some(pattern => pattern.includes('--output*') || pattern.includes(' -O')), 'git diff --output-indicator-new and -O<orderfile> stay allowed');
  assert.ok(!diff.includes('Bash(git diff * --text)') && diff.includes('Bash(git diff * --textc)'), 'git diff --text stays allowed');
  for (const guard of ['Bash(git fetch * --upload-pack*)', 'Bash(git log * --output=*)', 'Bash(git grep * -O*)']) {
    const [, rest] = /^Bash\(git (\w+) /.exec(guard)!;
    assert.ok(ruleGuards({ kind: 'command', value: `git ${rest}` }).claude.includes(guard), guard);
  }
  assert.ok(ruleGuards({ kind: 'command', value: 'git switch' }).claude.includes('Bash(git switch * --discard-changes*)'));
  assert.ok(autoReviewBlock({ kind: 'claude', value: 'Read(//.ssh/id_rsa)' }, '/'), 'hidden folders even when the project is /');
  assert.equal(autoReviewBlock({ kind: 'claude', value: 'WebFetch(domain:docs.example.com)' }, cwd), undefined);
});

test('an allowed push is paired with deny rules for its destructive variants', () => {
  const guards = ruleGuards({ kind: 'command', value: 'git push' });
  for (const pattern of ['Bash(git push --force*)', 'Bash(git push * --force*)', 'Bash(git push -f*)', 'Bash(git push * -f*)', 'Bash(git push * +*)', 'Bash(git push * --delete*)', 'Bash(git push * --del)', 'Bash(git push * --del *)', 'Bash(git push * --mirr)'])
    assert.ok(guards.claude.includes(pattern), pattern);
  assert.ok(guards.codex.includes('prefix_rule(pattern=["git", "push", "--force"], decision="forbidden")'));
  assert.ok(guards.codex.includes('prefix_rule(pattern=["git", "push", "--del"], decision="forbidden")'), 'git takes abbreviations');
  // Options that only share a start with a dangerous one stay allowed.
  const matches = (pattern: string, command: string) => new RegExp(`^${pattern.slice(5, -1).split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(command);
  for (const command of ['git push --follow-tags', 'git push origin main --follow-tags', 'git push --dry-run']) assert.ok(!guards.claude.some(pattern => matches(pattern, command)), command);
  for (const command of ['git push --del origin x', 'git push origin main --force', 'git push --force-with-lease']) assert.ok(guards.claude.some(pattern => matches(pattern, command)), command);
  assert.ok(ruleGuards({ kind: 'command', value: 'gh pr merge' }).claude.includes('Bash(gh pr merge * --admin*)'), 'merging past branch protection stays the owner’s');
  assert.deepEqual(ruleGuards({ kind: 'command', value: 'gh release create' }), { claude: [], codex: [] });
  assert.ok(ruleGuards({ kind: 'command', value: 'gh pr' }).claude.includes('Bash(gh pr close)'));
  assert.ok(ruleGuards({ kind: 'command', value: 'git push origin main' }).claude.includes('Bash(git push origin main * --force*)'), 'options follow anywhere');
  assert.ok(ruleGuards({ kind: 'command', value: 'git checkout' }).claude.includes('Bash(git checkout * --)'), 'a bare -- is a word, not an option start');
});

test('a narrower rule is the same kind, the same or a longer prefix, no wider scope and no more agents', () => {
  const asked = { kind: 'command' as const, value: 'git push', providers: ['claude' as const], scope: 'project' as const, cwd: '/p' };
  assert.ok(ruleIsNarrower(asked, { ...asked, value: 'git push origin main' }));
  assert.ok(!ruleIsNarrower(asked, { ...asked, value: 'git' }));
  assert.ok(!ruleIsNarrower(asked, { ...asked, value: 'git pushx' }));
  assert.ok(!ruleIsNarrower(asked, { ...asked, scope: 'global', cwd: undefined }));
  assert.ok(!ruleIsNarrower(asked, { ...asked, providers: ['claude', 'codex'] }));
  assert.ok(!ruleIsNarrower(asked, { ...asked, cwd: '/q' }));
});

test('with auto-review on, a request waits for the reviewer; one it may not decide waits for the owner with the reason', async t => {
  const f = await fixture(t, { skip: request => request.sessionId === 'codex:two' ? '공개 에이전트의 요청은 소유자가 정합니다.' : undefined });
  const off = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one', 'r0'));
  assert.equal(f.service.overview().requests.find(item => item.id === off.request.id!)!.review, undefined, 'nothing is reviewed while it is off');
  await f.service.saveAutoReview(ON);
  const queued = await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one'));
  assert.match(queued.note, /reviewer/);
  assert.equal(f.queued(), 1);
  const overview = f.service.overview();
  assert.equal(overview.requests.find(item => item.id === queued.request.id!)!.review!.status, 'queued');
  assert.equal(overview.pending, 1, 'a request with the reviewer is not counted as waiting for the owner');
  const broad = await f.service.request({ kind: 'command', value: 'rm -rf dist', scope: 'project', reason: 'clean' }, agent('claude:one', 'r2'));
  assert.equal(f.service.overview().requests.find(item => item.id === broad.request.id!)!.review!.status, 'skipped');
  const outsider = await f.service.request({ kind: 'command', value: 'gh issue comment', scope: 'project', reason: 'reply' }, agent('codex:two', 'r3'));
  assert.equal(f.service.overview().requests.find(item => item.id === outsider.request.id!)!.review!.reason, '공개 에이전트의 요청은 소유자가 정합니다.');
  assert.equal(f.service.nextReview()!.id, queued.request.id!);
  // The reviewer's model is chosen in Settings › Models; a model sent here by an older page changes nothing.
  await f.service.saveAutoReview({ ...ON, model: 'haiku' });
  assert.equal((await f.service.reviewModel()).model, 'opus');
});

test('an approval becomes a project rule with deny rules for both agents; a widening answer goes to the owner', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const asked = await f.service.request({ kind: 'command', value: 'git push', providers: ['claude', 'codex'], scope: 'global', reason: 'push the release tag' }, agent('claude:one'));
  assert.ok(await f.service.startReview(asked.request.id!));
  const outcome = await f.service.applyReview(asked.request.id!, { verdict: 'approve', reason: 'auto-deploy 스킬이 배포를 요구합니다.', model: 'opus' });
  assert.equal(outcome!.request.status, 'approved');
  assert.equal(outcome!.request.decidedBy, 'auto');
  assert.match(outcome!.message!, /allowed `git push`.*in this project \(you asked for `git push` in every project\)/);
  const rule = f.service.overview().rules[0]!;
  assert.deepEqual([rule.source, rule.scope, rule.cwd], ['auto', 'project', f.project]);
  const settings = JSON.parse(f.service.claudeSettings(f.project)!);
  assert.deepEqual(settings.permissions.allow, ['Bash(git push *)']);
  assert.ok(settings.permissions.deny.includes('Bash(git push * --force*)'));
  const codex = await readFile(join(f.project, '.codex', 'rules', 'tower.rules'), 'utf8');
  assert.match(codex, /prefix_rule\(pattern=\["git", "push"\], decision="allow"\)/);
  assert.match(codex, /prefix_rule\(pattern=\["git", "push", "--force"\], decision="forbidden"\)/);

  const wide = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one', 'r2'));
  await f.service.startReview(wide.request.id!);
  const widened = await f.service.applyReview(wide.request.id!, { verdict: 'approve', rule: { kind: 'command', value: 'gh pr' }, reason: 'ok' });
  assert.equal(widened!.message, undefined);
  const after = f.service.overview().requests.find(item => item.id === wide.request.id!)!;
  assert.equal(after.status, 'pending');
  assert.equal(after.review!.verdict, 'owner');
  assert.match(after.review!.reason!, /넓은 규칙/);
  const never = await f.service.request({ kind: 'command', value: 'gh pr view', scope: 'project', reason: 'x' }, agent('claude:one', 'r3'));
  await f.service.startReview(never.request.id!);
  await f.service.applyReview(never.request.id!, { verdict: 'approve', rule: { kind: 'command', value: 'gh pr view 12' }, reason: 'narrower is fine' });
  assert.equal(f.service.overview().rules.find(item => item.value === 'gh pr view 12')?.source, 'auto', 'a longer prefix is narrower');
});

test('a narrow verdict withdraws the request and tells the agent; the third in a day goes to the owner', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const ids: string[] = [];
  for (const value of ['gh release', 'gh release create', 'gh release create v1']) {
    const { request } = await f.service.request({ kind: 'command', value, scope: 'project', reason: 'deploy' }, agent('claude:one', `r-${value}`));
    ids.push(request.id!);
    await f.service.startReview(request.id!);
    const outcome = await f.service.applyReview(request.id!, { verdict: 'narrow', suggestion: 'gh release create v1.2.3', reason: '더 좁게' });
    if (ids.length < 3) {
      assert.equal(outcome!.request.status, 'withdrawn');
      assert.match(outcome!.message!, /withdrew the request.*gh release create v1\.2\.3/);
    } else {
      assert.equal(outcome!.request.status, 'pending');
      assert.equal(outcome!.request.review!.verdict, 'owner');
    }
  }
});

test('the owner’s decision during a review stands; a review running when the worker stopped is queued again', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const first = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one'));
  await f.service.startReview(first.request.id!);
  await f.service.decide(first.request.id!, false);
  assert.equal(await f.service.applyReview(first.request.id!, { verdict: 'approve', reason: 'ok' }), undefined);
  const decided = f.service.overview().requests.find(item => item.id === first.request.id!)!;
  assert.deepEqual([decided.status, decided.decidedBy, f.service.overview().rules.length], ['denied', 'owner', 0]);

  const second = await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one', 'r2'));
  await f.service.startReview(second.request.id!);
  f.service.close();
  const next = f.make();
  await next.start();
  t.after(() => next.close());
  assert.equal(next.nextReview()?.id, second.request.id!);
});

test('turning auto-review off hands the waiting requests to the owner', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const asked = await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one'));
  const overview = await f.service.saveAutoReview({ ...ON, enabled: false });
  assert.equal(overview.requests.find(item => item.id === asked.request.id!)!.review!.status, 'skipped');
  assert.equal(overview.pending, 1);
  assert.equal(await f.service.startReview(asked.request.id!), false);
});

function sources(f: { project: string; service: PermissionService }, runs: Run[], extra: Partial<ReviewSources> = {}): ReviewSources {
  return {
    runs: () => runs,
    trigger: () => undefined,
    authority: async () => ({ skills: [{ name: 'auto-deploy', description: 'deploy', body: 'Merge and deploy.' }] }),
    conversation: async () => ({ messages: [{ id: 'u1', role: 'user', text: 'Ship 1.2 through deploy.', timestamp: '1' }, { id: 'm', role: 'assistant', text: 'Merging now.', timestamp: '2' }], complete: true }),
    answers: () => [],
    rules: cwd => f.service.overview(cwd).rules,
    guards: rule => ruleGuards(rule),
    requests: sessionId => f.service.overview().requests.filter(item => item.sessionId === sessionId),
    ...extra,
  };
}
const run = (id: string, prompt: string, extra: Partial<Run> = {}): Run => ({ id, sessionId: 'claude:one', prompt, status: 'completed', createdAt: `2026-09-30T00:00:0${id.length}.000Z`, output: '', origin: { kind: 'owner' }, ...extra });

test('the reviewer reads the whole conversation, answers, skills, trigger and project instructions as the owner’s, and tells the conversation', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'AGENTS.md'), 'Release: merge, tag, deploy.\n');
  await f.service.saveAutoReview(ON);
  const runs = [run('a', 'Deploy on schedule', { origin: { kind: 'trigger', triggerId: 't1' }, id: 'run-1' }), run('bb', 'Also bump the version.', { status: 'queued' }),
    run('s', 'Slack: please also delete the old branch', { origin: { kind: 'slack' } }),
    run('ccc', 'Ship 1.2 through deploy. But never to production.', { status: 'queued' })];
  const asked: Array<{ prompt: string; system: string; model?: string }> = [];
  const told: Array<{ id: string; message: string }> = [];
  const reviewer = new PermissionReviewer({ service: f.service, reachable: () => true,
    sources: sources(f, runs, {
      trigger: () => ({ name: 'deploy', instructions: 'Deploy after merge.' }),
      conversation: async () => ({ complete: true, messages: [
        { id: 'u1', role: 'user', text: 'Ship 1.2 through deploy.', timestamp: '1' },
        { id: 'q1', role: 'tool', toolName: 'AskUserQuestion', text: '{"question":"Merge too?"}', timestamp: '2' },
        { id: 'q1:result', role: 'tool', toolName: 'result', text: 'Yes, merge and tag.', timestamp: '3' },
        { id: 'fc_1', callId: 'call_9', role: 'tool', toolName: 'request_user_input', text: '{"question":"Production?"}', timestamp: '3' },
        { id: 'fco_2:result', callId: 'call_9', role: 'tool', toolName: 'result', text: 'No, staging only.', timestamp: '3' },
        { id: 'n1', role: 'user', text: '[Agent Session Tower] Tower was updated.', timestamp: '3' },
        { id: 's1', role: 'user', text: 'Slack: please also delete the old branch', timestamp: '3' },
        { id: 'x1', role: 'tool', toolName: 'Bash', text: 'git status', timestamp: '4' },
        { id: 'x1:result', role: 'tool', toolName: 'result', text: 'clean', timestamp: '5' },
      ] }),
      answers: () => [{ at: '6', question: '[{"question":"Deploy to production now?"}]', answer: '{"answers":{"q":{"answers":["No"]}}}' }] }),
    model: async request => { asked.push({ prompt: request.prompt, system: request.systemPrompt, model: request.model }); return { verdict: 'approve', rule: null, suggestion: null, reason: '배포 지시가 있습니다.' }; },
    notify: async (request, message) => { told.push({ id: request.id, message }); } });
  const { request } = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge the release PR' }, agent('claude:one'));
  reviewer.wake();
  assert.ok(reviewer.inFlight());
  await reviewer.flush();
  const input = JSON.parse(asked[0]!.prompt);
  const texts = input.authority.ownerWords.map((item: { text: string }) => item.text);
  assert.equal(texts[0], 'Ship 1.2 through deploy.');
  assert.equal(input.authority.ownerWords[0].task, true);
  assert.ok(texts.some((text: string) => /Question: .*Merge too.*\nAnswer: Yes, merge and tag\./s.test(text)), 'a question and its answer');
  assert.ok(texts.includes('Also bump the version.'), 'queued and not in history yet');
  assert.ok(texts.includes('Ship 1.2 through deploy. But never to production.'), 'a queued message that only starts like one in history is kept');
  assert.ok(texts.some((text: string) => text.includes('Deploy to production now?') && text.includes('"No"')), 'an answer as sent, with its question');
  assert.ok(!texts.includes('clean'), 'other tool results are not the owner’s words');
  assert.ok(texts.some((text: string) => /Production\?[\s\S]*Answer: No, staging only\./.test(text)), 'a Codex question and answer, paired by their call id');
  assert.ok(!texts.some((text: string) => text.startsWith('[Agent Session Tower]')), 'Tower notices are not the owner’s words');
  assert.ok(!texts.includes('Slack: please also delete the old branch'), 'Slack’s words are not the owner’s');
  assert.equal(input.context.messagesFromAutomation[0].kind, 'sent for slack');
  assert.equal(input.authority.trigger.instructions, 'Deploy after merge.');
  assert.deepEqual(input.authority.projectInstructions.map((item: { text: string }) => item.text), ['Release: merge, tag, deploy.\n']);
  assert.equal(input.authority.ownerSkills[0].name, 'auto-deploy');
  assert.match(input.context.request.allows, /followed by any arguments/);
  assert.equal(asked[0]!.model, 'opus');
  assert.equal(f.service.overview().requests.find(item => item.id === request.id)!.status, 'approved');
  assert.equal(told[0]!.id, request.id);
  assert.match(told[0]!.message, /Tower's permission reviewer allowed `gh pr merge`/);
});

test('a conversation that cannot be read whole, or whose owner words are too long, goes to the owner without asking the model', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  let asked = 0;
  const model = async () => { asked += 1; return { verdict: 'approve', rule: null, suggestion: null, reason: 'ok' }; };
  const partial = new PermissionReviewer({ service: f.service, reachable: () => true, notify: async () => {}, model,
    sources: sources(f, [], { conversation: async () => ({ messages: [], complete: false }) }) });
  const first = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one'));
  partial.wake();
  await partial.flush();
  const cut = new PermissionReviewer({ service: f.service, reachable: () => true, notify: async () => {}, model,
    sources: sources(f, [], { conversation: async () => ({ messages: [{ id: 'u', role: 'user', text: 'x'.repeat(100_000), timestamp: '' }], complete: true }) }) });
  const second = await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one', 'r2'));
  cut.wake();
  await cut.flush();
  assert.equal(asked, 0);
  for (const id of [first.request.id, second.request.id]) assert.equal(f.service.overview().requests.find(entry => entry.id === id)!.review!.status, 'skipped');
});

test('a failed or held review leaves the request to the owner; holding stops new reviews until released', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  let calls = 0;
  const reviewer = new PermissionReviewer({ service: f.service, sources: sources(f, []), reachable: () => true, notify: async () => {},
    model: async () => { calls += 1; throw new Error('Claude Code did not return a successful structured decision.'); } });
  reviewer.hold();
  const { request } = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one'));
  reviewer.wake();
  assert.equal(reviewer.inFlight(), false);
  reviewer.release();
  await reviewer.flush();
  assert.equal(calls, 1);
  const item = f.service.overview().requests.find(entry => entry.id === request.id)!;
  assert.deepEqual([item.status, item.review!.status], ['pending', 'failed']);
  assert.equal(f.service.overview().pending, 1);
});

test('the reviewer never widens a rule the owner made, and an answer arriving after it was turned off is not used', async t => {
  const f = await fixture(t);
  await f.service.save({ kind: 'command', value: 'git push', providers: ['codex'], scope: 'project', cwd: f.project });
  await f.service.saveAutoReview(ON);
  const asked = await f.service.request({ kind: 'command', value: 'git push', providers: ['claude'], scope: 'project', reason: 'push' }, agent('claude:one'));
  await f.service.startReview(asked.request.id!);
  await f.service.applyReview(asked.request.id!, { verdict: 'approve', reason: 'ok' });
  const kept = f.service.overview().rules;
  assert.deepEqual(kept.map(rule => [rule.source, rule.providers]), [['owner', ['codex']]]);
  assert.match(f.service.overview().requests.find(item => item.id === asked.request.id)!.review!.reason!, /소유자 규칙/);

  const late = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one', 'r2'));
  await f.service.startReview(late.request.id!);
  await f.service.saveAutoReview({ ...ON, enabled: false });
  assert.equal(await f.service.applyReview(late.request.id!, { verdict: 'approve', reason: 'ok' }), undefined);
  const item = f.service.overview().requests.find(entry => entry.id === late.request.id)!;
  assert.deepEqual([item.status, item.review!.status, f.service.overview().rules.length], ['pending', 'skipped', 1]);
});

test('a rule is classified by all its words: dangerous options in any spelling, paths, wrappers and hidden subcommands go to the owner; harmless options do not', () => {
  const cwd = '/work/shop';
  for (const value of ['RM -rf node_modules', 'GIT push', 'CURL https://x', 'git reset HEAD --hard', 'git reflog expire', 'git checkout ./', 'git restore :/',
    'npx rimraf dist', 'npm exec x', 'npm x cowsay', 'node -e x', 'python3 -c x', 'python3.12 manage.py', 'go run main.go', 'git config alias.x', 'find . -delete',
    'git push origin --del', 'git branch --del x', 'git submodule foreach x', 'git checkout -B x', 'git log --output=x',
    'gh pr merge --admin', 'git branch -C main release', 'git fetch --force origin main:main', 'git fetch origin +main:main',
    'gh release --repo owner/repo delete v1', 'gh pr --repo owner/repo close 33',
    'git push --force-with-lease', 'git push --force-with-lease=main:abc', 'git push origin +main', 'git push origin :main', 'git push -vf origin',
    'git branch -d feature', 'git tag -d v1', '/bin/rm -rf dist', 'xargs rm -rf', 'timeout 5 git push', 'git -C /repo push', 'docker container rm', 'env FOO=1 git push'])
    assert.ok(autoReviewBlock({ kind: 'command', value }, cwd), value);
  for (const value of ['git push origin main', 'gh pr merge', 'git tag v1.2.3', 'npm run release', 'cargo publish', 'docker compose up',
    'git push -u origin main', 'gh pr merge --squash', 'git push origin main --follow-tags', 'git commit -m wip', 'git checkout -b x', 'git diff --text', 'git rebase -X theirs main', 'git commit -m clean'])
    assert.equal(autoReviewBlock({ kind: 'command', value }, cwd), undefined, value);
  assert.ok(ruleGuards({ kind: 'command', value: 'git reset' }).claude.includes('Bash(git reset * --hard*)'), 'a never-allowed continuation is guarded');
  assert.ok(ruleGuards({ kind: 'command', value: 'git rebase' }).claude.includes('Bash(git rebase * --exec*)'), 'git rebase --exec runs a shell');
  assert.equal(autoReviewBlock({ kind: 'claude', value: 'Edit(//work/shop/src/**)' }, cwd), undefined);
  for (const value of ['Glob(//etc/**)', 'Grep(//work/other)', 'Edit(//work/shop/.git/hooks/**)', 'Write(//work/shop/.claude/settings.json)', 'Edit(//work/shop/**)', 'Edit(//work/shop/*/hooks/**)', 'Edit(//work/shop/{.git,src}/**)'])
    assert.ok(autoReviewBlock({ kind: 'claude', value }, cwd), value);
});

test('Claude never gets a guard ending in :* (its older prefix syntax); a :ref is denied only when more follows', () => {
  const guards = ruleGuards({ kind: 'command', value: 'git push' }).claude;
  assert.ok(guards.every(pattern => !pattern.endsWith(':*)')), guards.join(' '));
  assert.ok(guards.includes('Bash(git push * :* *)'));
});

test('where the owner has an overlapping rule, the reviewer does not add one: the owner decides', async t => {
  const f = await fixture(t);
  await f.service.save({ kind: 'command', value: 'git push origin sandbox', providers: ['claude', 'codex'], scope: 'project', cwd: f.project });
  await f.service.saveAutoReview(ON);
  const asked = await f.service.request({ kind: 'command', value: 'git push', providers: ['claude', 'codex'], scope: 'project', reason: 'push' }, agent('claude:one'));
  await f.service.startReview(asked.request.id!);
  await f.service.applyReview(asked.request.id!, { verdict: 'approve', reason: 'ok' });
  const item = f.service.overview().requests.find(entry => entry.id === asked.request.id)!;
  assert.deepEqual([item.status, item.review!.verdict], ['pending', 'owner']);
  assert.match(item.review!.reason!, /겹치는 소유자 규칙/);
  assert.equal(f.service.claudeSettings(f.project), JSON.stringify({ permissions: { allow: ['Bash(git push origin sandbox *)'] } }));

  // The owner changing what a reviewer's rule allows makes it theirs; a note alone keeps its deny rules.
  const other = await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one', 'r2'));
  await f.service.startReview(other.request.id!);
  await f.service.applyReview(other.request.id!, { verdict: 'approve', reason: 'ok' });
  const rule = f.service.overview().rules.find(entry => entry.value === 'gh release create')!;
  await f.service.save({ id: rule.id, kind: 'command', value: 'gh release create', providers: ['claude'], scope: 'project', cwd: f.project, note: 'mine' });
  assert.equal(f.service.overview().rules.find(entry => entry.id === rule.id)!.source, 'auto');
  await f.service.save({ id: rule.id, kind: 'command', value: 'gh release create v2', providers: ['claude'], scope: 'project', cwd: f.project });
  assert.equal(f.service.overview().rules.find(entry => entry.id === rule.id)!.source, 'owner');
});

test('an agent the reviewer cannot tell is never sent back for a narrower rule; an oversized input fails to the owner', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const reviewer = new PermissionReviewer({ service: f.service, sources: sources(f, []), reachable: () => false, notify: async () => {},
    model: async () => ({ verdict: 'narrow', rule: null, suggestion: 'gh release create v1', reason: '더 좁게' }) });
  const { request } = await f.service.request({ kind: 'command', value: 'gh release', scope: 'project', reason: 'release' }, agent('claude:one'));
  reviewer.wake();
  await reviewer.flush();
  const item = f.service.overview().requests.find(entry => entry.id === request.id)!;
  assert.deepEqual([item.status, item.review!.verdict], ['pending', 'owner']);
  assert.match(item.review!.reason!, /gh release create v1/);

  const huge = new PermissionReviewer({ service: f.service, reachable: () => true, notify: async () => {}, model: async () => { throw new Error('never asked'); },
    sources: sources(f, [], { authority: async () => ({ skills: Array.from({ length: 12 }, (_, index) => ({ name: `s${index}`, description: '', body: 'x'.repeat(40_000) })) }) }) });
  const big = await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one', 'r2'));
  huge.wake();
  await huge.flush();
  const failed = f.service.overview().requests.find(entry => entry.id === big.request.id)!;
  assert.deepEqual([failed.status, failed.review!.status], ['pending', 'skipped']);
});

test('the owner’s words reach the reviewer whole, and a review whose end could not be saved is taken again', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const long = `${'Ship the release. '.repeat(600)}Pushing needs my separate approval.`;
  let prompt = '';
  const reviewer = new PermissionReviewer({ service: f.service, sources: sources(f, [], { conversation: async () => ({ messages: [{ id: 'u', role: 'user', text: long, timestamp: '' }], complete: true }) }), reachable: () => true, notify: async () => {},
    model: async request => { prompt = request.prompt; return { verdict: 'owner', rule: null, suggestion: null, reason: '분리 승인 필요' }; } });
  const { request } = await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one'));
  reviewer.wake();
  await reviewer.flush();
  assert.match(JSON.parse(prompt).authority.ownerWords[0].text, /Pushing needs my separate approval\.$/);
  // Started, but its end was never recorded: the next review takes it again instead of leaving it stuck.
  const stuck = await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one', 'r2'));
  await f.service.startReview(stuck.request.id!);
  assert.equal(f.service.nextReview()?.id, stuck.request.id);
  assert.equal(await f.service.startReview(stuck.request.id!), true);
  assert.equal(f.service.overview().requests.find(item => item.id === request.id)!.review!.verdict, 'owner');
});

test('a narrower-rule answer the agent could not be sent goes back to the owner', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const reviewer = new PermissionReviewer({ service: f.service, sources: sources(f, []), reachable: () => true,
    notify: async () => { throw Object.assign(new Error('queue full'), { statusCode: 429 }); },
    model: async () => ({ verdict: 'narrow', rule: null, suggestion: 'gh release create v1', reason: '더 좁게' }) });
  const { request } = await f.service.request({ kind: 'command', value: 'gh release', scope: 'project', reason: 'release' }, agent('claude:one'));
  reviewer.wake();
  await reviewer.flush();
  const item = f.service.overview().requests.find(entry => entry.id === request.id)!;
  assert.deepEqual([item.status, item.review!.verdict, item.decidedBy], ['pending', 'owner', undefined]);
});

test('an owner rule saved beside an overlapping rule the reviewer allowed replaces it, so nothing of the owner’s is denied', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const asked = await f.service.request({ kind: 'command', value: 'git push', providers: ['claude', 'codex'], scope: 'project', reason: 'push' }, agent('claude:one'));
  await f.service.startReview(asked.request.id!);
  await f.service.applyReview(asked.request.id!, { verdict: 'approve', reason: 'ok' });
  const overview = await f.service.save({ kind: 'command', value: 'git push --force-with-lease', providers: ['claude', 'codex'], scope: 'global' });
  assert.deepEqual(overview.replaced, ['git push']);
  assert.deepEqual(overview.rules.map(rule => rule.value), ['git push --force-with-lease']);
  assert.equal(JSON.parse(f.service.claudeSettings(f.project)!).permissions.deny, undefined);
});

test('when the owner says more while the model answers, the request is reviewed again with it', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const messages = [{ id: 'u1', role: 'user' as const, text: 'Ship the release.', timestamp: '1' }];
  let calls = 0;
  const reviewer = new PermissionReviewer({ service: f.service, reachable: () => true, notify: async () => {},
    sources: sources(f, [], { conversation: async () => ({ messages: [...messages], complete: true }) }),
    model: async () => {
      calls += 1;
      if (calls === 1) { messages.push({ id: 'u2', role: 'user', text: 'Do not push until I say so.', timestamp: '2' }); return { verdict: 'approve', rule: null, suggestion: null, reason: 'release' }; }
      return { verdict: 'owner', rule: null, suggestion: null, reason: '소유자가 push를 막았습니다' };
    } });
  const { request } = await f.service.request({ kind: 'command', value: 'git push origin main', scope: 'project', reason: 'push' }, agent('claude:one'));
  reviewer.wake();
  await reviewer.flush();
  await new Promise(resolve => setTimeout(resolve, 10));
  await reviewer.flush();
  assert.equal(calls, 2);
  const item = f.service.overview().requests.find(entry => entry.id === request.id)!;
  assert.deepEqual([item.status, item.review!.verdict, f.service.overview().rules.length], ['pending', 'owner', 0]);
});


test('an instruction queued while the history is being read is part of the owner’s words', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  const runs: Run[] = [];
  let prompt = '';
  const reviewer = new PermissionReviewer({ service: f.service, reachable: () => true, notify: async () => {},
    sources: sources(f, runs, { conversation: async () => {
      runs.push(run('late', 'Do not deploy to production.', { status: 'queued' }));
      return { messages: [{ id: 'u1', role: 'user', text: 'Ship it.', timestamp: '1' }], complete: true };
    } }),
    model: async request => { prompt = request.prompt; return { verdict: 'owner', rule: null, suggestion: null, reason: '제한' }; } });
  await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one'));
  reviewer.wake();
  await reviewer.flush();
  assert.ok(JSON.parse(prompt).authority.ownerWords.some((word: { text: string }) => word.text === 'Do not deploy to production.'));
});

test('who sent a message is judged by the exact message; an unknown sender is the owner only where no outside content ever came in', async t => {
  const f = await fixture(t);
  await f.service.saveAutoReview(ON);
  let prompt = '';
  const history = [
    { id: 'a', role: 'user' as const, text: 'Review PR #33', timestamp: '1' },
    { id: 'b', role: 'user' as const, text: 'Review PR #33, but do not merge or deploy it.', timestamp: '2' },
    { id: 'c', role: 'user' as const, text: 'An old message whose run is gone', timestamp: '3' },
  ];
  const runs = [run('a', 'Review PR #33', { origin: { kind: 'trigger', triggerId: 't' } }), run('bb', 'Review PR #33, but do not merge or deploy it.')];
  const make = (outside: boolean) => new PermissionReviewer({ service: f.service, reachable: () => true, notify: async () => {},
    sources: sources(f, runs, { conversation: async () => ({ messages: history, complete: true }), outsideInput: () => outside }),
    model: async request => { prompt = request.prompt; return { verdict: 'owner', rule: null, suggestion: null, reason: '확인' }; } });
  await f.service.request({ kind: 'command', value: 'gh pr merge', scope: 'project', reason: 'merge' }, agent('claude:one'));
  const trusted = make(false);
  trusted.wake();
  await trusted.flush();
  let input = JSON.parse(prompt);
  assert.deepEqual(input.authority.ownerWords.map((word: { text: string }) => word.text), ['Review PR #33, but do not merge or deploy it.', 'An old message whose run is gone']);
  assert.equal(input.context.messagesFromAutomation[0].text, 'Review PR #33');
  await f.service.request({ kind: 'command', value: 'gh release create', scope: 'project', reason: 'release' }, agent('claude:one', 'r2'));
  const outside = make(true);
  outside.wake();
  await outside.flush();
  input = JSON.parse(prompt);
  assert.deepEqual(input.authority.ownerWords.map((word: { text: string }) => word.text), ['Review PR #33, but do not merge or deploy it.']);
  assert.ok(input.context.messagesFromAutomation.some((word: { kind: string }) => word.kind === 'sent for unknown sender'));
});
