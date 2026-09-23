import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService } from '../../../server/sessions/service.js';
import { codexSessionsByProcess, processLaunchers, type ProcessSnapshot } from '../../../server/sessions/processes.js';

const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const now = () => new Date().toISOString();
const CLAUDE = '10000000-0000-4000-8000-000000000001';
const REVIEW = '20000000-0000-4000-8000-000000000002';
const HELPER = '30000000-0000-4000-8000-000000000003';
const DESKTOP = '40000000-0000-4000-8000-000000000004';
const THREAD = '50000000-0000-4000-8000-000000000005';

function codex(id: string, source: string, extra: Record<string, unknown> = {}) {
  const at = now();
  return lines(
    { type: 'session_meta', timestamp: at, payload: { id, timestamp: at, cwd: '/work/monitor', source, thread_source: 'user', ...extra } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'IMPORTANT: review this diff' }] } },
  );
}
function claude(id: string, entrypoint: string, command = 'git status') {
  const at = now();
  return lines(
    { type: 'user', sessionId: id, cwd: '/work/monitor', entrypoint, timestamp: at, message: { role: 'user', content: 'Review with Codex' } },
    { type: 'assistant', sessionId: id, cwd: '/work/monitor', entrypoint, timestamp: at, message: { content: [{ type: 'tool_use', name: 'Bash', id: 'call', input: { command } }] } },
  );
}

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'tower-agent-launched-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codexHome = join(dir, 'codex'), claudeHome = join(dir, 'claude');
  const codexDir = join(codexHome, 'sessions'), claudeDir = join(claudeHome, 'projects', 'work');
  await Promise.all([mkdir(codexDir, { recursive: true }), mkdir(claudeDir, { recursive: true })]);
  let launchers = new Map<string, string[]>();
  let inspections = 0;
  const service = new SessionService({ codexHome, claudeHome, inspectProcesses: async (): Promise<ProcessSnapshot> => {
    inspections++;
    return { claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false }, launchers };
  } });
  return {
    service, codexDir, claudeDir,
    setLaunchers: (value: Record<string, string[]>) => { launchers = new Map(Object.entries(value)); },
    inspections: () => inspections,
  };
}

test('a Codex review started from a Claude turn joins that session even when no command text names it', async t => {
  const f = await fixture(t);
  // A wrapper function and a command substitution: nothing a literal parser can prove.
  await writeFile(join(f.claudeDir, `${CLAUDE}.jsonl`), claude(CLAUDE, 'sdk-cli', 'review_wrapper 600 codex exec "$(cat prompt.txt)" --json | python3 parse.py'));
  await writeFile(join(f.codexDir, `rollout-${REVIEW}.jsonl`), codex(REVIEW, 'exec'));
  await writeFile(join(f.codexDir, `rollout-${THREAD}.jsonl`), codex(THREAD, 'exec', { thread_source: 'subagent', parent_thread_id: REVIEW, source: { subagent: { thread_spawn: { parent_thread_id: REVIEW } } } }));
  f.setLaunchers({ [`codex:${REVIEW}`]: [`claude:${CLAUDE}`], [`codex:${THREAD}`]: [`claude:${CLAUDE}`] });
  await f.service.refresh();
  const review = f.service.get(`codex:${REVIEW}`);
  assert.equal(review?.parentId, `claude:${CLAUDE}`);
  assert.equal(review?.parentLink, 'exec');
  assert.equal(review?.isSubagent, true);
  assert.equal(review?.launchedByAgent, true);
  assert.equal(f.service.get(`codex:${THREAD}`)?.parentId, `codex:${REVIEW}`, "the review's own threads keep their native parent");
  assert.equal(f.service.get(`codex:${THREAD}`)?.launchedByAgent, undefined);
  // The review finished: its process is gone, the proof stays.
  f.setLaunchers({});
  await f.service.refresh(true);
  assert.equal(f.service.get(`codex:${REVIEW}`)?.parentId, `claude:${CLAUDE}`);
});

test('a new non-interactive run is looked at once as soon as it appears, not on the next process interval', async t => {
  const f = await fixture(t);
  await writeFile(join(f.claudeDir, `${CLAUDE}.jsonl`), claude(CLAUDE, 'cli'));
  await f.service.refresh();
  const initial = f.inspections();
  await new Promise(resolve => setTimeout(resolve, 1100));
  await writeFile(join(f.codexDir, `rollout-${REVIEW}.jsonl`), codex(REVIEW, 'exec'));
  f.setLaunchers({ [`codex:${REVIEW}`]: [`claude:${CLAUDE}`] });
  await f.service.refresh();
  assert.equal(f.inspections(), initial + 1, 'the process interval (8 s) had not elapsed');
  assert.equal(f.service.get(`codex:${REVIEW}`)?.parentId, `claude:${CLAUDE}`);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await f.service.refresh();
  assert.equal(f.inspections(), initial + 1, 'each run is looked at once');
});

