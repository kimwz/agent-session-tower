import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRunner } from '../../../server/repositories/git.js';
import { WorktreeJanitor, groupFamilies, worktreeCleanupFor } from '../../../server/worktrees/janitor.js';
import { transcriptCreations, transcriptMentions } from '../../../server/worktrees/transcripts.js';
import { parseCwdList } from '../../../server/worktrees/process-cwds.js';
import { readPrivateJson } from '../../../server/stores/private-json.js';
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

function janitor(state: string, world: { sessions: Session[]; closed: Set<string>; automation?: Set<string>; runs?: Run[]; cwds?: string[] | undefined; commands?: string[]; now?: number },
  extra: Partial<ConstructorParameters<typeof WorktreeJanitor>[0]> = {}) {
  return new WorktreeJanitor({ stateDir: state, sessions: () => world.sessions, closedIds: async () => world.closed, finishedAutomation: () => world.automation ?? new Set(),
    runs: () => world.runs ?? [], git: gitRunner(env), home: '/nonexistent-home', now: () => world.now ?? Date.now(), cwds: async () => 'cwds' in world ? world.cwds : [], commands: async () => (world.commands ?? []).map(args => ({ args })), firstPassMs: 3_600_000, ...extra });
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
  assert.deepEqual(await transcriptCreations(codex, 'codex', '/h'), [{ path: '/w/repo/../repo.wt', start: 3000, end: 4000 }, { path: '/tmp/other', start: 5000 }]);
  assert.deepEqual([...(await transcriptMentions(codex, ['repo.wt', 'ok', 'missing'])).found], ['repo.wt']);
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
  const cleaner = janitor(state, world, { reserved: async () => [reserved] });
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
  for (let i = 0; i < 20; i++) assert.deepEqual([...(await transcriptMentions(file, ['work.wt-x'])).found], ['work.wt-x']);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(open() - before < 5, `open files grew from ${before} to ${open()}`);
});

test('a worktree with another inside it stays; a conversation reopened while programs are listed keeps what it uses', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const outer = join(dir, 'work.wt-outer'), shared = join(dir, 'work.wt-shared');
  const rows = [...add(`git worktree add --detach ${outer} HEAD`, ['--detach', outer, 'HEAD']), ...add(`git worktree add --detach ${shared} HEAD`, ['--detach', shared, 'HEAD'])];
  await writeFile(join(outer, '.git-info-exclude-marker'), '');
  git(outer, 'rm', '-q', '--cached', '--ignore-unmatch', 'x');
  await writeFile(join(work, '.git', 'info', 'exclude'), '.worktrees/\n.git-info-exclude-marker\n');
  // A child worktree with work in progress, in a folder the outer one ignores.
  const inner = join(outer, '.worktrees', 'inner');
  git(work, 'worktree', 'add', '-q', '--detach', inner, 'HEAD');
  await writeFile(join(inner, 'a.txt'), 'unsaved work');
  const world = {
    sessions: [session('a', await transcript('a', rows)), session('b', await transcript('b', [{ type: 'user', timestamp: iso(Date.now()), message: { content: `keep using ${shared}` } }]))],
    closed: new Set(['claude:a', 'claude:b']),
  };
  // b is reopened while the processes are being listed.
  const cleaner = janitor(state, world, { cwds: async () => { world.closed.delete('claude:b'); return []; } });
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.deepEqual([outer, inner, shared].map(existsSync), [true, true, true]);
  const results = new Map((await worktreeCleanupFor(state, ['claude:a'])).map(item => [item.path, item.reason]));
  assert.deepEqual([results.get(outer), results.get(shared)], ['nested', 'openSession']);
});

