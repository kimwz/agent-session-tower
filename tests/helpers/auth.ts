import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AuthStore } from '../../server/auth/store.js';

/** Keep auth regression requests remote even though the fixture listens on loopback. */
export async function createRemoteAuthFixture(dir: string) {
  const auth = new AuthStore(join(dir, 'auth-fixture'));
  await auth.start();
  await auth.setCredentials('monitor', 'fixture-password-123');
  const result = await auth.login('127.0.0.1', 'monitor', 'fixture-password-123');
  assert.ok(result.sessionId);
  const cookie = `tower_session=${result.sessionId}`;
  const origins = new Set<string>();
  const fetch = (input: string | URL, init: RequestInit = {}) => {
    const host = `remote.test:${new URL(input).port}`;
    origins.add(`http://${host}`);
    const headers = new Headers(init.headers);
    headers.set('Host', host);
    // Node fetch may normalize Host to the URL authority. A proxy marker also
    // makes the request nonlocal without trusting its claimed client address.
    headers.set('X-Forwarded-For', '192.0.2.1');
    return globalThis.fetch(input, { ...init, headers });
  };
  return { auth, origins, cookie, fetch };
}
