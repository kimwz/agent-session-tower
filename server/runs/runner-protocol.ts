import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutoPromptJob, Run, Session, SessionDetail } from '../../shared/types.js';
import type { TriggerOverview } from '../../shared/triggers.js';

export const RUNNER_PROTOCOL = 1;
export const MAX_RPC_BYTES = 40 * 1024 * 1024;
/**
 * Optional operations this worker build serves. A web process checks the attached worker's list
 * before calling one, because an older worker keeps running until it is idle.
 */
export const RUNNER_CAPABILITIES = ['heartbeatAdmission', 'sessionHistory', 'origins', 'handoff', 'triggers', 'toolCapabilities', 'remoteOrigins', 'remoteTriggers', 'publicAgents', 'autoPromptTargets', 'steerTargets', 'subscriptionOnly', 'skills', 'towerSkills', 'skillTargets', 'forceUpdate', 'backup', 'models', 'delegation', 'masterWorker', 'secrets', 'attachmentReferences', 'workerClosed', 'retention', 'compaction'] as const;
export type RunnerCapability = typeof RUNNER_CAPABILITIES[number];
/** One page of a native conversation, read by the worker that already indexes native history. */
export type SessionHistoryPage = Pick<SessionDetail, 'messages' | 'hasMore' | 'nextBefore' | 'previousUser'>;
export interface RunnerSnapshot {
  instance: string;
  revision: number;
  runs: Run[];
  sessions: Session[];
  nativeIds: Record<string, string>;
  /** The execution worker owns closure writes when workerClosed is advertised. */
  closedIds?: string[];
  settled: string[];
  autoPrompts: AutoPromptJob[];
  /** Absent from workers that predate version reporting. */
  version?: string;
  /** Absent from workers that predate optional operations. */
  capabilities?: string[];
  /** Present only on a worker started by a predecessor's handoff; it matches that predecessor's record. */
  handoff?: string;
  triggers?: TriggerOverview;
  /** Coordinator conversations (Slack, GitHub). Absent from workers that cannot serve remote controllers. */
  coordinators?: string[];
  /** While the owner's forced update waits for running turns to wrap up. */
  updateDrain?: UpdateDrainStatus;
}
export interface UpdateDrainStatus { startedAt: string; deadline: string; running: number }
/** How long a forced update lets running turns wrap up before stopping them. */
export const FORCE_UPDATE_DEADLINE_MS = 10 * 60 * 1000;
/** How long after the deadline a forced update may still wait to hand off before new turns start here again. */
export const FORCE_UPDATE_GIVE_UP_MS = 10 * 60 * 1000;
export interface RunnerReply {
  protocol: number;
  stateDir: string;
  instance: string;
  snapshot?: RunnerSnapshot;
  result?: unknown;
  error?: { message: string; statusCode: number; disposition?: string };
}

/** Pure calculation for fixture teardown: never recreates a deleted state directory. */
export function runnerDirectoryForCanonicalState(canonical: string): string {
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return join('/tmp', `tower-runner-${process.getuid?.() ?? 'user'}-${hash}`);
}

/** Short UDS paths work on macOS; an owner-only directory protects socket and token. */
export async function runnerPaths(stateDir: string) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const canonical = await realpath(stateDir);
  const directory = runnerDirectoryForCanonicalState(canonical);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) {
    throw new Error('Runner socket directory must be owned by this user with mode 0700.');
  }
  return { stateDir: canonical, directory, socket: join(directory, 'rpc.sock'), token: join(directory, 'token'), runtime: join(canonical, 'runner-runtime') };
}
