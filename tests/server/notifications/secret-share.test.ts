import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationService, secretShareMessage, type NotificationContext } from '../../../server/notifications/service.js';
import { FollowingSecrets } from '../../../server/link/secret-follow.js';
import type { SecretShareNotice } from '../../../shared/secrets.js';

const subscription = () => {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: `https://push.example/${randomBytes(4).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};
const wait = () => new Promise(resolve => setTimeout(resolve, 20));

test('a share request names the computer and the secret, and opens that secret’s sharing for that computer', () => {
  const notice: SecretShareNotice = { key: 'secret-share:s:h:1', at: 1, kind: 'not-shared', nodeId: 'n'.repeat(32), nodeName: 'office-tower-1', hostId: 'vault-of-node', secretId: 'secret-1', secretName: 'GITHUB_TOKEN' };
  assert.deepEqual(secretShareMessage(notice, 'ko'), { title: '시크릿 공유 요청', body: 'office-tower-1 작업이 GITHUB_TOKEN을(를) 쓰려 합니다. 눌러서 이 머신에 공유하세요.', url: '/?secretShare=secret-1&machine=vault-of-node', tag: notice.key });
  assert.match(secretShareMessage(notice, 'en').body, /office-tower-1 wants to use GITHUB_TOKEN/);
  const locked = secretShareMessage({ key: 'secret-locked:n:1', at: 1, kind: 'host-locked', nodeId: 'n', nodeName: 'office-tower-1' }, 'ko');
  assert.deepEqual([locked.title, locked.url], ['시크릿 보관함 잠김', '/?secretShare=']);
  assert.match(locked.body, /office-tower-1 작업이 시크릿을 쓰려 했지만/);
});

test('each share request is pushed once, to devices that hear what waits on the owner, also across a restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-secret-share-'));
  const sent: string[] = [];
  const fetcher = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response(null, { status: 201 }); }) as typeof fetch;
  let notices: SecretShareNotice[] = [];
  const context: NotificationContext = { runs: () => [], session: () => undefined, project: () => '', trigger: () => undefined, secretShares: () => notices };
  let service = new NotificationService(dir, context, fetcher);
  await service.start();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const phone = subscription(); await service.subscribe({ subscription: phone }); await service.subscribe({ subscription: subscription(), events: { runWaiting: false } });
  notices = [{ key: 'secret-share:a:b:1', at: Date.now() + 1000, kind: 'not-shared', nodeId: 'n', secretId: 'a', hostId: 'b', secretName: 'TOKEN' }];
  service.check(); service.check(); await wait(); service.check(); await wait();
  assert.deepEqual(sent, [phone.endpoint]);
  await service.close();
  service = new NotificationService(dir, context, fetcher); await service.start(); service.check(); await wait();
  assert.equal(sent.length, 1);
});

test('the host keeps each following computer’s secret state for its card, and tells of its locked vault once per ten minutes', async () => {
  let now = 1_000_000; const listeners = new Map<string, (id: string) => void>();
  const following = new FollowingSecrets({ controller: { list: () => [], following: () => true, on: (event, listener) => { listeners.set(event, listener); } },
    worker: { supports: () => true, secretCall: async () => { throw new Error('not asked'); } }, link: async () => undefined, canonical: async path => path, now: () => now });
  following.start();
  try {
    assert.equal(following.status('node'), undefined, 'not known before it was checked');
    following.locked('node'); following.locked('node');
    assert.deepEqual(following.notices().map(notice => [notice.kind, notice.nodeId]), [['host-locked', 'node']]);
    now += 10 * 60_000; following.locked('node');
    assert.equal(following.notices().length, 2);
    now += 2 * 60 * 60_000; assert.deepEqual(following.notices(), [], 'kept for an hour');
  } finally { following.close(); }
});
