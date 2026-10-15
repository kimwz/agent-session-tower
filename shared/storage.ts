/** Public worker diagnosis. Database paths and commands remain inside the execution worker. */
export interface WorkerStorageStatus {
  state: 'starting' | 'ready' | 'update-held' | 'recovery-required' | 'unavailable';
  code: string;
  reason: string;
  admissionOpen: boolean;
  sessionsAvailable: boolean;
  healthStatus: 200 | 503;
  identity?: { appVersion: string; protocol: string; sourceHash: string; manifestDigest: string };
  failure?: { phase: string; code: string; message: string; retryable: boolean; sourcePreserved: boolean; at: string; disposition?: 'committed' | 'not-committed' | 'unknown' };
}
