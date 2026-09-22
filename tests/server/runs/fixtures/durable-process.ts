import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableRunManager } from '../../../../server/runs/durable-runner.js';
import { RunManager } from '../../../../server/runs/manager.js';
import { startRunnerHost } from '../../../../server/runs/worker.js';
import { SessionService } from '../../../../server/sessions/service.js';
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

if (process.argv.includes('--runner-worker')) {
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
