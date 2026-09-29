import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRunner } from '../../../server/repositories/git.js';
import { WorktreeJanitor, groupFamilies, worktreeCleanupFor } from '../../../server/worktrees/janitor.js';
import { transcriptCreations, transcriptMentions } from '../../../server/worktrees/transcripts.js';
import { parseCwdList } from '../../../server/worktrees/process-cwds.js';
import type { Run, Session } from '../../../shared/types.js';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
const iso = (ms: number) => new Date(ms).toISOString();
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

async function setup(t: test.TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tower-worktrees-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, 'origin.git'), work = join(dir, 'work'), state = join(dir, 'state'), transcripts = join(dir, 'transcripts');
  await Promise.all([mkdir(state), mkdir(transcripts)]);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
  execFileSync('git', ['clone', '-q', remote, work], { env, stdio: 'pipe' });
  git(work, 'checkout', '-qb', 'main');
  await writeFile(join(work, 'a.txt'), 'first');
  await writeFile(join(work, '.gitignore'), 'node_modules/\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'first'); git(work, 'push', '-q', '-u', 'origin', 'main');
  let tool = 0;
  /** Runs `git worktree add` as an agent's Bash call would and returns that call's transcript rows. */
  const add = (command: string, args: string[], cwd = work) => {
    const id = `toolu_${++tool}`;
    const start = Date.now() - 50;
    git(cwd, 'worktree', 'add', '-q', ...args);
    const end = Date.now() + 50;
    return [
      { type: 'assistant', timestamp: iso(start), cwd, message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] } },
      { type: 'user', timestamp: iso(end), cwd, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Preparing worktree' }] } },
    ];
  };
  const transcript = async (name: string, rows: unknown[]) => { const file = join(transcripts, `${name}.jsonl`); await writeFile(file, lines(...rows)); return file; };
  const born = Date.now() - 60_000;
  const session = (id: string, filePath: string | undefined, extra: Partial<Session> = {}): Session => ({ id: `claude:${id}`, nativeId: id, provider: 'claude', title: id,
    cwd: work, project: 'work', status: 'completed', statusReason: '', createdAt: iso(born), updatedAt: iso(Date.now() + 1000), lastMessage: '', messageCount: 1,
    isSubagent: false, resumable: true, ...(filePath ? { filePath } : {}), ...extra });
  return { dir, work, state, add, transcript, session };
}

function janitor(state: string, world: { sessions: Session[]; closed: Set<string>; automation?: Set<string>; runs?: Run[]; cwds?: string[] | undefined; now?: number },
  extra: Partial<ConstructorParameters<typeof WorktreeJanitor>[0]> = {}) {
  return new WorktreeJanitor({ ...extra, stateDir: state, sessions: () => world.sessions, closedIds: async () => world.closed, finishedAutomation: () => world.automation ?? new Set(),
    runs: () => world.runs ?? [], git: gitRunner(env), home: '/nonexistent-home', now: () => world.now ?? Date.now(), cwds: extra.cwds ?? (async () => 'cwds' in world ? world.cwds : []), firstPassMs: 3_600_000 });
}

