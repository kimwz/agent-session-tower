import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AutoPromptModelRequest } from '../../../server/auto-prompt/native.js';
import type { ReviewSources } from '../../../server/permissions/context.js';
import { ReviewFiles, type ReviewScopeSpec } from '../../../server/permissions/inspect.js';
import { PermissionReviewer } from '../../../server/permissions/reviewer.js';
import { PermissionRunner } from '../../../server/permissions/runner.js';
import { PermissionService } from '../../../server/permissions/service.js';
import { ruleGuards } from '../../../shared/permissions.js';

const agent = (sessionId: string, runId = 'run-1') => ({ kind: 'agent', via: 'mcp', sessionId, runId });
const ON = { enabled: true, provider: 'codex' as const, model: 'gpt-6.1-sol', resume: true };
const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};

/**
 * A Tower with a reviewer whose model is a script: it gets the request's read tools (the same `ReviewFiles` the tool
 * server runs) and answers what the test says. The run starts only through the runner, as in the worker.
 */
async function fixture(t: TestContext, now?: () => Date) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-review-files-flow-')));
  const stateDir = join(root, 'state');
  const project = join(root, 'work', 'shop');
  await mkdir(join(project, 'scripts'), { recursive: true });
  execFileSync('git', ['-C', project, 'init', '-q']);
  const sessions = new Map<string, { cwd: string; provider: 'claude' | 'codex' }>([['codex:sqlite', { cwd: project, provider: 'codex' }]]);
  let service!: PermissionService;
  const runner = new PermissionRunner({ stateDir, update: (id, run) => service.updateRun(id, run), killGraceMs: 200, beforeStart: id => service.confirmReviewed(id) });
  let reviewer: PermissionReviewer | undefined;
  service = new PermissionService({ stateDir, env: { CODEX_HOME: join(root, 'codex-home') }, session: id => sessions.get(id), ...(now ? { now } : {}),
    startRun: request => runner.start(request.id, request.rule.value, request.cwd, request.timeoutSeconds ?? 600, request.sessionId),
    runOutput: id => runner.output(id), onReviewQueued: () => reviewer?.wake() });
  await service.start();
  await service.saveAutoReview(ON);
  const sources: ReviewSources = {
    runs: () => [],
    trigger: () => undefined,
    authority: async () => ({ skills: [] }),
    conversation: async () => ({ messages: [{ id: 'u1', role: 'user', text: 'Implement #84 (SQLite store) and verify it with the fixture runtime checks on Node 22, 24 and 26.', timestamp: '1' }], complete: true }),
    answers: () => [],
    rules: cwd => service.overview(cwd).rules,
    guards: rule => ruleGuards(rule),
    requests: sessionId => service.overview().requests.filter(item => item.sessionId === sessionId),
  };
  const calls: AutoPromptModelRequest[] = [];
  let answer: (tools: ReviewFiles, request: AutoPromptModelRequest) => Promise<unknown> = async () => ({ verdict: 'owner', reason: '-', rule: null, scope: null, suggestion: null, missing: [] });
  reviewer = new PermissionReviewer({ service, sources, reachable: () => true, notify: async () => {},
    files: { stateDir, server: scope => ({ command: process.execPath, args: ['--review-files-mcp', scope] }) },
    model: async request => {
      calls.push(request);
      const scope = request.readTools!.args.at(-1)!;
      return answer(new ReviewFiles(JSON.parse(await readFile(scope, 'utf8')) as ReviewScopeSpec), request);
    } });
  // Runs held before they start, as runs queued behind another run of the conversation are; released at the latest here.
  const releases: (() => void)[] = [];
  const holdStarts = (then?: () => Promise<boolean>) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    const original = service.confirmReviewed.bind(service);
    service.confirmReviewed = async id => { await held; return then ? then() : original(id); };
    return release;
  };
  t.after(async () => { for (const release of releases) release(); await reviewer!.flush(); await runner.flush(); service.close(); await rm(root, { recursive: true, force: true }); });
  const settle = async () => { while (reviewer!.inFlight()) await reviewer!.flush(); await runner.flush(); };
  return { root, stateDir, project, sessions, service, runner, reviewer, calls, settle, holdStarts, answer: (value: typeof answer) => { answer = value; },
    request: (id: string) => service.overview().requests.find(item => item.id === id)! };
}

