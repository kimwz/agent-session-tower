import { setTimeout } from 'node:timers/promises';
import type { MonitorAlreadyRunning } from './state-lock.js';
import { HEALTH_APPLICATION_ID } from '../shared/app-identity.js';

/** A live PID alone is insufficient: verify that the owner serves our protocol. */
export async function existingServerUrl(error: MonitorAlreadyRunning, expected?: {
  bindHost: string; remoteAccess: boolean; probeHosts: string[];
}): Promise<string | undefined> {
  const { pid, port } = error.owner;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const hosts = [...new Set(expected?.probeHosts || ['127.0.0.1'])];
  for (let attempt = 0; attempt < 15; attempt++) {
    let reachedServer = false;
    for (const host of hosts) {
      let response: Response;
      let health;
      try {
        response = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(700), redirect: 'error' });
        health = await response.json();
        reachedServer = true;
      } catch { continue; }
      if (!response.ok || !health || health.ok !== true || health.application !== HEALTH_APPLICATION_ID || health.pid !== pid) continue;
      // Older local-only versions did not report binding information.
      const bindHost = health.bindHost || '127.0.0.1';
      const remoteAccess = health.remoteAccess === true;
      if (expected && (bindHost !== expected.bindHost || remoteAccess !== expected.remoteAccess)) {
        throw new Error(`Agent Session Tower is already running with --host ${bindHost} (PID ${pid}). Stop that process first, then restart with --host ${expected.bindHost}.`);
      }
      return bindHost === '0.0.0.0' || bindHost === '127.0.0.1' ? `http://localhost:${port}` : `http://${bindHost}:${port}`;
    }
    if (reachedServer) return undefined;
    if (attempt < 14) await setTimeout(200);
  }
  return undefined;
}
