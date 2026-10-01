import type { SessionTask } from './types.js';

/** The task a conversation is on now: the one most recently moved on. */
export function currentTask(tasks: readonly SessionTask[] | undefined): SessionTask | undefined {
  return tasks?.reduce<SessionTask | undefined>((latest, task) => !latest || task.updatedAt >= latest.updatedAt ? task : latest, undefined);
}