const WRAPPER = `import { spawnSync } from 'node:child_process';\nimport { join } from 'node:path';\nspawnSync(process.execPath, [join(import.meta.dirname, 'fixture.mjs')], { stdio: 'inherit' });\n`;

test('a wrapper whose child the request does not show is approved after the reviewer reads the child itself, and runs', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), WRAPPER);
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'console.log("fixture ok")\n');
  f.answer(async (tools, request) => {
    const input = JSON.parse(request.prompt);
    // Tower gives only the script the command names; the child is the reviewer's to read.
    assert.deepEqual(input.context.commandEvidence.files.map((file: { path: string }) => file.path), [join(f.project, 'scripts', 'run-all.mjs')]);
    assert.match(request.systemPrompt, /read_file/);
    const child = await tools.read({ path: join(f.project, 'scripts', 'fixture.mjs') }) as { text: string };
    assert.equal(child.text, 'console.log("fixture ok")\n');
    return { verdict: 'approve', reason: 'fixture.mjs는 출력만 하는 검증 스크립트입니다.', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'runtime check' }, agent('codex:sqlite'));
  f.reviewer.wake();
  await f.settle();
  await until(() => f.request(request.id!).run?.status === 'done');
  const done = f.request(request.id!);
  assert.equal(done.decidedBy, 'auto');
  assert.equal(done.review!.files, undefined, 'the files are kept only until the run starts');
  assert.equal((await f.runner.output(request.id!))!.stdout, 'fixture ok\n');
  assert.equal(f.calls[0]!.readTools!.server, 'tower_review');
  assert.deepEqual((await readdir(join(f.stateDir, 'tmp'))).filter(name => name.startsWith('permission-review-')), [], 'the review scratch folder is removed');
});

test('a child edited after the approval does not run under it: the request is reviewed again with the new contents', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), WRAPPER);
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'console.log("fixture ok")\n');
  const seen: string[] = [];
  f.answer(async tools => {
    const child = await tools.read({ path: join(f.project, 'scripts', 'fixture.mjs') }) as { text: string };
    seen.push(child.text);
    if (seen.length === 1) return { verdict: 'approve', reason: '출력만 합니다.', rule: null, scope: null, suggestion: null, missing: [] };
    return { verdict: 'owner', reason: '하위 스크립트가 홈 폴더를 지웁니다.', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const hold = f.holdStarts();
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'runtime check' }, agent('codex:sqlite'));
  f.reviewer.wake();
  await until(() => f.request(request.id!).status === 'approved');
  const bound = f.request(request.id!).review!.files!;
  // The run's folder, bound by where it leads, and the two scripts by their contents.
  const kinds = bound.map(file => [file.path, file.sha256 === null ? 'place' : file.depth ? 'entries' : 'contents']);
  // The scripts by their contents, the run's folder by where it leads, and the scripts' folder by its entries.
  for (const expected of [[f.project, 'place'], [join(f.project, 'scripts'), 'entries'], [join(f.project, 'scripts', 'fixture.mjs'), 'contents'], [join(f.project, 'scripts', 'run-all.mjs'), 'contents']])
    assert.ok(kinds.some(kind => kind[0] === expected[0] && kind[1] === expected[1]), expected.join(' '));
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'import { rmSync } from "node:fs"; rmSync(process.env.HOME, { recursive: true });\n');
  hold();
  await until(() => seen.length === 2);
  await f.settle();
  const after = f.request(request.id!);
  assert.equal(after.status, 'pending');
  assert.equal(after.run, undefined, 'never started');
  assert.equal(after.review!.verdict, 'owner');
  assert.match(seen[1]!, /rmSync/);
});

