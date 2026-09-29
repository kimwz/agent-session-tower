import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLaunchShims, launchMarksDir, matchLaunchMarks, readLaunchMarks, type LaunchMark } from '../../../server/sessions/launch-marks.js';
import { SessionService } from '../../../server/sessions/service.js';
import type { ProcessSnapshot } from '../../../server/sessions/processes.js';

const LAUNCHER = '10000000-0000-4000-8000-000000000001';
const CHILD = '20000000-0000-4000-8000-000000000002';

async function shims(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-shims-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'), real = join(root, 'real');
  await mkdir(real, { recursive: true });
  for (const name of ['claude', 'codex']) {
    await writeFile(join(real, name), `#!/bin/sh\necho "$$ $*"\necho "PATH=$PATH" >&2\nexit 3\n`);
    await chmod(join(real, name), 0o755);
  }
  const dir = await installLaunchShims(state);
  const run = (name: string, args: string[], env: Record<string, string>, path = `${dir}:${real}:/usr/bin:/bin`) =>
    spawnSync(join(dir, name), args, { env: { PATH: path, TOWER_LAUNCH_MARKS: launchMarksDir(state), ...env }, encoding: 'utf8' });
  const marks = async () => Promise.all((await readdir(launchMarksDir(state))).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(join(launchMarksDir(state), name), 'utf8')) as Record<string, string | number>));
  return { root, state, dir, real, run, marks };
}

test('a helper started from a turn notes who started it and runs the real program unchanged', async t => {
  const f = await shims(t);
  const result = f.run('claude', ['-p', 'review this', '--model', 'fable'], { CLAUDE_CODE_SESSION_ID: LAUNCHER });
  assert.equal(result.status, 3, 'the real exit status');
  const [pid, ...args] = result.stdout.trim().split(' ');
  assert.equal(args[0], '--session-id', 'a new non-interactive run gets its id from the shim');
  const id = args[1]!;
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(args.slice(2), ['-p', 'review', 'this', '--model', 'fable']);
  assert.match(result.stderr, new RegExp(`PATH=${f.dir}:`), 'the shim stays first, so the helper’s own helpers are marked too');
  const [mark] = await f.marks();
  assert.equal(mark!.pid, Number(pid), 'the real program runs as the marked process');
  assert.equal(mark!.launcher, `claude:${LAUNCHER}`);
  assert.equal(mark!.child, `claude:${id}`);
  assert.equal(mark!.provider, 'claude');
  assert.ok(mark!.started);
});

test('resumed, interactive and Codex runs keep their arguments; without a launcher nothing is written', async t => {
  const f = await shims(t);
  assert.match(f.run('claude', ['-p', '--resume', 'abc', 'go on'], { CLAUDE_CODE_SESSION_ID: LAUNCHER }).stdout, /^\d+ -p --resume abc go on$/m);
  assert.match(f.run('claude', ['--session-id', CHILD, '-p', 'x'], { CLAUDE_CODE_SESSION_ID: LAUNCHER }).stdout, new RegExp(`^\\d+ --session-id ${CHILD} -p x$`, 'm'));
  assert.match(f.run('claude', ['hello'], { CLAUDE_CODE_SESSION_ID: LAUNCHER }).stdout, /^\d+ hello$/m);
  assert.match(f.run('codex', ['exec', 'review'], { CODEX_THREAD_ID: LAUNCHER }).stdout, /^\d+ exec review$/m);
  const marks = await f.marks();
  assert.equal(marks.length, 4);
  assert.ok(marks.every(mark => mark.child === ''), 'only a new run the shim named has a child');
  assert.ok(marks.some(mark => mark.launcher === `codex:${LAUNCHER}` && mark.provider === 'codex'));
  await rm(launchMarksDir(f.state), { recursive: true }); await mkdir(launchMarksDir(f.state));
  f.run('claude', ['-p', 'x'], {});
  assert.equal((await f.marks()).length, 0);
  const missing = f.run('claude', ['-p', 'x'], { CLAUDE_CODE_SESSION_ID: LAUNCHER }, `${f.dir}:/usr/bin:/bin`);
  assert.equal(missing.status, 127, 'no real program: like a missing command');
});

