import { join } from 'node:path';
import { runnerPaths } from '../runs/runner-protocol.js';

/**
 * The master host keeps its data in `<state>/master` and, like the terminal host, talks to the web over an
 * owner-only socket beside the worker's, with its own credential and its own lock.
 */
export async function masterPaths(stateDir: string) {
  const runner = await runnerPaths(stateDir);
  const data = join(runner.stateDir, 'master');
  return {
    stateDir: runner.stateDir,
    data,
    runtime: join(data, 'runtime'),
    socket: join(runner.directory, 'master.sock'),
    token: join(runner.directory, 'master-token'),
  };
}
export type MasterPaths = Awaited<ReturnType<typeof masterPaths>>;

/** Where the host keeps the issue masters' data, each in `<state>/master/todo/<taskId>`. */
export function issueDataDir(masterData: string, taskId?: string): string {
  return taskId === undefined ? join(masterData, 'todo') : join(masterData, 'todo', taskId);
}
/** How an issue master's tool server names it to the host (`--instance todo:<taskId>`). */
export const ISSUE_INSTANCE = /^todo:([A-Za-z0-9_-]{1,64})$/;
