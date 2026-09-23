import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { RUNNER_PROTOCOL, runnerPaths, type RunnerReply, type RunnerSnapshot } from '../../../../server/runs/runner-protocol.js';

/**
 * Speaks the runner protocol exactly as 1.12.x workers do: snapshots carry no capabilities, and
 * any operation the build does not know fails with 400 "Unknown runner operation.".
 */
export async function startLegacyRunner(stateDir: string, content: Pick<RunnerSnapshot, 'runs' | 'sessions' | 'nativeIds' | 'settled' | 'autoPrompts'>) {
  const paths = await runnerPaths(stateDir);
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const instance = randomUUID();
  const methods: string[] = [];
  const snapshot: RunnerSnapshot = { instance, revision: 1, version: '1.12.3', ...content };
  const known = new Set(['snapshot', 'create', 'enqueue', 'steer', 'cancel', 'respondToApproval', 'attachment', 'terminalCreate', 'terminalInput',
    'terminalResize', 'terminalClose', 'submitAutoPrompt', 'cancelAutoPrompt', 'slackOverview', 'slackMutate', 'slackTool']);
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; instance?: string; revision?: number };
    methods.push(input.method);
    const reply: RunnerReply = { protocol: RUNNER_PROTOCOL, stateDir: paths.stateDir, instance };
    if (!known.has(input.method)) { reply.error = { message: 'Unknown runner operation.', statusCode: 400 }; reply.snapshot = snapshot; }
    else if (input.method !== 'snapshot' || input.revision !== snapshot.revision || input.instance !== instance) reply.snapshot = snapshot;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await unlink(paths.socket).catch(() => {});
  await unlink(paths.token).catch(() => {});
  await writeFile(paths.token, token, { flag: 'wx', mode: 0o600 });
  await new Promise<void>(resolve => server.listen(paths.socket, resolve));
  return {
    methods,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await unlink(paths.socket).catch(() => {});
      await unlink(paths.token).catch(() => {});
    },
    directory: paths.directory,
  };
}
