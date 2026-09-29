import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, Run, Session } from '../../../shared/types.js';
import { proposalReady } from '../../../shared/skills.js';
import type { AutoPromptModelRequest } from '../../../server/auto-prompt/native.js';
import { ownerRequests } from '../../../server/skills/advisor.js';
import { SkillService } from '../../../server/skills/service.js';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const minutes = (value: number) => new Date(NOW - value * 60_000).toISOString();

function session(id: string, cwd: string, patch: Partial<Session> = {}): Session {
  return { id: `claude:${id}`, nativeId: id, provider: 'claude', title: `Session ${id}`, cwd, project: 'p', status: 'completed', statusReason: '',
    createdAt: minutes(120), updatedAt: minutes(30), lastRequestAt: minutes(40), lastMessage: '', messageCount: 4, isSubagent: false, resumable: true, ...patch };
}
const message = (role: ChatMessage['role'], text: string, at: number): ChatMessage => ({ id: `${role}-${at}`, role, text, timestamp: minutes(at) });

async function fixture(t: test.TestContext, answer: (request: AutoPromptModelRequest) => unknown) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-advisor-')));
  const home = join(root, 'home'), project = join(home, 'work', 'shop'), other = join(home, 'work', 'blog');
  await mkdir(project, { recursive: true }); await mkdir(other, { recursive: true });
  const stateDir = join(root, 'state');
  const sessions: Session[] = [];
  const runs: Run[] = [];
  const histories = new Map<string, ChatMessage[]>();
  const calls: AutoPromptModelRequest[] = [];
  const service = new SkillService({
    stateDir, homes: { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'), trash: join(stateDir, 'trash'), store: join(stateDir, 'skills'), journal: join(stateDir, 'skills-moves.json') },
    sessions: () => sessions, runs: () => runs, history: async item => histories.get(item.id),
    model: async request => { calls.push(request); return answer(request); }, advise: false,
  });
  await service.start();
  // State writes the test started without waiting finish before the folder goes.
  t.after(async () => { service.close(); await service.flush().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  // Requests before the advisor started are left to the 7-day analysis; these fixtures begin earlier than that.
  const internals = service as unknown as { state: { update(change: (state: { startedAt: string }) => void): Promise<void> }; advisor: { tick(): Promise<void>; now: () => number; deps: { now?: () => number } } };
  internals.advisor.deps.now = () => NOW;
  await internals.state.update(state => { state.startedAt = minutes(24 * 60); });
  return { service, sessions, runs, histories, calls, project, other, stateDir, tick: () => internals.advisor.tick() };
}

const reflection = (patch: Record<string, unknown> = {}) => ({ note: 'Asked for a design, a Codex review, then implementation.', action: 'new', proposalId: '',
  name: 'cross-verified-delivery', description: 'Use for new work: design, cross review, implement, cross review.', body: '1. Design\n2. Codex review', scope: 'global', explicit: false, reason: 'Asked twice', ...patch });

test('the advisor reads only finished sessions the owner worked in here, and only the owner’s own requests', async t => {
  const f = await fixture(t, () => reflection({ action: 'none' }));
  const text = 'Design it first, have Codex Astra review the design, then implement and cross review.';
  f.sessions.push(
    session('own', f.project),
    session('working', f.project, { status: 'working' }),
    session('recent', f.project, { updatedAt: minutes(2) }),
    session('closed', f.project, { closed: true }),
    session('subagent', f.project, { isSubagent: true }),
    session('trigger', f.project, { launchedBy: { kind: 'trigger', triggerId: 't' } }),
    session('slack', f.project),
    session('remote', f.project),
    session('state', join(f.stateDir, 'slack-sessions', 'x')),
    session('master', join(f.stateDir, 'master-session'), { master: true }),
  );
  f.runs.push({ id: 'r1', sessionId: 'claude:slack', origin: { kind: 'slack', workflowId: 'w' }, prompt: '', status: 'completed', createdAt: minutes(50), output: '' },
    { id: 'r2', sessionId: 'claude:remote', origin: { kind: 'owner', controllerId: 'c'.repeat(32) }, prompt: '', status: 'completed', createdAt: minutes(50), output: '' });
  for (const item of f.sessions) f.histories.set(item.id, [message('user', text, 40), message('assistant', 'Done.', 35)]);
  await f.tick();
  assert.deepEqual(new Set(f.calls.map(call => call.prompt.match(/Session "([^"]+)"/)?.[1])), new Set(['Session own', 'Session master']));
  assert.equal(f.calls[0].model, 'sonnet', 'a light model sums sessions up');
  await f.tick();
  assert.equal(f.calls.length, 2, 'a session is read once until the owner asks something new');
  assert.deepEqual(ownerRequests([message('user', '<task-notification><status>done</status></task-notification>', 3), message('user', '[Tower report] finished', 2),
    message('user', 'This session is being continued from a previous conversation that ran out of context.', 1), message('user', 'Real request', 0)]).map(item => item.text), ['Real request']);
});

test('a way of working seen in two sessions becomes a proposal the owner can accept, and a dismissed one never returns', async t => {
  let answer = reflection();
  const f = await fixture(t, () => answer);
  f.sessions.push(session('a', f.project));
  f.histories.set('claude:a', [message('user', 'Design first, then have Codex review before you implement anything.', 40)]);
  await f.tick();
  let [proposal] = (await f.service.overview()).proposals;
  assert.equal(proposal.name, 'cross-verified-delivery');
  assert.equal(proposalReady(proposal), false, 'one session is only watched');
  assert.equal(f.service.summary().proposals, 0);
  assert.equal((await f.service.overview()).notes[0].note, 'Asked for a design, a Codex review, then implementation.');

  answer = reflection({ action: 'reinforce', proposalId: proposal.id, body: '1. Design\n2. Codex review\n3. Implement' });
  f.sessions.push(session('b', f.other));
  f.histories.set('claude:b', [message('user', 'Same as always: design, Codex review, implement, cross review.', 40)]);
  await f.tick();
  [proposal] = (await f.service.overview()).proposals;
  assert.equal(proposalReady(proposal), true);
  assert.equal(proposal.body, '1. Design\n2. Codex review\n3. Implement');
  assert.deepEqual(proposal.evidence.map(item => item.sessionId), ['claude:a', 'claude:b']);
  assert.equal(f.service.summary().proposals, 1);
  assert.match(f.calls[1].prompt, /cross-verified-delivery/, 'the advisor sees the open proposals');

  await f.service.mutate('dismiss', { id: proposal.id });
  assert.equal((await f.service.overview()).proposals.length, 0);
  answer = reflection();
  f.sessions.push(session('c', f.project));
  f.histories.set('claude:c', [message('user', 'Design first, then Codex review, then build it and review again.', 40)]);
  await f.tick();
  assert.equal((await f.service.overview()).proposals.length, 0, 'a declined proposal is not raised again');
  assert.match(f.calls[2].prompt, /cross-verified-delivery \(the owner declined it\)/);
});

test('project proposals stay with their project: the same name in two projects is two proposals', async t => {
  let cwd = '';
  const f = await fixture(t, () => reflection({ name: 'deploy', scope: 'project', explicit: true, description: `Deploy ${cwd}` }));
  f.sessions.push(session('shop', f.project), session('blog', f.other, { updatedAt: minutes(29) }));
  f.histories.set('claude:shop', [message('user', 'Always deploy the shop with the release script after merging.', 40)]);
  f.histories.set('claude:blog', [message('user', 'Always deploy the blog by pushing to the pages branch.', 40)]);
  cwd = f.project; await (f.service as unknown as { advisor: { reflect(session: Session): Promise<void> } }).advisor.reflect(f.sessions[0]);
  cwd = f.other; await (f.service as unknown as { advisor: { reflect(session: Session): Promise<void> } }).advisor.reflect(f.sessions[1]);
  const all = (await f.service.overview()).proposals;
  assert.deepEqual(all.map(item => [item.name, item.cwd]).sort(), [['deploy', f.other], ['deploy', f.project]].sort());
  assert.ok(all.every(proposalReady), 'a rule the owner stated outright is proposed at once');
  const shop = await f.service.overview({ cwd: f.project });
  assert.deepEqual(shop.proposals.map(item => item.cwd), [f.project], 'a project panel shows only its own project proposals');
  await assert.rejects(f.service.overview({ cwd: join(f.project, 'unknown') }), { statusCode: 404 });
});

test('accepting a proposal writes the skill, pins it, and every turn in scope is told to check it', async t => {
  const f = await fixture(t, () => reflection());
  f.sessions.push(session('a', f.project));
  const saved = await f.service.mutate('save', { scope: 'global', name: 'cross-verified-delivery', description: 'Use for new work.', body: 'Steps', pinned: true });
  assert.equal(saved.skills[0].pinned, true);
  await f.service.mutate('save', { scope: 'project', projectCwd: f.project, cwd: f.project, name: 'shop-deploy', description: 'Deploy the shop.', body: 'Steps', pinned: true });
  const inShop = await f.service.turnNotes(session('x', join(f.project)));
  assert.match(inShop!, /- cross-verified-delivery: Use for new work\./);
  assert.match(inShop!, /- shop-deploy: Deploy the shop\./);
  const inBlog = await f.service.turnNotes(session('y', f.other));
  assert.match(inBlog!, /cross-verified-delivery/);
  assert.doesNotMatch(inBlog!, /shop-deploy/, 'a project skill is never named outside its project');
  await f.service.mutate('pin', { dir: saved.skills[0].dir, pinned: false });
  assert.doesNotMatch((await f.service.turnNotes(session('y', f.other))) ?? '', /cross-verified-delivery/);
});

test('the 7-day analysis proposes only patterns backed by sessions it was shown', async t => {
  const f = await fixture(t, request => {
    const labels = [...request.prompt.matchAll(/^(S\d+) · "([^"]+)"/gm)].map(match => [match[1], match[2]]);
    const shop = labels.find(([, title]) => title === 'Session shop')![0];
    return { proposals: [
      { name: 'cross-review', description: 'Review with Claude and Codex.', body: 'Steps', scope: 'global', project: '', explicit: false, reason: 'r', sessions: labels.map(([label]) => label) },
      { name: 'invented', description: 'd', body: 'b', scope: 'global', project: '', explicit: false, reason: 'r', sessions: ['S99'] },
      { name: 'shop-deploy', description: 'd', body: 'b', scope: 'project', project: f.project, explicit: false, reason: 'r', sessions: labels.map(([label]) => label) },
      { name: 'elsewhere', description: 'd', body: 'b', scope: 'project', project: '/etc', explicit: false, reason: 'r', sessions: [shop] },
    ] };
  });
  f.sessions.push(session('shop', f.project), session('blog', f.other), session('old', f.other, { updatedAt: minutes(10 * 24 * 60) }));
  for (const item of f.sessions) f.histories.set(item.id, [message('user', 'Review this PR with Claude and Codex, then summarise.', 30), message('user', 'An old request', 9 * 24 * 60)]);
  const added = await (f.service as unknown as { advisor: { backfill(days: number): Promise<number> } }).advisor.backfill(7);
  assert.equal(added, 3);
  assert.doesNotMatch(f.calls[0].prompt, /An old request/, 'requests older than the period are left out');
  assert.doesNotMatch(f.calls[0].prompt, /Session old/);
  const proposals = (await f.service.overview()).proposals;
  const byName = new Map(proposals.map(item => [item.name, item]));
  assert.equal(byName.has('invented'), false, 'no proposal without a real session behind it');
  assert.deepEqual(byName.get('shop-deploy')?.evidence.map(item => item.sessionId), ['claude:shop'], 'a project proposal rests only on that project’s sessions');
  assert.equal(byName.get('elsewhere')?.scope, 'global', 'a folder the advisor was not shown never becomes a project');
});

test('a project proposal is never reinforced from another project’s session', async t => {
  let answer: Record<string, unknown> = reflection({ name: 'deploy', scope: 'project', description: 'Deploy the shop', body: 'shop steps' });
  const f = await fixture(t, () => answer);
  const advisor = (f.service as unknown as { advisor: { reflect(session: Session): Promise<void> } }).advisor;
  f.sessions.push(session('shop', f.project), session('blog', f.other));
  f.histories.set('claude:shop', [message('user', 'Deploy the shop with the release script after merging, as always.', 40)]);
  f.histories.set('claude:blog', [message('user', 'Deploy the blog by pushing to the pages branch, as always.', 40)]);
  await advisor.reflect(f.sessions[0]);
  const [shop] = (await f.service.overview()).proposals;
  answer = reflection({ action: 'reinforce', proposalId: shop.id, name: 'deploy', scope: 'project', description: 'Deploy the blog', body: 'blog steps' });
  await advisor.reflect(f.sessions[1]);
  const proposals = (await f.service.overview()).proposals;
  const kept = proposals.find(item => item.id === shop.id)!;
  assert.equal(kept.body, 'shop steps');
  assert.deepEqual(kept.evidence.map(item => item.sessionId), ['claude:shop']);
  assert.deepEqual(proposals.find(item => item.id !== shop.id)?.cwd, f.other, 'the blog gets its own proposal instead');
});

test('a session someone else worked in stays excluded after its runs are gone, even when that happened while the advisor was off', async t => {
  const f = await fixture(t, () => reflection({ action: 'none' }));
  f.sessions.push(session('remote', f.project), session('made', f.project));
  for (const item of f.sessions) f.histories.set(item.id, [message('user', 'A request long enough to be worth reading.', 40)]);
  await f.service.mutate('settings', { enabled: false });
  // A controller's turn in a session the owner started here; the worker reports every change of its runs.
  f.runs.push({ id: 'r', sessionId: 'claude:remote', origin: { kind: 'owner', controllerId: 'c'.repeat(32) }, prompt: '', status: 'completed', createdAt: minutes(50), output: '' });
  f.service.recordRuns();
  await f.service.flush();
  f.runs.length = 0;
  (f.service as unknown as { options: { origin: (id: string) => unknown } }).options.origin = id => id === 'claude:made' ? { kind: 'trigger', untrustedInput: false } : undefined;
  await f.service.mutate('settings', { enabled: true });
  await f.tick();
  assert.equal(f.calls.length, 0);
});

test('a session someone else joins while the advisor is busy is not read or sent afterwards', async t => {
  let joined: (() => void) | undefined;
  const f = await fixture(t, async () => { joined?.(); return reflection({ action: 'none' }); });
  f.sessions.push(session('first', f.project, { updatedAt: minutes(31) }), session('second', f.project));
  for (const item of f.sessions) f.histories.set(item.id, [message('user', 'A request long enough to be worth reading.', 40)]);
  const read: string[] = [];
  const history = (f.service as unknown as { advisor: { deps: { history: (session: Session, limit: number) => Promise<ChatMessage[] | undefined> } } }).advisor.deps;
  const original = history.history;
  history.history = async (item, limit) => { read.push(item.id); return original(item, limit); };
  // While the first session's answer is awaited, a controlling computer sends a turn into the second one.
  joined = () => { joined = undefined; f.runs.push({ id: 'r', sessionId: 'claude:second', origin: { kind: 'owner', controllerId: 'c'.repeat(32) }, prompt: '', status: 'queued', createdAt: minutes(1), output: '' }); f.service.recordRuns(); };
  await f.tick();
  assert.deepEqual(read, ['claude:first']);
  assert.equal(f.calls.length, 1);

  // The 7-day analysis leaves out a session joined while it was reading the others.
  f.runs.length = 0;
  f.sessions.push(session('third', f.other));
  f.histories.set('claude:third', [message('user', 'Another request long enough to be worth reading.', 40)]);
  history.history = async (item, limit) => {
    if (item.id === 'claude:third') { f.runs.push({ id: 'r3', sessionId: 'claude:first', origin: { kind: 'slack', workflowId: 'w' }, prompt: '', status: 'queued', createdAt: minutes(1), output: '' }); f.service.recordRuns(); }
    return original(item, limit);
  };
  await (f.service as unknown as { advisor: { backfill(days: number): Promise<number> } }).advisor.backfill(7).catch(() => 0);
  const sent = f.calls.at(-1)!.prompt;
  assert.doesNotMatch(sent, /Session first/);
  assert.match(sent, /Session third/);
});

test('a session the owner closes while the advisor is busy is not read or sent afterwards', async t => {
  let closing: (() => Promise<void>) | undefined;
  const f = await fixture(t, async () => { await closing?.(); return reflection({ action: 'none' }); });
  f.sessions.push(session('first', f.project, { updatedAt: minutes(31) }), session('second', f.project));
  for (const item of f.sessions) f.histories.set(item.id, [message('user', 'A request long enough to be worth reading.', 40)]);
  // The page closes it in another process: the worker's session objects do not change, only the saved list does.
  closing = async () => { closing = undefined; await writeFile(join(f.stateDir, 'closed-sessions.json'), JSON.stringify(['claude:second']), { mode: 0o600 }); };
  await f.tick();
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.calls[0].prompt, /Session second/);
  await f.tick();
  assert.equal(f.calls.length, 1, 'still closed on the next round');

  // The 7-day analysis drops a session closed while it was reading the others.
  await writeFile(join(f.stateDir, 'closed-sessions.json'), '[]', { mode: 0o600 });
  f.sessions.push(session('third', f.other, { updatedAt: minutes(29) }));
  f.histories.set('claude:third', [message('user', 'Another request long enough to be worth reading.', 40)]);
  const deps = (f.service as unknown as { advisor: { deps: { history: (session: Session, limit: number) => Promise<ChatMessage[] | undefined> } } }).advisor.deps;
  const original = deps.history;
  deps.history = async (item, limit) => {
    if (item.id === 'claude:first') await writeFile(join(f.stateDir, 'closed-sessions.json'), JSON.stringify(['claude:third']), { mode: 0o600 });
    return original(item, limit);
  };
  await (f.service as unknown as { advisor: { backfill(days: number): Promise<number> } }).advisor.backfill(7).catch(() => 0);
  const sent = f.calls.at(-1)!.prompt;
  assert.match(sent, /Session first/);
  assert.doesNotMatch(sent, /Session third/);
});

test('a pin on either copy of a skill pins it, and merging the copies keeps it pinned', async t => {
  const f = await fixture(t, () => reflection());
  const home = (f.service as unknown as { files: { homes: { agentsHome: string; claudeHome: string } } }).files.homes;
  for (const root of [home.agentsHome, home.claudeHome]) {
    await mkdir(join(root, 'skills', 'wrangler'), { recursive: true });
    await writeFile(join(root, 'skills', 'wrangler', 'SKILL.md'), '---\nname: wrangler\ndescription: Deploy Workers.\n---\nSteps\n');
  }
  const claudeCopy = join(home.claudeHome, 'skills', 'wrangler');
  await (f.service as unknown as { state: { update(change: (state: { pinned: { dir: string }[] }) => void): Promise<void> } }).state.update(state => { state.pinned.push({ dir: claudeCopy }); });
  const [listed] = (await f.service.overview()).skills;
  assert.equal(listed.pinned, true);
  assert.match((await f.service.turnNotes(session('x', f.project)))!, /- wrangler: Deploy Workers\./);
  const after = await f.service.mutate('merge', { dir: claudeCopy });
  assert.equal(after.skills[0].copies, undefined);
  assert.equal(after.skills[0].pinned, true);
  assert.match((await f.service.turnNotes(session('x', f.project)))!, /wrangler/);
  await f.service.mutate('pin', { dir: after.skills[0].dir, pinned: false });
  assert.equal(await f.service.turnNotes(session('x', f.project)), undefined);
});

test('a pin on a copy survives a merge that stops half way', async t => {
  const f = await fixture(t, () => reflection());
  const files = (f.service as unknown as { files: { homes: { agentsHome: string; claudeHome: string; codexHome: string; trash: string }; merge: (dir: string, cwd?: string) => Promise<unknown> } }).files;
  for (const root of [files.homes.agentsHome, files.homes.claudeHome, files.homes.codexHome]) {
    await mkdir(join(root, 'skills', 'wrangler'), { recursive: true });
    await writeFile(join(root, 'skills', 'wrangler', 'SKILL.md'), '---\nname: wrangler\ndescription: Deploy Workers.\n---\nSteps\n');
  }
  const claudeCopy = join(files.homes.claudeHome, 'skills', 'wrangler');
  await (f.service as unknown as { state: { update(change: (state: { pinned: { dir: string }[] }) => void): Promise<void> } }).state.update(state => { state.pinned.push({ dir: claudeCopy }); });
  // The merge replaces the Claude copy, then fails on the next one.
  const merge = files.merge.bind(files);
  files.merge = async (dir, cwd) => { await merge(dir, cwd).catch(() => {}); throw new Error('disk full'); };
  await assert.rejects(f.service.mutate('merge', { dir: claudeCopy }));
  assert.equal((await f.service.overview()).skills[0].pinned, true);
  assert.match((await f.service.turnNotes(session('x', f.project)))!, /wrangler/);
});
