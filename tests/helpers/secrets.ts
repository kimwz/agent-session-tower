/** Shared fixtures for secret tests: a vault on a temporary state folder and owner run registries. No personal state is read. */
import { randomUUID } from 'node:crypto';
import { SecretService } from '../../server/secrets/service.js';
import type { Capability } from '../../server/api/mcp.js';
import type { SessionOrigin } from '../../server/runs/origin.js';
import type { Run, Session } from '../../shared/types.js';

/** A started service on stateDir, initialized with password; without one it stays as a restarted worker finds it. */
export async function secretService(stateDir: string, options: { password?: string; now?: () => number } = {}): Promise<SecretService> {
  const service = new SecretService({ stateDir, ...(options.now ? { now: options.now } : {}) });
  await service.start();
  if (options.password !== undefined) await service.initialize(options.password);
  return service;
}

const session = (id: string, root: string, status: Session['status']): Session => {
  const at = new Date().toISOString();
  return { id, nativeId: id.slice(6), provider: 'codex', title: 'fixture', cwd: root, project: 'fixture', status, statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
};

/** Owner sessions and their running owner runs, as the run registry reports them to the secret runtime. */
export class FixtureRuns {
  readonly sessions = new Map<string, Session>(); readonly running: Run[] = [];
  /** An idle owner session without a run. */
  session(id: string, root: string): void { this.sessions.set(id, session(id, root, 'idle')); }
  /** An owner session with one running owner run, and that run's secret capability. */
  add(root: string, sessionId = `codex:${randomUUID()}`): Extract<Capability, { kind: 'secret-run' }> {
    const runId = randomUUID(); const at = new Date().toISOString();
    this.sessions.set(sessionId, session(sessionId, root, 'working'));
    this.running.push({ id: runId, sessionId, prompt: 'fixture owner task', status: 'running', createdAt: at, startedAt: at, output: '', origin: { kind: 'owner' }, towerTools: 'attached' });
    return { kind: 'secret-run', runId, sessionId };
  }
  list() { return this.running; } getSession(id: string) { return this.sessions.get(id); }
  sessionOrigin(_id: string): SessionOrigin { return { kind: 'owner', untrustedInput: false }; }
}