test('a pause stops a pass before it removes anything, and an interrupted scan is read again', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const target = join(dir, 'work.wt-paused');
  const world = { sessions: [session('p', await transcript('p', add(`git worktree add --detach ${target} HEAD`, ['--detach', target, 'HEAD']))),
    session('p-sub', await transcript('p-sub', []), { isSubagent: true, parentId: 'claude:p' })], closed: new Set(['claude:p']) };
  const scanned = async () => Object.keys(((await readPrivateJson(join(state, 'worktree-cleanup.json')).catch(() => ({}))) as { scanned?: object }).scanned ?? {});
  const real = gitRunner(env);
  let pauseOn: string | undefined = 'rev-parse';
  const cleaner = janitor(state, world, { git: async (cwd, args, timeout) => { if (args[0] === pauseOn) { pauseOn = undefined; cleaner.pause(); } return real(cwd, args, timeout); } });
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.equal(existsSync(target), true, 'paused during the scan');
  assert.deepEqual(await scanned(), [], 'a scan cut short is not recorded');
  cleaner.resume(); pauseOn = 'status';
  await cleaner.pass();
  assert.equal(existsSync(target), true, 'paused before removing');
  assert.equal(cleaner.inFlight(), false);
  cleaner.resume();
  await cleaner.pass();
  assert.equal(existsSync(target), false, 'the scan was read again and the worktree removed once resumed');
});

test('a repository inside an ignored folder of the worktree keeps it; so does a conversation reopened while transcripts are read', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const outer = join(dir, 'work.wt-holds-repo'), later = join(dir, 'work.wt-later');
  const rows = [...add(`git worktree add --detach ${outer} HEAD`, ['--detach', outer, 'HEAD']), ...add(`git worktree add --detach ${later} HEAD`, ['--detach', later, 'HEAD'])];
  await writeFile(join(work, '.git', 'info', 'exclude'), 'vendor/\n');
  execFileSync('git', ['init', '-q', join(outer, 'vendor', 'other')], { env });
  await writeFile(join(outer, 'vendor', 'other', 'work.txt'), 'uncommitted work of another repository');
  // o is an open conversation whose new message is read during the check; meanwhile a is reopened.
  const world = { sessions: [session('a', await transcript('a', rows)), session('o', await transcript('o', [{ type: 'user', timestamp: iso(Date.now()), message: { content: 'unrelated' } }]), { updatedAt: iso(Date.now() + 5000) })],
    closed: new Set(['claude:a']) };
  // o keeps writing: every look sees a newer revision than the one whose transcript was just read.
  let looks = 0;
  const cleaner = janitor(state, world, { sessions: () => [world.sessions[0]!, { ...world.sessions[1]!, updatedAt: iso(Date.now() + 5000 + ++looks) }] });
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.equal((await worktreeCleanupFor(state, ['claude:a'])).find(item => item.path === outer)?.reason, 'nested');
  assert.equal(existsSync(join(outer, 'vendor', 'other', 'work.txt')), true);
  assert.equal(existsSync(later), true, 'an open conversation that changed meanwhile is read again first');
});

test('an empty repository inside an ignored folder (a test fixture) does not keep the worktree', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const target = join(dir, 'work.wt-fixtures');
  const rows = add(`git worktree add --detach ${target} HEAD`, ['--detach', target, 'HEAD']);
  await writeFile(join(work, '.git', 'info', 'exclude'), 'tmp/\n');
  const fixture = join(target, 'tmp', 'fixture', 'repo');
  // Like Tower's own fixtures: initialized, files written, nothing committed.
  execFileSync('git', ['init', '-q', fixture], { env });
  const world = { sessions: [session('f', await transcript('f', rows))], closed: new Set(['claude:f']) };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.equal(existsSync(target), false);
});