test('closing a session removes the clean, published worktrees it made and keeps any that would lose work', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const review = join(dir, 'work.wt-review'), feature = join(dir, 'work-feature'), dirty = join(dir, 'work-dirty'), local = join(dir, 'work-local'), detached = join(dir, 'work-detached'), locked = join(dir, 'work-locked');
  const rows = [
    ...add(`cd ${work} && git fetch -q && git worktree add --detach ../work.wt-review origin/main >/dev/null 2>&1; cd ../work.wt-review`, ['--detach', review, 'origin/main']),
    ...add('git worktree add -b feature ../work-feature origin/main', ['-b', 'feature', feature, 'origin/main']),
    ...add(`git worktree add --detach ${dirty} HEAD`, ['--detach', dirty, 'HEAD']),
    ...add(`git worktree add -b local ${local} origin/main`, ['-b', 'local', local, 'origin/main']),
    ...add(`git worktree add --detach ${detached} HEAD`, ['--detach', detached, 'HEAD']),
    ...add(`git worktree add --lock --detach ${locked} HEAD`, ['--lock', '--detach', locked, 'HEAD']),
  ];
  git(feature, 'push', '-q', '-u', 'origin', 'feature');
  await mkdir(join(review, 'node_modules')); await writeFile(join(review, 'node_modules', 'big.js'), 'installed');
  await writeFile(join(dirty, 'a.txt'), 'edited');
  git(local, 'push', '-q', '-u', 'origin', 'local'); await writeFile(join(local, 'b.txt'), 'b'); git(local, 'add', 'b.txt'); git(local, 'commit', '-qm', 'local only');
  await writeFile(join(detached, 'c.txt'), 'c'); git(detached, 'add', 'c.txt'); git(detached, 'commit', '-qm', 'detached only');
  const world = { sessions: [session('owner', await transcript('owner', rows))], closed: new Set<string>() };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());

  await cleaner.pass();
  assert.ok([review, feature, dirty, local, detached, locked].every(existsSync), 'nothing is removed while the session is open');

  world.closed.add('claude:owner');
  await cleaner.pass();
  assert.equal(existsSync(review), false, 'a detached review checkout goes, with its installed dependencies');
  assert.equal(existsSync(feature), false, 'a pushed branch worktree goes');
  assert.match(git(work, 'branch', '--list', 'feature'), /feature/, 'its branch stays');
  assert.ok(existsSync(work), 'the main working tree is never touched');
  const results = new Map((await worktreeCleanupFor(state, ['claude:owner'])).map(item => [item.path, item]));
  assert.equal(results.get(review)?.state, 'removed');
  assert.deepEqual([results.get(dirty)?.reason, results.get(local)?.reason, results.get(detached)?.reason, results.get(locked)?.reason], ['changes', 'unpushed', 'unpublished', 'locked']);
  assert.ok([dirty, local, detached, locked].every(existsSync));
});

test('a worktree stays while an open session refers to it, made it too, or a process works in it', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const shared = join(dir, 'work.wt-shared'), raced = join(dir, 'work.wt-raced'), busy = join(dir, 'work.wt-busy'), unknown = join(dir, 'work.wt-unknown');
  const sharedRows = add(`git worktree add --detach ${shared} HEAD`, ['--detach', shared, 'HEAD']);
  const racedRows = add(`git worktree add --detach ${raced} HEAD`, ['--detach', raced, 'HEAD']);
  const busyRows = add(`git worktree add --detach ${busy} HEAD`, ['--detach', busy, 'HEAD']);
  const world = {
    sessions: [
      session('done', await transcript('done', [...sharedRows, ...racedRows, ...busyRows])),
      // Told the path in a request: it may still use the folder.
      session('reader', await transcript('reader', [{ type: 'user', timestamp: iso(Date.now()), message: { content: `Continue in ${shared}` } }])),
      // Only listed it in tool output, or saw it in the git status Claude Code injects: that is not a reference.
      session('lister', await transcript('lister', [{ type: 'user', timestamp: iso(Date.now()), toolUseResult: { stdout: busy }, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: `${busy}\n${raced}` }] } },
        { type: 'attachment', timestamp: iso(Date.now()), attachment: { type: 'session_context', content: `?? ../work.wt-busy/\n?? ../work.wt-raced/` } }])),
      // A fork holds a copy of the command that made it.
      session('fork', await transcript('fork', racedRows)),
    ],
    closed: new Set(['claude:done']), cwds: [join(busy, 'src')] as string[] | undefined, now: Date.now(),
  };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  const results = new Map((await worktreeCleanupFor(state, ['claude:done'])).map(item => [item.path, item]));
  assert.deepEqual([results.get(shared)?.reason, results.get(shared)?.detail], ['openSession', 'reader']);
  assert.deepEqual([results.get(raced)?.reason, results.get(raced)?.detail], ['openSession', 'fork'], 'a session holding the same command names the folder');
  assert.equal(results.get(busy)?.reason, 'process');

  // Once the others are closed and the process is gone, the next check an hour later removes them all.
  world.closed = new Set(['claude:done', 'claude:reader', 'claude:fork']);
  world.cwds = undefined;
  const unknownRows = add(`git worktree add --detach ${unknown} HEAD`, ['--detach', unknown, 'HEAD']);
  world.sessions[0] = session('done', await transcript('done', [...sharedRows, ...racedRows, ...busyRows, ...unknownRows]), { updatedAt: iso(Date.now() + 2000) });
  world.now += 61 * 60_000;
  await cleaner.pass();
  assert.equal((await worktreeCleanupFor(state, ['claude:done'])).find(item => item.path === unknown)?.reason, 'processesUnknown', 'unreadable processes keep everything');
  world.cwds = [];
  world.now += 61 * 60_000;
  await cleaner.pass();
  assert.deepEqual([shared, raced, busy, unknown].map(existsSync), [false, false, false, false]);
});