test('without proof an agent-launched run stays unlinked but marked, and interactive sessions are never folded into another', async t => {
  const f = await fixture(t);
  const PROGRAMMATIC = '60000000-0000-4000-8000-000000000006';
  await Promise.all([
    writeFile(join(f.claudeDir, `${CLAUDE}.jsonl`), claude(CLAUDE, 'cli')),
    writeFile(join(f.claudeDir, `${HELPER}.jsonl`), claude(HELPER, 'cli')),
    writeFile(join(f.claudeDir, `${PROGRAMMATIC}.jsonl`), claude(PROGRAMMATIC, 'sdk-cli')),
    writeFile(join(f.codexDir, `rollout-${REVIEW}.jsonl`), codex(REVIEW, 'exec')),
    writeFile(join(f.codexDir, `rollout-${DESKTOP}.jsonl`), codex(DESKTOP, 'vscode')),
  ]);
  // A process tree that looks like a launch cannot move interactive windows under another session.
  f.setLaunchers({ [`codex:${DESKTOP}`]: [`claude:${CLAUDE}`], [`claude:${HELPER}`]: [`claude:${CLAUDE}`], [`claude:${PROGRAMMATIC}`]: [`claude:${CLAUDE}`] });
  await f.service.refresh();
  const review = f.service.get(`codex:${REVIEW}`);
  assert.equal(review?.parentId, undefined);
  assert.equal(review?.launchedByAgent, true, 'unlinked agent work is still not a user conversation');
  assert.equal(f.service.get(`codex:${DESKTOP}`)?.parentId, undefined);
  assert.equal(f.service.get(`codex:${DESKTOP}`)?.launchedByAgent, undefined);
  assert.equal(f.service.get(`claude:${HELPER}`)?.parentId, undefined, 'an interactive Claude window is never a child');
  assert.equal(f.service.get(`claude:${PROGRAMMATIC}`)?.parentId, `claude:${CLAUDE}`, 'claude -p started inside a turn joins it');
  const SCHEDULED = '90000000-0000-4000-8000-000000000009';
  await writeFile(join(f.claudeDir, `${SCHEDULED}.jsonl`), claude(SCHEDULED, 'sdk-cli'));
  await f.service.refresh(true);
  const scheduled = f.service.get(`claude:${SCHEDULED}`);
  assert.equal(scheduled?.parentId, undefined, 'claude -p started by a scheduler or script stays a visible session');
  assert.equal(scheduled?.launchedByAgent, undefined);
});

test('process ancestry names the nearest agent session and stops at the monitor worker', () => {
  const parents = new Map([[50, 40], [40, 30], [30, 20], [20, 1], [70, 60], [60, 20], [90, 80], [80, 99], [99, 1]]);
  const owners = new Map<number, string[]>([
    [20, ['claude:parent']],
    [50, [`codex:${REVIEW}`, `codex:${THREAD}`]],
    [70, ['claude:child']],
    [90, ['codex:tower-run']],
  ]);
  const launchers = processLaunchers(parents, owners, 99);
  assert.deepEqual(launchers.get(`codex:${REVIEW}`), ['claude:parent']);
  assert.deepEqual(launchers.get(`codex:${THREAD}`), ['claude:parent']);
  assert.deepEqual(launchers.get('claude:child'), ['claude:parent']);
  assert.equal(launchers.has('codex:tower-run'), false, 'runs this monitor started belong to the user');
  assert.equal(launchers.has('claude:parent'), false);
  const cyclic = processLaunchers(new Map([[5, 6], [6, 5]]), new Map([[5, ['codex:a']]]), 0);
  assert.equal(cyclic.size, 0);
});

test('open Codex files are grouped by the process that holds them', () => {
  const home = '/home/me/.codex';
  const output = [`p10`, `f5`, `n${home}/sessions/2026/09/23/rollout-${REVIEW}.jsonl`, `n${home}/sessions/2026/09/23/rollout-${THREAD}.jsonl`,
    `p11`, `n/tmp/other.jsonl`, `n${home}/thread-writer-locks/${DESKTOP}.lock`].join('\n');
  const processes = codexSessionsByProcess(output, home);
  assert.deepEqual([...processes.get(10)!], [REVIEW, THREAD]);
  assert.deepEqual([...processes.get(11)!], [DESKTOP]);
});