test('an owner verdict names the concrete risk, what could not be confirmed and the reads Tower refused', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'elsewhere', 'deep', 'child.ts');
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), `spawn('tsx', [process.env.CHILD ?? 'child.ts']);\n`);
  f.answer(async tools => {
    await tools.read({ path: outside });
    await tools.read({ path: join(f.project, '.env') });
    return { verdict: 'owner', reason: '실제 저장 작업을 하는 하위 스크립트를 확인하지 못했습니다.', rule: null, scope: null, suggestion: null,
      missing: [`${outside}: 검토 범위 밖이라 읽지 못함`] };
  });
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'baseline' }, agent('codex:sqlite'));
  f.reviewer.wake();
  await f.settle();
  const after = f.request(request.id!);
  assert.equal(after.status, 'pending');
  assert.equal(after.review!.verdict, 'owner');
  assert.match(after.review!.reason!, /^실제 저장 작업을 하는 하위 스크립트를 확인하지 못했습니다\. \/ 확인하지 못한 근거: .*child\.ts: 검토 범위 밖이라 읽지 못함 \/ 읽지 못한 파일: .*child\.ts \((없음|검토 범위 밖)\), .*\.env \(비밀·Tower 상태라 읽지 않음\)$/);
  assert.equal(after.review!.files, undefined);
});

test('an owner-approved run is not held to the reviewer\'s files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), 'console.log("owner")\n');
  f.answer(async () => ({ verdict: 'owner', reason: '확인 필요', rule: null, scope: null, suggestion: null, missing: [] }));
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'r' }, agent('codex:sqlite'));
  f.reviewer.wake();
  await f.settle();
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), 'console.log("edited")\n');
  await f.service.decide(request.id!, true);
  await until(() => f.request(request.id!).run?.status === 'done');
  assert.equal((await f.runner.output(request.id!))!.stdout, 'edited\n');
});

test('a child that changes while the reviewer reads it is reviewed again, never approved as it was', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), WRAPPER);
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'console.log("v1")\n');
  const seen: string[] = [];
  f.answer(async tools => {
    seen.push((await tools.read({ path: join(f.project, 'scripts', 'fixture.mjs') }) as { text: string }).text);
    if (seen.length === 1) await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'console.log("v2")\n');
    return { verdict: 'approve', reason: '출력만 합니다.', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'runtime check' }, agent('codex:sqlite'));
  f.reviewer.wake();
  await f.settle();
  await until(() => f.request(request.id!).run?.status === 'done');
  assert.deepEqual(seen, ['console.log("v1")\n', 'console.log("v2")\n']);
  assert.equal((await f.runner.output(request.id!))!.stdout, 'v2\n');
});

test('a file the wrapper looked for and did not find, once it appears, sends the run back to review', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), `import { existsSync } from 'node:fs';\nconst child = existsSync('scripts/override.mjs') ? 'scripts/override.mjs' : 'scripts/fixture.mjs';\n`);
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'console.log("fixture")\n');
  let reviews = 0;
  const hold = f.holdStarts();
  f.answer(async tools => {
    reviews += 1;
    const got = await tools.read({ path: 'scripts/override.mjs' }) as { status?: string; text?: string };
    assert.deepEqual(reviews === 1 ? got.status : got.text, reviews === 1 ? 'missing' : 'process.kill(-1)\n');
    return { verdict: reviews === 1 ? 'approve' : 'owner', reason: '-', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'check' }, agent('codex:sqlite'));
  f.reviewer.wake();
  await until(() => f.request(request.id!).status === 'approved');
  assert.ok(f.request(request.id!).review!.files!.some(file => file.path.endsWith('override.mjs') && file.sha256 === null));
  await writeFile(join(f.project, 'scripts', 'override.mjs'), 'process.kill(-1)\n');
  hold();
  await until(() => reviews === 2);
  await f.settle();
  assert.equal(f.request(request.id!).run, undefined);
  assert.equal(f.request(request.id!).review!.verdict, 'owner');
});

