import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { checkGitHub, GitHubError, type GitHubFetch } from '../../../server/triggers/github.js';
import { KEEP_OPEN, TriggerService, type TriggerExecutor } from '../../../server/triggers/service.js';
import type { Run } from '../../../shared/types.js';
import { GitHubSourceSchema, type TriggerActor, type TriggerInput } from '../../../shared/triggers.js';

const OWNER: TriggerActor = { kind: 'owner', via: 'ui' };

type Issue = { number: number; state?: 'open' | 'closed'; pr?: boolean; association?: string; labels?: string[]; assignees?: string[] };
const item = (issue: Issue, repo: string) => ({ number: issue.number, title: `Issue ${issue.number}`, state: issue.state ?? 'open', body: 'Details',
  author_association: issue.association ?? 'MEMBER', user: { login: 'teammate' }, labels: (issue.labels ?? []).map(name => ({ name })),
  assignees: (issue.assignees ?? []).map(login => ({ login })), html_url: `https://github.com/${repo}/issues/${issue.number}`, created_at: '2026-09-24T00:00:00Z',
  ...(issue.pr ? { pull_request: { url: 'x' } } : {}) });

/** A fake GitHub that honours state, direction and paging, and records assignments and closes. */
function fakeGitHub(repos: Record<string, Issue[]>) {
  const reads: string[] = [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch: GitHubFetch = async (path, _etag, send) => {
    const url = new URL(path, 'https://api.github.com');
    if (send) {
      writes.push({ method: send.method, path: url.pathname, body: send.body });
      const [, repo, number] = /^\/repos\/(.+)\/issues\/(\d+)/.exec(url.pathname) ?? [];
      const issue = repos[repo]?.find(entry => entry.number === Number(number));
      if (!issue) return { status: 404, body: {} };
      if (send.method === 'PATCH') issue.state = 'closed';
      else issue.assignees = [...(issue.assignees ?? []), ...(send.body as { assignees: string[] }).assignees];
      return { status: send.method === 'POST' ? 201 : 200, body: item(issue, repo) };
    }
    if (url.pathname === '/user') return { status: 200, body: { login: 'me' } };
    reads.push(path);
    const repo = /^\/repos\/(.+)\/issues$/.exec(url.pathname)?.[1] ?? '';
    if (!(repo in repos)) return { status: 404, body: {} };
    const page = Number(url.searchParams.get('page') ?? 1);
    const size = Number(url.searchParams.get('per_page') ?? 30);
    const asc = url.searchParams.get('direction') === 'asc';
    const list = repos[repo].filter(issue => url.searchParams.get('state') !== 'open' || (issue.state ?? 'open') === 'open')
      .sort((a, b) => asc ? a.number - b.number : b.number - a.number).slice((page - 1) * size, page * size);
    return { status: 200, body: list.map(issue => item(issue, repo)), remaining: 4000 };
  };
  return { reads, writes, fetch };
}

const openWatch = (values: Record<string, unknown> = {}) => GitHubSourceSchema.shape.watch.parse({ type: 'open-issues', repos: ['octo/app'], ...values });

test('an open-issues check lists every open issue oldest first, and forgets taken issues once they close', async () => {
  const repos = { 'octo/app': [{ number: 3 }, { number: 1 }, { number: 2, pr: true }, { number: 4, association: 'NONE' }, { number: 5, state: 'closed' }, { number: 6 }] as Issue[] };
  const github = fakeGitHub(repos);
  const watch = openWatch();
  assert.deepEqual(watch, { type: 'open-issues', repos: ['octo/app'], authorAssociation: ['OWNER', 'MEMBER', 'COLLABORATOR'], concurrency: 1, assign: true, close: true });
  const first = await checkGitHub(watch, { handled: ['octo/app#1', 'octo/app#5'] }, github.fetch);
  assert.deepEqual(first.issues.map(issue => issue.number), [1, 3, 6], 'issues already there count; pull requests and outsiders do not');
  assert.deepEqual(first.cursor.handled, ['octo/app#1'], 'a closed issue is forgotten, so it is taken again if reopened');
  const many = fakeGitHub({ 'octo/app': Array.from({ length: 1001 }, (_, index) => ({ number: index + 1 })) });
  await assert.rejects(checkGitHub(watch, {}, many.fetch), GitHubError);
});

async function fixture(t: TestContext, github: ReturnType<typeof fakeGitHub>) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-open-issues-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const clock = { now: Date.parse('2026-09-24T00:00:30.000Z') };
  const runs: Run[] = [];
  const executor: TriggerExecutor = {
    submitAutoPrompt: async () => { throw new Error('unused'); },
    getAutoPrompt: () => undefined,
    create: async (input, internal) => {
      const id = `${input.provider}:${randomUUID()}`;
      const run: Run = { id: randomUUID(), sessionId: id, prompt: input.prompt, status: 'running', createdAt: '', output: '', autoPromptId: internal.autoPromptId, origin: internal.origin };
      runs.push(run);
      return { run, session: { id, nativeId: 'n', provider: input.provider, title: '', cwd: project, project: 'project', status: 'idle', statusReason: '', createdAt: '', updatedAt: '',
        lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } };
    },
    enqueue: async () => { throw new Error('unused'); },
    runs: () => structuredClone(runs),
    session: () => undefined,
  };
  const service = new TriggerService({ stateDir: directory, executor, now: () => clock.now, tickMs: 60_000, ghToken: async () => 'gho_cli_token', githubTransport: () => github.fetch });
  await service.start();
  t.after(async () => { service.close(); await service.settle(); await rm(directory, { recursive: true, force: true }); });
  const step = async () => { await service.tick(); for (let wait = 0; service.inFlight() && wait < 300; wait++) await new Promise(resolve => setTimeout(resolve, 5)); await service.tick(); };
  const finish = (index: number, output = 'Done.', status: Run['status'] = 'completed') => Object.assign(runs[index], { status, output });
  return { project, clock, runs, service, step, finish };
}