test('finished automation waits out its grace; working families and agent runs without a known launcher are left alone', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const trigger = join(dir, 'work.wt-trigger'), orphan = join(dir, 'work.wt-orphan'), working = join(dir, 'work.wt-working'), child = join(dir, 'work.wt-child');
  const now = Date.now();
  const world = {
    sessions: [
      session('trigger', await transcript('trigger', add(`git worktree add --detach ${trigger} HEAD`, ['--detach', trigger, 'HEAD'])), { launchedBy: { kind: 'trigger', triggerId: 't' }, updatedAt: iso(now) }),
      session('orphan', await transcript('orphan', add(`git worktree add --detach ${orphan} HEAD`, ['--detach', orphan, 'HEAD'])), { launchedByAgent: true, updatedAt: iso(now - 3 * 3_600_000) }),
      session('working', await transcript('working', add(`git worktree add --detach ${working} HEAD`, ['--detach', working, 'HEAD'])), { status: 'working' }),
      session('parent', undefined),
      // A launched child's worktree belongs to its launcher's family.
      session('child', await transcript('child', add(`git worktree add --detach ${child} HEAD`, ['--detach', child, 'HEAD'])), { isSubagent: true, parentId: 'claude:parent', parentLink: 'exec', launchedByAgent: true }),
    ],
    closed: new Set(['claude:working']), automation: new Set(['claude:trigger']), now,
  };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.deepEqual([trigger, orphan, working, child].map(existsSync), [true, true, true, true]);
  world.now = now + 31 * 60_000;
  await cleaner.pass();
  assert.equal(existsSync(trigger), false, 'finished trigger work is cleaned after its grace');
  assert.deepEqual([orphan, working, child].map(existsSync), [true, true, true]);
  world.closed.add('claude:parent');
  await cleaner.pass();
  assert.equal(existsSync(child), false, 'closing the launcher cleans what its launched run made');
  assert.equal(existsSync(orphan), true);
});

test('families follow subagents and proven launches; a fork is its own conversation', () => {
  const base = { provider: 'claude' as const, title: '', cwd: '/w', project: 'w', status: 'completed' as const, statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, resumable: true };
  const families = groupFamilies([
    { ...base, id: 'claude:root', nativeId: 'root', isSubagent: false },
    { ...base, id: 'claude:sub', nativeId: 'sub', isSubagent: true, parentId: 'claude:root' },
    { ...base, id: 'codex:run', nativeId: 'run', provider: 'codex', isSubagent: true, parentId: 'claude:sub', parentLink: 'exec' },
    { ...base, id: 'claude:fork', nativeId: 'fork', isSubagent: false, parentId: 'claude:root' },
  ]);
  assert.deepEqual([...families].map(([root, members]) => [root, members.map(member => member.id)]), [['claude:root', ['claude:root', 'claude:sub', 'codex:run']], ['claude:fork', ['claude:fork']]]);
});

test('transcripts give Codex creations with their folders and results, and references without tool output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-worktree-transcripts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codex = join(dir, 'codex.jsonl');
  await writeFile(codex, lines(
    { type: 'session_meta', timestamp: iso(1000), payload: { cwd: '/w/start' } },
    { type: 'turn_context', timestamp: iso(2000), payload: { cwd: '/w/repo' } },
    { type: 'response_item', timestamp: iso(3000), payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'git worktree add ../repo.wt HEAD' }) } },
    { type: 'response_item', timestamp: iso(4000), payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
    { type: 'response_item', timestamp: iso(5000), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'text(await tools.exec_command({cmd:"git worktree add /tmp/other HEAD"}));' } },
  ));
  assert.deepEqual(await transcriptCreations(codex, 'codex', '/h'), [{ path: '/w/repo.wt', start: 3000, end: 4000 }, { path: '/tmp/other', start: 5000 }]);
  assert.deepEqual([...await transcriptMentions(codex, ['repo.wt', 'ok', 'missing'])], ['repo.wt']);
  await assert.rejects(transcriptCreations(join(dir, 'gone.jsonl'), 'claude', '/h'), { code: 'ENOENT' });
});