test('reviewed files held by waiting runs stay within a budget of the state file; past it the owner decides', async t => {
  const f = await fixture(t);
  // Korean paths: counted in bytes (three each), as the state file is, two such sets exceed the budget; in characters they would not.
  // Held at the check before starting, as runs queued behind another run of the conversation are; released unstarted.
  f.holdStarts(async () => false);
  f.reviewer.hold();
  const big = Array.from({ length: 200 }, (_, index) => ({ path: `/${'경'.repeat(400)}/${index}.mjs`, real: `/${'경'.repeat(400)}/${index}.mjs`, sha256: 'a'.repeat(64) }));
  const decided: string[] = [];
  for (const command of ['echo one', 'echo two']) {
    const { request } = await f.service.requestRun({ command, reason: 'r', key: command }, agent('codex:sqlite'));
    assert.ok(await f.service.startReview(request.id!));
    const outcome = await f.service.applyReview(request.id!, { verdict: 'approve', reason: '확인함', files: big });
    decided.push(`${outcome!.request.status}/${outcome!.request.review!.verdict}`);
  }
  assert.deepEqual(decided, ['approved/approve', 'pending/owner']);
  assert.match(f.service.overview().requests.find(item => item.rule.value === 'echo two')!.review!.reason!, /검토한 파일을 더 보관할 수 없습니다/);
});

test('a run whose files change right before every start goes to the owner after three reviews, with the files named', async t => {
  const f = await fixture(t);
  const script = join(f.project, 'scripts', 'busy.mjs');
  await writeFile(script, 'console.log(0)\n');
  // Reviews are applied by hand here; the reviewer stays out of it (held before the request wakes it).
  f.reviewer.hold();
  const { request } = await f.service.requestRun({ command: 'node scripts/busy.mjs', reason: 'r' }, agent('codex:sqlite'));
  const results: boolean[] = [];
  // The runner is held before starting, as a queued run would be; the check is made here, after the file changed.
  const confirm = f.service.confirmReviewed.bind(f.service);
  f.holdStarts(async () => false);
  for (let round = 1; round <= 4; round++) {
    assert.ok(await f.service.startReview(request.id!));
    const bound = { path: script, real: script, sha256: createHash('sha256').update(await readFile(script)).digest('hex') };
    await f.service.applyReview(request.id!, { verdict: 'approve', reason: '확인함', files: [bound] });
    await writeFile(script, `console.log(${round})\n`);
    results.push(await confirm(request.id!));
  }
  assert.deepEqual(results, [false, false, false, false]);
  const after = f.request(request.id!);
  assert.equal(after.status, 'pending');
  assert.equal(after.review!.verdict, 'owner');
  assert.match(after.review!.reason!, /파일이 바뀌어\(.*busy\.mjs\) 다시 검토하기를 3번 했지만 .*소유자에게 넘깁니다/);
});