test('an unrelated session that keeps working does not hold off removal; a session that mentions the folder later does', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const target = join(dir, 'work.wt-busy-neighbour');
  const busyFile = await transcript('busy', [{ type: 'user', timestamp: iso(Date.now()), message: { content: 'other work' } }]);
  const world = { sessions: [session('a', await transcript('a', add(`git worktree add --detach ${target} HEAD`, ['--detach', target, 'HEAD']))), session('busy', busyFile, { cwd: '/elsewhere' })],
    closed: new Set(['claude:a']) };
  let looks = 0;
  const sessions = () => [world.sessions[0]!, { ...world.sessions[1]!, updatedAt: iso(Date.now() + ++looks) }];
  // First the neighbour writes about the folder only after an earlier look: it is caught up and keeps it.
  const cleaner = janitor(state, world, { sessions, cwds: async () => { await appendFile(busyFile, lines({ type: 'user', timestamp: iso(Date.now()), message: { content: `now use ${target}` } })); return []; } });
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.equal((await worktreeCleanupFor(state, ['claude:a']))[0]?.reason, 'openSession');
  // A neighbour that only writes unrelated lines, on every look, does not.
  const other = janitor(join(dir, 'state'), { ...world, sessions: [world.sessions[0]!, session('busy2', await transcript('busy2', [{ type: 'user', timestamp: iso(Date.now()), message: { content: 'x' } }]), { cwd: '/elsewhere' })] },
    { sessions: () => [world.sessions[0]!, { ...session('busy2', join(dir, 'transcripts', 'busy2.jsonl'), { cwd: '/elsewhere' }), updatedAt: iso(1e12 + looks) }], now: () => Date.now() + 2 * 3_600_000,
      // It writes while the programs are listed, right before the conversations are judged.
      cwds: async () => { looks++; await appendFile(join(dir, 'transcripts', 'busy2.jsonl'), lines({ type: 'user', timestamp: iso(Date.now()), message: { content: 'more' } })); return []; } });
  await other.start(); t.after(() => other.close());
  await other.pass();
  assert.equal(existsSync(target), false);
});

test('once closed and flushed, a pass that was stuck writes nothing', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const target = join(dir, 'work.wt-sealed');
  const world = { sessions: [session('s', await transcript('s', add(`git worktree add --detach ${target} HEAD`, ['--detach', target, 'HEAD'])))], closed: new Set(['claude:s']) };
  let release!: () => void;
  const stuck = new Promise<void>(resolve => { release = resolve; });
  const cleaner = janitor(state, world, { cwds: async () => { await stuck; return []; } });
  await cleaner.start();
  const pass = cleaner.pass();
  await new Promise(resolve => setTimeout(resolve, 300));
  cleaner.close();
  await cleaner.flush();
  release();
  await pass;
  assert.equal(existsSync(join(state, 'worktree-cleanup.json')), false);
  assert.equal(existsSync(target), true);
});

test('edits hidden from git status, and a bare repository inside, keep the worktree; a folder name JSON escapes is still found', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const hidden = join(dir, 'work.wt-hidden'), bare = join(dir, 'work.wt-bare'), quoted = join(dir, 'work.wt-"q"');
  const rows = [...add(`git worktree add --detach ${hidden} HEAD`, ['--detach', hidden, 'HEAD']), ...add(`git worktree add --detach ${bare} HEAD`, ['--detach', bare, 'HEAD']),
    ...add(`git worktree add --detach '${quoted}' HEAD`, ['--detach', quoted, 'HEAD'])];
  git(hidden, 'update-index', '--skip-worktree', 'a.txt'); await writeFile(join(hidden, 'a.txt'), 'edited but hidden');
  await writeFile(join(work, '.git', 'info', 'exclude'), 'backup.git/\n');
  execFileSync('git', ['init', '-q', '--bare', join(bare, 'backup.git')], { env });
  const world = { sessions: [session('h', await transcript('h', rows)), session('reader', await transcript('reader', [{ type: 'user', timestamp: iso(Date.now()), message: { content: `look at ${quoted}` } }]))],
    closed: new Set(['claude:h']) };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  const results = new Map((await worktreeCleanupFor(state, ['claude:h'])).map(item => [item.path, item.reason]));
  assert.deepEqual([results.get(hidden), results.get(bare), results.get(quoted)], ['changes', 'nested', 'openSession']);
  assert.deepEqual([hidden, bare, quoted].map(existsSync), [true, true, true]);
});