const queue = (project: string, watch: Record<string, unknown> = {}, policy: TriggerInput['policy'] = { overlap: 'skip', maxEventsPerHour: 20 }): TriggerInput => ({
  name: 'Issue queue', enabled: true,
  source: GitHubSourceSchema.parse({ kind: 'github', schedule: { type: 'interval', everySeconds: 300 }, auth: { type: 'gh' }, account: 'me', watch: openWatch(watch) }),
  handler: { kind: 'task', instructions: 'Fix the issue', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: project } },
  policy,
});

const numberOf = (event: { summary: string }) => Number(/#(\d+)/.exec(event.summary)?.[1]);
const numbers = (service: TriggerService) => service.events().map(numberOf).reverse();

test('open issues are worked on one at a time: assigned when started, closed when done, and the next taken at once', async t => {
  const repos = { 'octo/app': [{ number: 1 }, { number: 2 }, { number: 3 }] as Issue[] };
  const github = fakeGitHub(repos);
  const f = await fixture(t, github);
  await f.service.create(queue(f.project), OWNER);
  f.clock.now += 300_000;
  await f.step();
  assert.deepEqual(numbers(f.service), [1], 'the first check already takes the oldest existing issue, and only one');
  assert.match(f.runs[0].prompt, /Tower assigned the issue to me[\s\S]*TOWER_KEEP_ISSUE_OPEN[\s\S]*Fix the issue/);
  assert.deepEqual(github.writes, [{ method: 'POST', path: '/repos/octo/app/issues/1/assignees', body: { assignees: ['me'] } }]);
  assert.ok(f.service.events()[0].issueActions?.assignedAt);

  const reads = github.reads.length;
  f.clock.now += 300_000;
  await f.step();
  assert.deepEqual(numbers(f.service), [1], 'nothing more is taken while it works');
  assert.equal(github.reads.length, reads, 'and GitHub is not even asked');

  f.finish(0);
  f.clock.now += 1000;
  await f.step();
  assert.equal(repos['octo/app'][0].state, 'closed');
  assert.ok(f.service.events().find(event => numberOf(event) === 1)?.issueActions?.closedAt);
  f.clock.now += 1000;
  await f.step();
  assert.deepEqual(numbers(f.service), [1, 2], 'the next issue is taken without waiting for the next scheduled check');

  f.finish(1, `Needs a decision.\n${KEEP_OPEN}`);
  f.clock.now += 1000;
  await f.step();
  f.clock.now += 1000;
  await f.step();
  assert.equal(repos['octo/app'][1].state ?? 'open', 'open', 'a run that asks to keep its issue open leaves it open');
  assert.equal(f.service.events().find(event => numberOf(event) === 2)?.issueActions?.keptOpen, true);
  assert.deepEqual(numbers(f.service), [1, 2, 3], 'and the queue moves on');

  f.finish(2, 'Failed', 'error');
  f.clock.now += 300_000;
  await f.step();
  assert.equal(repos['octo/app'][2].state ?? 'open', 'open', 'a failed run never closes its issue');
  assert.deepEqual(numbers(f.service), [1, 2, 3], 'an issue already taken is not taken again while it stays open');
  assert.equal(github.writes.filter(write => write.method === 'PATCH').length, 1);
});

test('open issues wait for the hourly limit instead of pausing, and several may run at once', async t => {
  const repos = { 'octo/app': [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }] as Issue[] };
  const github = fakeGitHub(repos);
  const f = await fixture(t, github);
  const trigger = await f.service.create(queue(f.project, { concurrency: 2, assign: false }, { overlap: 'skip', maxEventsPerHour: 3 }), OWNER);
  f.clock.now += 300_000;
  await f.step();
  assert.deepEqual(numbers(f.service), [1, 2], 'two at once, although the trigger policy says skip');
  assert.ok(f.service.events().every(event => event.status === 'running'));
  assert.equal(github.writes.length, 0, 'nothing is assigned when assigning is off');
  f.finish(0); f.finish(1);
  f.clock.now += 1000;
  await f.step();
  f.clock.now += 1000;
  await f.step();
  assert.deepEqual(numbers(f.service), [1, 2, 3], 'only one more fits in the hour');
  const summary = f.service.overview().triggers.find(item => item.id === trigger.id);
  assert.equal(summary?.paused, undefined, 'the trigger is not paused');
  f.finish(2);
  f.clock.now += 60 * 60 * 1000;
  await f.step();
  assert.deepEqual(numbers(f.service), [1, 2, 3, 4], 'the next hour goes on');
});

test('an issue still being worked on is not taken again after the trigger is turned off and on', async t => {
  const repos = { 'octo/app': [{ number: 1 }, { number: 2 }] as Issue[] };
  const f = await fixture(t, fakeGitHub(repos));
  const trigger = await f.service.create(queue(f.project, { concurrency: 2 }), OWNER);
  f.clock.now += 300_000;
  await f.step();
  f.finish(1);
  f.clock.now += 1000;
  await f.step();
  const off = await f.service.setEnabled(trigger.id, false, trigger.revision, OWNER);
  await f.service.setEnabled(trigger.id, true, off.revision, OWNER);
  f.clock.now += 300_000;
  await f.step();
  f.clock.now += 300_000;
  await f.step();
  assert.deepEqual(numbers(f.service), [1, 2], 'issue 1 is still running, and issue 2 is closed');
});