test('a mark naming its child links it once the child is listed; any other mark needs the same live process', () => {
  const mark = (patch: Partial<LaunchMark>): LaunchMark => ({ pid: 500, provider: 'claude', launcher: `claude:${LAUNCHER}`, at: Date.now(), file: '/x', ...patch });
  const named = mark({ child: `claude:${CHILD}` });
  assert.equal(matchLaunchMarks([named], new Map(), new Map(), new Set()).used.length, 0, 'kept until the child appears');
  assert.deepEqual([...matchLaunchMarks([named], new Map(), new Map(), new Set([`claude:${CHILD}`])).proofs], [[`claude:${CHILD}`, `claude:${LAUNCHER}`]]);
  const owners = new Map([[500, [`claude:${CHILD}`]]]);
  assert.equal(matchLaunchMarks([mark({ startedAt: 10_000 })], owners, new Map([[500, 10_400]]), new Set()).proofs.get(`claude:${CHILD}`), `claude:${LAUNCHER}`);
  assert.equal(matchLaunchMarks([mark({ startedAt: 10_000 })], owners, new Map([[500, 90_000]]), new Set()).proofs.size, 0, 'a pid used again by another program');
  assert.equal(matchLaunchMarks([mark({})], owners, new Map([[500, 10_000]]), new Set()).proofs.size, 0, 'no start time, no proof');
  assert.equal(matchLaunchMarks([mark({ launcher: `claude:${CHILD}`, startedAt: 1 })], owners, new Map([[500, 1]]), new Set()).proofs.size, 0, 'never its own launcher');
});

test('broken, expired and leftover marks are cleaned up', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-marks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  await writeFile(join(dir, '11.json'), JSON.stringify({ pid: 11, provider: 'claude', launcher: `claude:${LAUNCHER}`, child: '', started: '', at: Math.floor(now / 1000) }));
  await writeFile(join(dir, '12.json'), JSON.stringify({ pid: 12, provider: 'claude', launcher: `claude:${LAUNCHER}`, at: Math.floor(now / 1000) - 2 * 86_400 }));
  await writeFile(join(dir, '13.json'), '{nope');
  await writeFile(join(dir, '14.json'), JSON.stringify({ pid: 14, provider: 'claude', launcher: 'claude:bad id!', at: Math.floor(now / 1000) }));
  await writeFile(join(dir, '.15.tmp'), 'x');
  await utimes(join(dir, '.15.tmp'), new Date(now - 120_000), new Date(now - 120_000));
  const marks = await readLaunchMarks(dir, now);
  assert.deepEqual(marks.map(mark => mark.pid), [11]);
  assert.deepEqual((await readdir(dir)).sort(), ['11.json']);
});

test('a detached claude -p helper is joined to the session that started it, and stays hidden after it ended', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-detached-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeHome = join(root, 'claude'), codexHome = join(root, 'codex'), state = join(root, 'state');
  const projects = join(claudeHome, 'projects', 'work');
  await mkdir(projects, { recursive: true }); await mkdir(join(codexHome, 'sessions'), { recursive: true });
  await mkdir(launchMarksDir(state), { recursive: true });
  const at = new Date().toISOString();
  const row = (id: string, text: string) => JSON.stringify({ type: 'user', sessionId: id, cwd: '/work/monitor', entrypoint: 'sdk-cli', timestamp: at, message: { role: 'user', content: text } }) + '\n';
  await writeFile(join(projects, `${LAUNCHER}.jsonl`), row(LAUNCHER, 'Do the work'));
  // The helper was started with `( claude -p … ) &`: the process tree shows no launcher.
  await writeFile(join(projects, `${CHILD}.jsonl`), row(CHILD, 'Review PR #14'));
  await writeFile(join(launchMarksDir(state), '777.json'), JSON.stringify({ pid: 777, provider: 'claude', launcher: `claude:${LAUNCHER}`, child: `claude:${CHILD}`, started: '', at: Math.floor(Date.now() / 1000) }));
  const service = new SessionService({ claudeHome, codexHome, launchProofs: join(state, 'agent-launches.json'), launchMarks: launchMarksDir(state),
    inspectProcesses: async (): Promise<ProcessSnapshot> => ({ claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false }, launchers: new Map() }) });
  t.after(async () => { await service.quiesce(); service.stop(); });
  await service.refresh(true);
  assert.equal(service.get(`claude:${CHILD}`)?.parentId, `claude:${LAUNCHER}`);
  assert.equal(service.get(`claude:${CHILD}`)?.parentLink, 'exec');
  assert.deepEqual(await readdir(launchMarksDir(state)), [], 'the mark is used up');
  await service.quiesce(); service.resume();
  assert.deepEqual(JSON.parse(await readFile(join(state, 'agent-launches.json'), 'utf8')).launches[`claude:${CHILD}`], [`claude:${LAUNCHER}`], 'kept for the next worker');
  execFileSync('true');
});