test('a repository inside with commits of its own, hidden edits, or worktrees of its own keeps the worktree', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const [committed, hidden, linked] = ['committed', 'hidden', 'linked'].map(name => join(dir, `work.wt-${name}`));
  const rows = [committed, hidden, linked].flatMap(path => add(`git worktree add --detach ${path} HEAD`, ['--detach', path, 'HEAD']));
  await writeFile(join(work, '.git', 'info', 'exclude'), 'inner/\n');
  for (const path of [committed, hidden, linked]) {
    execFileSync('git', ['init', '-q', join(path, 'inner')], { env });
    await writeFile(join(path, 'inner', 'f.txt'), 'x'); git(join(path, 'inner'), 'add', 'f.txt');
  }
  git(join(committed, 'inner'), 'commit', '-qm', 'only copy');
  // The others publish their commit to a remote of their own first.
  for (const path of [hidden, linked]) {
    const remote = join(dir, `${path.split('-').pop()}-remote.git`);
    execFileSync('git', ['init', '-q', '--bare', remote], { env });
    git(join(path, 'inner'), 'commit', '-qm', 'published'); git(join(path, 'inner'), 'remote', 'add', 'origin', remote); git(join(path, 'inner'), 'push', '-q', 'origin', 'HEAD:main'); git(join(path, 'inner'), 'fetch', '-q');
  }
  git(join(hidden, 'inner'), 'update-index', '--skip-worktree', 'f.txt'); await writeFile(join(hidden, 'inner', 'f.txt'), 'edited');
  git(join(linked, 'inner'), 'worktree', 'add', '-q', '--detach', join(dir, 'inner-elsewhere'), 'HEAD');
  const world = { sessions: [session('n', await transcript('n', rows))], closed: new Set(['claude:n']) };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.deepEqual((await worktreeCleanupFor(state, ['claude:n'])).map(item => item.reason), ['nested', 'nested', 'nested']);
  assert.deepEqual([committed, hidden, linked].map(existsSync), [true, true, true]);
});

test('incremental reads: a line still being written is read again once finished, and a replaced shorter file from the start', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-worktree-increment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 't.jsonl');
  const row = (content: string) => JSON.stringify({ type: 'user', message: { content } });
  await writeFile(file, `${row('first')}\n${row('about work.wt-late').slice(0, 20)}`);
  const first = await transcriptMentions(file, ['work.wt-late']);
  assert.equal(first.found.size, 0);
  await writeFile(file, `${row('first')}\n${row('about work.wt-late')}\n`);
  assert.deepEqual([...(await transcriptMentions(file, ['work.wt-late'], first.end)).found], ['work.wt-late'], 'the unfinished line was not skipped');
  await writeFile(file, `${row('now work.wt-late')}\n`);
  assert.deepEqual([...(await transcriptMentions(file, ['work.wt-late'], 10_000)).found], ['work.wt-late'], 'a shorter file is read from the start');
});

test('a branch with an upstream is also checked for repositories inside, and a clean worktree of another repository inside keeps it', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const branch = join(dir, 'work-branch');
  const rows = add(`git worktree add -b topic ${branch} origin/main`, ['-b', 'topic', branch, 'origin/main']);
  git(branch, 'push', '-q', '-u', 'origin', 'topic');
  await writeFile(join(work, '.git', 'info', 'exclude'), 'other/\n');
  const other = join(dir, 'other-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', other], { env });
  await writeFile(join(other, 'o.txt'), 'o'); git(other, 'add', 'o.txt'); git(other, 'commit', '-qm', 'o');
  git(other, 'worktree', 'add', '-q', '--detach', join(branch, 'other', 'wt'), 'HEAD');
  const world = { sessions: [session('b', await transcript('b', rows))], closed: new Set(['claude:b']) };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.deepEqual((await worktreeCleanupFor(state, ['claude:b'])).map(item => [item.reason, item.detail]), [['nested', join(branch, 'other', 'wt')]]);
});

