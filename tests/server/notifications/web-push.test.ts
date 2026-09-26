import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { encryptPayload, generateVapidKeys, sendPush, vapidAuthorization } from '../../../server/notifications/web-push.js';

/** A browser's side of a subscription: what it hands the server, and how it reads what arrives. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const target = { endpoint: 'https://push.example/send/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const decrypt = (message: Buffer) => {
    const salt = message.subarray(0, 16), keyLength = message.readUInt8(20);
    assert.equal(message.readUInt32BE(16), 4096);
    const serverPublic = message.subarray(21, 21 + keyLength);
    const shared = ecdh.computeSecret(serverPublic);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverPublic]), 32));
    const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const record = message.subarray(21 + keyLength);
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(record.subarray(-16));
    const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2);
    return plain.subarray(0, -1).toString();
  };
  return { target, decrypt };
}

test('push messages decrypt with only the browser subscription keys, and each message uses fresh keys', () => {
  const { target, decrypt } = browser();
  const first = encryptPayload(target, Buffer.from('{"title":"완료"}'));
  const second = encryptPayload(target, Buffer.from('{"title":"완료"}'));
  assert.equal(decrypt(first), '{"title":"완료"}');
  assert.notDeepEqual(first.subarray(0, 86), second.subarray(0, 86));
  assert.throws(() => encryptPayload({ ...target, keys: { ...target.keys, auth: 'short' } }, Buffer.from('x')));
});

test('VAPID authorization is an ES256 token for the push service origin, verifiable with the public key', () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://example.test', Date.parse('2026-09-26T00:00:00Z'));
  const [, jwt, publicKey] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(publicKey, keys.publicKey);
  const [head, claims, signature] = jwt.split('.');
  const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.deepEqual(body, { aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-09-26T12:00:00Z') / 1000, sub: 'https://example.test' });
  const point = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('delivery reports gone subscriptions separately from other failures', async () => {
  const { target, decrypt } = browser();
  const keys = generateVapidKeys();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const reply = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => { requests.push({ url: String(url), init: init! }); return new Response(null, { status }); }) as typeof fetch;
  assert.equal(await sendPush(target, { title: 'hi' }, keys, 'https://example.test', reply(201)), 'sent');
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers['Content-Encoding'], 'aes128gcm');
  assert.equal(decrypt(Buffer.from(requests[0].init.body as Uint8Array)), '{"title":"hi"}');
  assert.equal(await sendPush(target, {}, keys, 'https://example.test', reply(410)), 'gone');
  assert.equal(await sendPush(target, {}, keys, 'https://example.test', reply(404)), 'gone');
  assert.equal(await sendPush(target, {}, keys, 'https://example.test', reply(429)), 'failed');
});

test('encryption reproduces the RFC 8291 example message', () => {
  const server = createECDH('prime256v1');
  server.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const message = encryptPayload({ endpoint: 'https://push.example/', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
    Buffer.from('When I grow up, I want to be a watermelon'), Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), server);
  assert.equal(message.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});