test('use is judged again right before each removal: a conversation reopened during another removal keeps its worktree', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const first = join(dir, 'work.wt-first'), second = join(dir, 'work.wt-second'), third = join(dir, 'work.wt-third');
  const world = {
    sessions: [
      session('a', await transcript('a', add(`git worktree add --detach ${first} HEAD`, ['--detach', first, 'HEAD']))),
      session('b', await transcript('b', add(`git worktree add --detach ${second} HEAD`, ['--detach', second, 'HEAD']))),
      session('c', await transcript('c', add(`git worktree add --detach ${third} HEAD`, ['--detach', third, 'HEAD']))),
    ],
    closed: new Set(['claude:a', 'claude:b', 'claude:c']), cwds: [] as string[] | undefined,
  };
  const real = gitRunner(env);
  const cleaner = new WorktreeJanitor({ stateDir: state, sessions: () => world.sessions, closedIds: async () => world.closed, finishedAutomation: () => new Set(), runs: () => [],
    home: '/nonexistent-home', cwds: async () => world.cwds, firstPassMs: 3_600_000,
    git: async (cwd, args, timeout) => {
      const output = await real(cwd, args, timeout);
      // While the first is being removed, the owner reopens b and a shell starts in c.
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === first) { world.closed.delete('claude:b'); world.cwds = [third]; }
      return output;
    } });
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.deepEqual([first, second, third].map(existsSync), [false, true, true]);
  assert.equal((await worktreeCleanupFor(state, ['claude:c']))[0]?.reason, 'process');
});

test('the last look before removing sees a run queued meanwhile, and a conversation that works inside the folder', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const queued = join(dir, 'work.wt-queued'), inside = join(dir, 'work.wt-inside');
  // The transcripts of these sessions are not what protects them: the proof lives in a subagent's file.
  const world = {
    sessions: [
      session('q', undefined), session('q-sub', await transcript('q-sub', add(`git worktree add --detach ${queued} HEAD`, ['--detach', queued, 'HEAD'])), { isSubagent: true, parentId: 'claude:q' }),
      session('i', await transcript('i', add(`git worktree add --detach ${inside} HEAD`, ['--detach', inside, 'HEAD']))),
      session('shell', undefined, { cwd: join(inside, 'src') }),
    ],
    closed: new Set(['claude:q', 'claude:i']), runs: [] as Run[],
  };
  // A run is queued on q while the processes are being listed, after every earlier check passed.
  const racing = janitor(state, world, { cwds: async () => { world.runs = [{ id: 'r', sessionId: 'claude:q', prompt: 'more', status: 'queued', createdAt: iso(Date.now()) } as Run]; return []; } });
  await racing.start(); t.after(() => racing.close());
  await racing.pass();
  assert.equal(existsSync(queued), true, 'queued work keeps its worktree');
  assert.equal(existsSync(inside), true);
  const kept = await worktreeCleanupFor(state, ['claude:i']);
  assert.deepEqual([kept[0]?.reason, kept[0]?.detail], ['openSession', 'shell'], 'an open conversation working inside the folder keeps it');
});