test('a program started elsewhere that names the folder on its command line keeps it; moved-aside notes survive a removal', async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const preview = join(dir, 'preview'), notes = join(dir, 'work.wt-notes');
  const rows = [...add('git worktree add --detach ../preview HEAD', ['--detach', preview, 'HEAD']), ...add(`git worktree add --detach ${notes} HEAD`, ['--detach', notes, 'HEAD'])];
  await writeFile(join(work, '.git', 'info', 'exclude'), 'tmp/\nnode_modules/\n.env\n');
  await mkdir(join(notes, 'tmp', 'task'), { recursive: true }); await writeFile(join(notes, 'tmp', 'task', 'review.log'), 'review record');
  await mkdir(join(notes, 'tmp', 'task', 'node_modules', 'x'), { recursive: true }); await writeFile(join(notes, 'tmp', 'task', 'node_modules', 'x', 'i.js'), 'dep');
  await writeFile(join(notes, '.env'), 'LOCAL=1');
  await mkdir(join(notes, 'tmp', 'review', 'out'), { recursive: true }); await writeFile(join(notes, 'tmp', 'review', 'out', 'report.md'), 'report');
  // A pipe (or socket) a program left behind cannot be copied and holds nothing to keep.
  execFileSync('mkfifo', [join(notes, 'tmp', 'app.pipe')]);
  await mkdir(join(notes, 'node_modules', 'big'), { recursive: true }); await writeFile(join(notes, 'node_modules', 'big', 'i.js'), 'dep');
  const served = join(dir, 'served'), current = join(dir, 'current');
  const servedRows = add(`git worktree add --detach ${served} HEAD`, ['--detach', served, 'HEAD']);
  const { symlink } = await import('node:fs/promises');
  await symlink(served, current);
  const world = { sessions: [session('p', await transcript('p', [...rows, ...servedRows]))], closed: new Set(['claude:p']),
    commands: ['python3 -m http.server 8765 --directory ../preview'] };
  // The second server runs in dir and serves a symlink by its bare name.
  const cleaner = janitor(state, world, { commands: async () => [{ args: world.commands[0]! }, { args: 'python3 -m http.server 8766 --directory current', cwd: dir }] });
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.equal(existsSync(preview), true, 'the server keeps its folder');
  assert.equal(existsSync(served), true, 'so does one serving it through a symlink');
  assert.equal(existsSync(notes), false);
  const archive = (await worktreeCleanupFor(state, ['claude:p'])).find(item => item.path === notes)?.archive;
  assert.ok(archive && archive.startsWith(join(state, 'worktree-files')));
  assert.equal(await readFile(join(archive, 'tmp', 'task', 'review.log'), 'utf8'), 'review record');
  assert.equal(await readFile(join(archive, '.env'), 'utf8'), 'LOCAL=1');
  assert.equal(await readFile(join(archive, 'tmp', 'review', 'out', 'report.md'), 'utf8'), 'report', 'a common word deeper down is not a build folder');
  assert.deepEqual([existsSync(join(archive, 'node_modules')), existsSync(join(archive, 'tmp', 'task', 'node_modules'))], [false, false], 'dependencies are not kept');
});

test('a copy that fails partway leaves nothing behind in the state folder', { skip: process.getuid?.() === 0 ? 'root reads unreadable files' : false }, async t => {
  const { dir, work, state, add, transcript, session } = await setup(t);
  const target = join(dir, 'work.wt-unreadable');
  const rows = add(`git worktree add --detach ${target} HEAD`, ['--detach', target, 'HEAD']);
  await writeFile(join(work, '.git', 'info', 'exclude'), 'tmp/\n');
  await mkdir(join(target, 'tmp'), { recursive: true });
  await writeFile(join(target, 'tmp', 'a.txt'), 'a'); await writeFile(join(target, 'tmp', 'z.txt'), 'z');
  const { chmod } = await import('node:fs/promises');
  await chmod(join(target, 'tmp', 'z.txt'), 0o000); t.after(() => chmod(join(target, 'tmp', 'z.txt'), 0o644).catch(() => {}));
  const world = { sessions: [session('u', await transcript('u', rows))], closed: new Set(['claude:u']) };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.equal((await worktreeCleanupFor(state, ['claude:u']))[0]?.reason, 'failed');
  assert.equal(existsSync(target), true);
  assert.deepEqual(existsSync(join(state, 'worktree-files')) ? readdirSync(join(state, 'worktree-files')) : [], []);
});

