import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import fsPromises, { rename, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableRunManager } from '../../../../server/runs/durable-runner.js';
import { RunManager } from '../../../../server/runs/manager.js';
import { startRunnerHost } from '../../../../server/runs/worker.js';
import { SessionService } from '../../../../server/sessions/service.js';
import { SessionTasks } from '../../../../server/sessions/tasks.js';
import { SkillService } from '../../../../server/skills/service.js';
import { TriggerService } from '../../../../server/triggers/service.js';
import type { Session } from '../../../../shared/types.js';

const stateDir = process.argv.at(-1)!;
const provider = process.env.FIXTURE_PROVIDER as 'claude' | 'codex';
if (!['claude', 'codex'].includes(provider) || !process.env.FIXTURE_ROOT) throw new Error('Fixture environment is required.');
const root = process.env.FIXTURE_ROOT;
const publish = async (name: string, value: string) => {
  const path = join(root, name);
  const pendingPath = `${path}.${process.pid}.pending`;
  await writeFile(pendingPath, value);
  await rename(pendingPath, path);
};
const nativeId = '10000000-0000-4000-8000-000000000001';
const session: Session = { id: `${provider}:${nativeId}`, nativeId, provider, title: 'Detached fixture', cwd: root,
  project: 'fixture', status: 'idle', statusReason: 'Ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };

/** The fixture session and a run manager whose provider is the fake one beside this file. */
async function fixtureRuns() {
  const sessions = new SessionService({ codexHome: join(root, 'codex'), claudeHome: join(root, 'claude'),
    inspectProcesses: async () => ({ claude: new Map(), codex: new Set(), providerRunning: { claude: false, codex: false } }),
  });
  sessions.list = () => [{ ...session }];
  sessions.get = id => id === session.id ? { ...session } : undefined;
  const runs = new RunManager({ stateDir, getSession: id => sessions.get(id), refreshSessions: async () => {}, pollMs: 10,
    findExecutable: async () => '/fixture/provider',
    env: { ...process.env, FIXTURE_NATIVE_ID: nativeId, FIXTURE_TRANSCRIPT: join(root, 'transcript.jsonl') },
    spawnProcess: (_file, args, options) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./durable-provider.mjs', import.meta.url)), ...args], options);
      appendFileSync(join(root, 'provider-pids.jsonl'), JSON.stringify({ pid: child.pid }) + '\n');
      return child;
    },
  });
  await runs.start();
  return { sessions, runs };
}

/**
 * A worker with real trigger, session-task and skill stores whose state cannot be moved aside (tests/server/runs/
 * locked-state-handoff.test.ts). Only for that test: it sets FIXTURE_LOCKED_STATE to this fixture's own root.
 */