test('ownership needs the creation inside the call, and a worktree made again at the same path is not the old one', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const late = join(dir, 'work.wt-late'), again = join(dir, 'work.wt-again');
  const lateRows = add(`git worktree add --detach ${late} HEAD`, ['--detach', late, 'HEAD']);
  // The call ran ten minutes before this worktree existed: some other command made it.
  for (const row of lateRows) (row as { timestamp: string }).timestamp = iso(Date.parse(row.timestamp) - 10 * 60_000);
  const againRows = add(`git worktree add --detach ${again} HEAD`, ['--detach', again, 'HEAD']);
  const world = { sessions: [session('s', await transcript('s', [...lateRows, ...againRows]))], closed: new Set<string>() };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  // Recorded while the session is closed and something keeps it: then removed and made again by someone else.
  world.closed.add('claude:s');
  (world as { cwds?: string[] }).cwds = [again];
  await cleaner.pass();
  assert.equal(existsSync(late), true, 'a creation outside the call is not proof');
  assert.deepEqual((await worktreeCleanupFor(state, ['claude:s'])).map(item => [item.path, item.reason]), [[again, 'process']]);
  git(join(dir, 'work'), 'worktree', 'remove', again);
  git(join(dir, 'work'), 'worktree', 'add', '-q', '--detach', again, 'HEAD');
  await utimes(join(dir, 'work', '.git', 'worktrees', 'work.wt-again', 'commondir'), new Date(), new Date(Date.now() + 3_600_000));
  (world as { cwds?: string[]; now?: number }).cwds = [];
  (world as { now?: number }).now = Date.now() + 2 * 3_600_000;
  await cleaner.pass();
  assert.equal(existsSync(again), true, 'the new worktree at that path is someone else\'s');
  assert.deepEqual(await worktreeCleanupFor(state, ['claude:s']), []);
});

test('branches: a gone upstream lets the worktree go, unpublished commits without an upstream keep it', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const merged = join(dir, 'work-merged'), unpublished = join(dir, 'work-unpublished'), reserved = join(dir, 'work-reserved');
  const rows = [
    ...add(`git worktree add -b merged ${merged} origin/main`, ['-b', 'merged', merged, 'origin/main']),
    ...add(`git worktree add -b unpublished ${unpublished} origin/main`, ['-b', 'unpublished', unpublished, 'origin/main']),
    ...add(`git worktree add --detach ${reserved} HEAD`, ['--detach', reserved, 'HEAD']),
  ];
  // Pushed, merged by squash on the remote and the branch deleted there: its commits are on no remote ref any more.
  git(merged, 'push', '-q', '-u', 'origin', 'merged');
  await writeFile(join(merged, 'm.txt'), 'm'); git(merged, 'add', 'm.txt'); git(merged, 'commit', '-qm', 'merged work'); git(merged, 'push', '-q');
  git(work, 'push', '-q', 'origin', '--delete', 'merged'); git(work, 'fetch', '-q', '--prune');
  git(unpublished, 'branch', '--unset-upstream');
  await writeFile(join(unpublished, 'u.txt'), 'u'); git(unpublished, 'add', 'u.txt'); git(unpublished, 'commit', '-qm', 'never pushed');
  const world = { sessions: [session('s', await transcript('s', rows))], closed: new Set(['claude:s']) };
  const cleaner = janitor(state, world, { reserved: () => [reserved] });
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.equal(existsSync(merged), false);
  assert.match(git(work, 'log', '--oneline', '-1', 'merged'), /merged work/, 'the branch and its commits stay');
  const results = new Map((await worktreeCleanupFor(state, ['claude:s'])).map(item => [item.path, item]));
  assert.deepEqual([results.get(unpublished)?.reason, results.get(unpublished)?.detail], ['unpushed', 'unpublished (1)']);
  assert.equal(results.get(reserved)?.reason, 'reserved', 'a folder a trigger or pinned project uses stays');
});

test('lsof output counts only when lsof finished, and an early stop in a transcript search closes its file', async t => {
  assert.deepEqual(parseCwdList('p1\nfcwd\nn/\np22\nfcwd\nn/Users/owner/work\n'), ['/', '/Users/owner/work']);
  const dir = await mkdtemp(join(tmpdir(), 'tower-worktree-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'big.jsonl');
  await writeFile(file, lines(...Array.from({ length: 20_000 }, (_, index) => ({ type: 'user', message: { content: index ? `line ${index}` : 'names work.wt-x' } }))));
  const open = () => readdirSync('/dev/fd').length;
  const before = open();
  for (let i = 0; i < 20; i++) assert.deepEqual([...await transcriptMentions(file, ['work.wt-x'])], ['work.wt-x']);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(open() - before < 5, `open files grew from ${before} to ${open()}`);
});