test('a worktree only helper runs worked in goes once they and its maker were quiet, while its maker is still open', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const review = join(dir, 'work.wt-review'), manual = join(dir, 'work.wt-manual'), shared = join(dir, 'work.wt-shared');
  const rows = [...add(`git worktree add --detach ${review} HEAD`, ['--detach', review, 'HEAD']), ...add(`git worktree add --detach ${shared} HEAD`, ['--detach', shared, 'HEAD'])];
  // Made by hand in a terminal: no transcript proves who made it.
  git(join(dir, 'work'), 'worktree', 'add', '-q', '--detach', manual, 'HEAD');
  // Review records git ignores, as in `tmp/`.
  await appendFile(join(dir, 'work', '.git', 'info', 'exclude'), 'tmp/\n');
  await mkdir(join(review, 'tmp')); await writeFile(join(review, 'tmp', 'review.log'), 'P1 none');
  const start = Date.now();
  const helper = (id: string, cwd: string, extra: Partial<Session> = {}) => session(id, undefined, { provider: 'codex', id: `codex:${id}`, cwd, launchedByAgent: true, updatedAt: iso(start), ...extra });
  const maker = session('maker', await transcript('maker', [...rows, { type: 'user', timestamp: iso(start), message: { content: `Reviews run in ${review} and ${manual}` } }]), { updatedAt: iso(start) });
  const world = { sessions: [maker, helper('r1', review), helper('m1', manual), helper('s1', shared),
    // The owner opened a conversation in the shared one.
    session('owner-here', undefined, { cwd: shared, updatedAt: iso(start) })], closed: new Set<string>(), now: start + 5 * 60_000 };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.ok(existsSync(review), 'helpers finished only minutes ago');
  world.now = start + 31 * 60_000;
  await cleaner.pass();
  assert.equal(existsSync(review), false, 'the helpers’ folder goes while its maker is still open');
  assert.ok(existsSync(manual), 'one made by hand never goes this way');
  assert.ok(existsSync(shared), 'a conversation the owner sees works there');
  const archived = readdirSync(join(state, 'worktree-files'));
  assert.equal(archived.length, 1);
  assert.match(archived[0]!, /-kept$/, 'its ignored files are kept and never pruned');
});

test('a helpers’ folder stays while a helper works in it or its maker used it recently', async t => {
  const { dir, state, add, transcript, session } = await setup(t);
  const review = join(dir, 'work.wt-review');
  const rows = add(`git worktree add --detach ${review} HEAD`, ['--detach', review, 'HEAD']);
  const start = Date.now();
  const maker = session('maker', await transcript('maker', rows), { updatedAt: iso(start) });
  const helper = session('r1', undefined, { provider: 'codex', id: 'codex:r1', cwd: review, launchedByAgent: true, updatedAt: iso(start), status: 'working' });
  const world = { sessions: [maker, helper], closed: new Set<string>(), now: start + 60 * 60_000 };
  const cleaner = janitor(state, world);
  await cleaner.start(); t.after(() => cleaner.close());
  await cleaner.pass();
  assert.ok(existsSync(review), 'a helper still works there');
  helper.status = 'completed';
  // The maker named the folder again a minute ago.
  maker.updatedAt = iso(start + 59 * 60_000);
  await appendFile(maker.filePath!, lines({ type: 'user', timestamp: iso(start + 59 * 60_000), message: { content: `Look again at ${review}` } }));
  await cleaner.pass();
  assert.ok(existsSync(review), 'its maker used it moments ago');
  const [result] = await worktreeCleanupFor(state, ['claude:maker']);
  assert.deepEqual([result?.reason, result?.detail], ['openSession', 'maker']);
  world.now = start + 2 * 60 * 60_000 + 60_000;
  await cleaner.pass();
  assert.equal(existsSync(review), false, 'checked again later, once all was quiet');
});