async function lockedStateWorker() {
  // Read before it is removed, as the real worker does: only the first worker (no handoff proof) gets the fault.
  const handoffNonce = process.env.TOWER_HANDOFF && /^[a-f\d]{32}$/.test(process.env.TOWER_HANDOFF) ? process.env.TOWER_HANDOFF : undefined;
  delete process.env.TOWER_HANDOFF;
  if (!handoffNonce) {
    const blocked = new Set(['trigger-engine.json', 'session-tasks.json', 'skills.json'].map(name => join(stateDir, name)));
    const original = fsPromises.rename;
    fsPromises.rename = (async (from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
      if (blocked.has(String(from)) && String(to).startsWith(`${String(from)}.unreadable-`)) {
        appendFileSync(join(root, 'rename-faults.jsonl'), JSON.stringify({ pid: process.pid, from: String(from) }) + '\n');
        throw Object.assign(new Error(`EACCES: permission denied, rename '${String(from)}'`), { code: 'EACCES', syscall: 'rename' });
      }
      return original(from, to);
    }) as typeof original;
    syncBuiltinESMExports();
  }
  const { sessions, runs } = await fixtureRuns();
  const triggers = new TriggerService({ stateDir, executor: {
    submitAutoPrompt: async () => { throw new Error('Fixture triggers never run.'); }, getAutoPrompt: () => undefined,
    create: async () => { throw new Error('Fixture triggers never run.'); }, enqueue: async () => { throw new Error('Fixture triggers never run.'); },
    runs: () => runs.list(), session: id => sessions.get(id) } });
  await triggers.start();
  const tasks = new SessionTasks({ stateDir, sessions: () => [], history: async () => ({ messages: [], hasMore: false }), model: async () => ({}) });
  await tasks.start();
  const home = join(root, 'home');
  const skills = new SkillService({ stateDir, homes: { home, agentsHome: join(home, '.agents'), claudeHome: join(root, 'claude'), codexHome: join(root, 'codex'),
    trash: join(stateDir, 'skills-trash'), store: join(stateDir, 'skills'), journal: join(stateDir, 'skills-moves.json') },
    sessions: () => [], runs: () => runs.list(), history: async () => [], model: async () => ({}), advise: false });
  await skills.start();
  const busy = () => triggers.inFlight() || skills.inFlight() || tasks.inFlight();
  const host = await startRunnerHost({ stateDir, sessions, runs, triggers, skills, sessionTasks: tasks, handoffNonce, inFlight: busy, transient: busy,
    quiesce: async () => {
      triggers.pause(); skills.pause(); tasks.pause();
      await Promise.all([tasks.flush(), triggers.flush(), skills.flush(), runs.flushState()]);
      appendFileSync(join(root, 'quiesced.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
    },
    resume: () => { triggers.resume(); skills.resume(); tasks.resume(); },
    // As spawnSuccessor does, with this fixture's loader instead of the test runner's own arguments.
    startSuccessor: (command, nonce) => {
      const child = spawn(process.execPath, ['--import', 'tsx', ...command.args.slice(-3)], { detached: true, stdio: 'ignore', env: { ...process.env, TOWER_HANDOFF: nonce } });
      child.unref();
    },
    // Nothing is running: the successor owns the state from here, so this engine stops before the process ends.
    onHandedOff: () => { triggers.close(); skills.close(); void tasks.close(); sessions.stop(); appendFileSync(join(root, 'handed-off.jsonl'), JSON.stringify({ pid: process.pid }) + '\n'); setTimeout(() => process.exit(0), 200); } });
  process.once('SIGTERM', () => { triggers.close(); void host.close().then(() => runs.close()).then(() => process.exit(0)); });
  appendFileSync(join(root, 'workers.jsonl'), JSON.stringify({ pid: process.pid, instance: host.instance, successor: Boolean(handoffNonce) }) + '\n');
}

if (process.argv.includes('--runner-worker') && process.env.FIXTURE_LOCKED_STATE === root) {
  await lockedStateWorker();
} else if (process.argv.includes('--runner-worker')) {
  const { sessions, runs } = await fixtureRuns();
  const host = await startRunnerHost({ stateDir, sessions, runs });
  process.once('SIGTERM', () => { void host.close().then(() => runs.close()).then(() => process.exit(0)); });
  await publish('worker-pid', String(process.pid));
} else {
  // This process is the disposable Tower UI; only its actual SIGTERM is tested.
  const client = new DurableRunManager({ stateDir, workerEntry: fileURLToPath(import.meta.url), pollMs: 10, startupTimeoutMs: 10_000 });
  await client.start();
  const run = await client.enqueue(session.id, 'approval-after-ui-restart');
  const timer = setInterval(() => {}, 1000);
  const deadline = Date.now() + 10_000;
  while (!client.list().find(value => value.id === run.id)?.approvals?.length) {
    if (Date.now() > deadline) throw new Error('Fixture approval did not arrive.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.once('SIGTERM', () => { void client.close().then(() => { clearInterval(timer); process.exit(0); }); });
  await publish('ui-ready.json', JSON.stringify({ runId: run.id, sessionId: session.id }));
}