test('a folder of reviewed code that cannot be listed sends the approval to the owner; a file appearing beside Tower\'s read-ahead script during the review sends it back to review', async t => {
  const f = await fixture(t);
  const tools = join(f.root, 'tools');
  await mkdir(join(tools, 'sealed'), { recursive: true });
  await writeFile(join(tools, 'sealed', 'child.mjs'), 'console.log(1)\n');
  await writeFile(join(f.project, 'scripts', 'run.mjs'), `spawn('node', ['${join(tools, 'sealed', 'child.mjs')}']);\n`);
  await chmod(join(tools, 'sealed'), 0o311);
  f.answer(async files => {
    assert.equal((await files.read({ path: join(tools, 'sealed', 'child.mjs') }) as { text: string }).text, 'console.log(1)\n');
    return { verdict: 'approve', reason: '출력만 합니다.', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const sealed = await f.service.requestRun({ command: 'node scripts/run.mjs', reason: 'r', key: 'sealed' }, agent('codex:sqlite'));
  f.reviewer.wake(); await f.settle();
  assert.equal(f.request(sealed.request.id!).review!.verdict, 'owner');
  assert.match(f.request(sealed.request.id!).review!.reason!, /폴더의 목록을 확인할 수 없어.*sealed/);
  await chmod(join(tools, 'sealed'), 0o755);
  // Tower read wrapper.mjs ahead; while the model answers, a lib.js appears beside it.
  await writeFile(join(f.project, 'scripts', 'wrapper.mjs'), "import './lib/index.js';\n");
  await mkdir(join(f.project, 'scripts', 'lib'));
  await writeFile(join(f.project, 'scripts', 'lib', 'index.js'), 'export {}\n');
  let reviews = 0;
  f.answer(async files => {
    reviews += 1;
    await files.read({ path: join(f.project, 'scripts', 'lib', 'index.js') });
    if (reviews === 1) await writeFile(join(f.project, 'scripts', 'lib.js'), 'process.exit(1)\n');
    return { verdict: reviews === 1 ? 'approve' : 'owner', reason: '-', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const ahead = await f.service.requestRun({ command: 'node scripts/wrapper.mjs', reason: 'r', key: 'ahead' }, agent('codex:sqlite'));
  f.reviewer.wake(); await f.settle();
  assert.equal(reviews, 2, 'reviewed again with lib.js there');
  assert.equal(f.request(ahead.request.id!).run, undefined);
});

test('an approval that waited more than a minute before its run could start is reviewed again with what is there now', async t => {
  const fixtureClock = { now: new Date('2026-10-08T00:00:00.000Z') };
  const f = await fixture(t, () => fixtureClock.now);
  await writeFile(join(f.project, 'scripts', 'run.mjs'), 'console.log(1)\n');
  f.reviewer.hold();
  const { request } = await f.service.requestRun({ command: 'node scripts/run.mjs', reason: 'r' }, agent('codex:sqlite'));
  const confirm = f.service.confirmReviewed.bind(f.service);
  f.holdStarts(async () => false);
  assert.ok(await f.service.startReview(request.id!));
  await f.service.applyReview(request.id!, { verdict: 'approve', reason: '확인함', files: [] });
  assert.equal(await confirm(request.id!), true, 'started at once: nothing to review again');
  fixtureClock.now = new Date('2026-10-08T00:01:30.000Z');
  assert.equal(await confirm(request.id!), false);
  assert.equal(f.request(request.id!).status, 'pending');
  assert.equal(f.request(request.id!).review!.status, 'queued');
  assert.match(f.request(request.id!).review!.reason!, /승인 뒤 실행까지 90초를 기다려 지금 내용으로 다시 검토합니다/);
});

test('a read log that cannot be read fails the review instead of approving without its files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), WRAPPER);
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'console.log(1)\n');
  f.answer(async (tools, request) => {
    await tools.read({ path: join(f.project, 'scripts', 'fixture.mjs') });
    // The log is still there, but no longer a file Tower can read.
    const log = JSON.parse(await readFile(request.readTools!.args.at(-1)!, 'utf8')).log as string;
    await rm(log); await mkdir(log);
    return { verdict: 'approve', reason: '확인함', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'r' }, agent('codex:sqlite'));
  f.reviewer.wake(); await f.settle();
  const after = f.request(request.id!);
  assert.equal(after.status, 'pending');
  assert.equal(after.review!.status, 'failed');
  assert.equal(after.run, undefined);
});

test('an approved waiting run keeps what it was bound to across a restart', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'scripts', 'run-all.mjs'), WRAPPER);
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'console.log(1)\n');
  f.holdStarts(async () => false);
  f.answer(async tools => {
    await tools.read({ path: join(f.project, 'scripts', 'fixture.mjs') });
    return { verdict: 'approve', reason: '확인함', rule: null, scope: null, suggestion: null, missing: [] };
  });
  const { request } = await f.service.requestRun({ command: 'node scripts/run-all.mjs', reason: 'r' }, agent('codex:sqlite'));
  f.reviewer.wake();
  // Approved, and held before it starts (the runner waits at the check, so nothing is settled here).
  await until(() => f.request(request.id!).status === 'approved');
  const before = f.request(request.id!);
  const again = new PermissionService({ stateDir: f.stateDir, env: { CODEX_HOME: join(f.root, 'codex-home') }, session: () => ({ cwd: f.project, provider: 'codex' as const }) });
  await again.start();
  t.after(() => again.close());
  assert.deepEqual(again.overview().requests.find(item => item.id === request.id)!.review!.files, before.review!.files);
  await writeFile(join(f.project, 'scripts', 'fixture.mjs'), 'process.exit(1)\n');
  assert.equal(await again.confirmReviewed(request.id!), false);
  const after = again.overview().requests.find(item => item.id === request.id)!;
  assert.equal(after.status, 'pending');
  assert.equal(after.rechecks, 1);
});

test('a request whose folder is in Tower\'s state (a coordinator\'s) is reviewed normally, not sent back as if files kept changing', async t => {
  const f = await fixture(t);
  const coordinator = join(f.stateDir, 'slack-sessions', 'w1');
  await mkdir(coordinator, { recursive: true });
  f.sessions.set('claude:slack', { cwd: coordinator, provider: 'claude' });
  f.answer(async () => ({ verdict: 'approve', reason: '배포 단계입니다.', rule: null, scope: null, suggestion: null, missing: [] }));
  // A run, whose review binds what it read: the coordinator's own folder (in Tower's state) is not among it.
  const { request } = await f.service.requestRun({ command: 'gh pr view 1', reason: 'r' }, agent('claude:slack'));
  f.holdStarts(async () => false);
  f.reviewer.wake();
  await until(() => f.request(request.id!).status === 'approved');
  assert.equal(f.calls.length, 1, 'one review, no requeue');
});

test('waits are reviewed again as often as they happen without using up the file-change limit', async t => {
  const clock = { now: new Date('2026-10-08T00:00:00.000Z') };
  const f = await fixture(t, () => clock.now);
  await writeFile(join(f.project, 'scripts', 'run.mjs'), 'console.log(1)\n');
  f.reviewer.hold();
  const { request } = await f.service.requestRun({ command: 'node scripts/run.mjs', reason: 'r' }, agent('codex:sqlite'));
  const confirm = f.service.confirmReviewed.bind(f.service);
  f.holdStarts(async () => false);
  for (let round = 0; round < 5; round++) {
    assert.ok(await f.service.startReview(request.id!));
    await f.service.applyReview(request.id!, { verdict: 'approve', reason: '확인함', files: [] });
    clock.now = new Date(clock.now.getTime() + 90_000);
    assert.equal(await confirm(request.id!), false);
    assert.equal(f.request(request.id!).review!.status, 'queued', `round ${round}`);
  }
  assert.equal(f.request(request.id!).rechecks, undefined);
});

test('a request whose folder is gone is reviewed once, not sent back as if it kept changing', async t => {
  const f = await fixture(t);
  const gone = join(f.root, 'work', 'removed-worktree');
  f.sessions.set('codex:gone', { cwd: gone, provider: 'codex' });
  f.answer(async () => ({ verdict: 'owner', reason: '작업 폴더가 없습니다.', rule: null, scope: null, suggestion: null, missing: [] }));
  const { request } = await f.service.requestRun({ command: 'npm test', reason: 'r' }, agent('codex:gone'));
  f.reviewer.wake(); await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.request(request.id!).review!.verdict, 'owner');
});

test('a later run of the conversation waits for an earlier one sent back to review, so they keep their order', async t => {
  const clock = { now: new Date('2026-10-08T00:00:00.000Z') };
  const f = await fixture(t, () => clock.now);
  f.reviewer.hold();
  const confirm = f.service.confirmReviewed.bind(f.service);
  f.holdStarts(async () => false);
  const first = (await f.service.requestRun({ command: 'echo build', reason: 'r', key: 'build' }, agent('codex:sqlite'))).request;
  clock.now = new Date(clock.now.getTime() + 1_000);
  const second = (await f.service.requestRun({ command: 'echo test', reason: 'r', key: 'test' }, agent('codex:sqlite'))).request;
  for (const request of [first, second]) { assert.ok(await f.service.startReview(request.id!)); await f.service.applyReview(request.id!, { verdict: 'approve', reason: '확인함', files: [] }); }
  clock.now = new Date(clock.now.getTime() + 90_000);
  assert.equal(await confirm(first.id!), false, 'waited too long: reviewed again');
  assert.equal(await confirm(second.id!), false, 'not ahead of the first');
  assert.match(f.request(second.id!).review!.reason!, /앞선 실행이 다시 검토되고 있어 순서대로/);
});
