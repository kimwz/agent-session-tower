import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type ECDH, type KeyObject } from 'node:crypto';

/** A browser's push subscription as `PushSubscription.toJSON()` gives it. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
/** The server's VAPID key pair, base64url: `publicKey` is the raw 65-byte point browsers subscribe with. */
export interface VapidKeys { publicKey: string; privateKey: string }

const b64url = (value: Buffer) => value.toString('base64url');

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

function signingKey(keys: VapidKeys): KeyObject {
  const point = Buffer.from(keys.publicKey, 'base64url');
  return createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) } });
}

/** The `Authorization` header a push service accepts from this server (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** Encrypts one message for a subscription as a single aes128gcm record (RFC 8291, RFC 8188). */
export function encryptPayload(target: PushTarget, payload: Buffer, salt = randomBytes(16), server?: ECDH): Buffer {
  const client = Buffer.from(target.keys.p256dh, 'base64url');
  const auth = Buffer.from(target.keys.auth, 'base64url');
  if (client.length !== 65 || auth.length !== 16) throw new Error('The push subscription keys are invalid.');
  if (!server) { server = createECDH('prime256v1'); server.generateKeys(); }
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(client);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), client, serverPublic]), 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // A single, final record: the content, then the 0x02 delimiter and no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, body]);
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Delivers one message. `gone` means the browser dropped the subscription, so it should be forgotten. */
export async function sendPush(target: PushTarget, payload: unknown, keys: VapidKeys, subject: string, fetcher: typeof fetch = fetch): Promise<PushResult> {
  const response = await fetcher(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(target.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(24 * 3600), Urgency: 'high',
    },
    body: new Uint8Array(encryptPayload(target, Buffer.from(JSON.stringify(payload)))),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  await response.arrayBuffer().catch(() => undefined);
  if (response.ok) return 'sent';
  return response.status === 404 || response.status === 410 ? 'gone' : 'failed';
}
