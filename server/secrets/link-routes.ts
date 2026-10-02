import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { readJson, errorStatus } from '../http/requests.js';
import type { SecretPeer, SecretTarget } from '../../shared/secrets.js';
import { REMOTE_SECRET_MAX_RESPONSE_BYTES } from './remote.js';
import type { RemoteNodes } from '../link/nodes.js';
import { linkRequest } from '../link/transport.js';
import { z } from 'zod';

interface Worker { secretCall(operation: string, args?: unknown[]): Promise<unknown> }
const fail = (message: string, statusCode = 403) => Object.assign(new Error(message), { statusCode });

/** Paired TLS callers can relay envelopes and ask for a verified task, never manage the Vault. */
export async function handleSecretLink(req: Http2ServerRequest, res: Http2ServerResponse, controllerId: string, worker: Worker): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'https://tower.invalid');
  if (!['/secret-relay', '/secret-target', '/secret-device', '/secret-connection-notice'].includes(url.pathname)) return false;
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    const peers = await worker.secretCall('peers') as SecretPeer[];
    if (!peers.some(peer => peer.enabled && peer.direction === 'controller' && peer.routeId === controllerId)) throw fail('이 컴퓨터에 시크릿 공유를 승인하지 않았습니다.');
    if (url.pathname === '/secret-relay' && req.method === 'GET') reply(200, await worker.secretCall('poll', [controllerId]));
    else if (url.pathname === '/secret-relay' && req.method === 'POST') {
      const body = await readJson(req as unknown as IncomingMessage, REMOTE_SECRET_MAX_RESPONSE_BYTES + 1024) as { response?: unknown };
      reply(200, await worker.secretCall('deliver', [controllerId, body.response]));
    } else if (url.pathname === '/secret-connection-notice' && req.method === 'POST') {
      const input = z.object({ sessionId: z.string().min(1).max(1024), taskId: z.string().uuid() }).strict().parse(await readJson(req as unknown as IncomingMessage, 4096));
      reply(200, await worker.secretCall('connection-notice', [input.sessionId, input.taskId]));
    } else if (url.pathname === '/secret-device' && req.method === 'GET') reply(200, await worker.secretCall('device'));
    else if (url.pathname === '/secret-target' && req.method === 'GET' && url.searchParams.get('sessionId')) { const target = await worker.secretCall('target', [url.searchParams.get('sessionId'), url.searchParams.get('create') !== 'false']); reply(target ? 200 : 204, target); }
    else reply(404, { error: '알 수 없는 시크릿 전달 요청입니다.' });
  } catch (error) { reply(errorStatus(error), { error: '시크릿 전달 요청을 처리할 수 없습니다. 잠금·컴퓨터 승인·연결 상태를 확인하세요.' }); }
  return true;
}

/** Resolve the page's remote selection against the pinned link and separately approved secret device. */
export async function ownerRemoteTarget(nodes: RemoteNodes | undefined, worker: Worker, input: Record<string, unknown>, create = false): Promise<SecretTarget | undefined> {
  if (input.nodeId === undefined) return undefined;
  if (!nodes || typeof input.nodeId !== 'string' || typeof input.sessionId !== 'string') throw fail('원격 프로젝트 세션을 선택하세요.', 400);
  const peer = (await worker.secretCall('peers') as SecretPeer[]).find(item => item.enabled && item.direction === 'node' && item.routeId === input.nodeId);
  const link = nodes.session(input.nodeId);
  if (!peer || !link) throw fail('원격 컴퓨터의 시크릿 승인과 연결이 필요합니다.', 503);
  const response = await linkRequest(link, 'GET', `/secret-target?sessionId=${encodeURIComponent(input.sessionId)}&create=${create ? 'true' : 'false'}`, undefined, 8000, { maxBytes: 32 * 1024 });
  if (response.status === 204) return undefined;
  const target = response.json as SecretTarget;
  if (response.status !== 200 || !target || target.hostId !== peer.device.id || typeof target.taskId !== 'string' || typeof target.root !== 'string' || typeof target.sessionId !== 'string') throw fail('원격 세션의 시크릿 작업을 확인할 수 없습니다.', 503);
  return target;
}

/** Owner assignment only: carry a fixed notice to its verified remote worker before reading the overview. */
export async function ownerSecretControl(nodes: RemoteNodes | undefined, worker: Worker, action: string, input: Record<string, unknown>): Promise<unknown> {
  const target = typeof input.sessionId === 'string' && action !== 'lock' ? await ownerRemoteTarget(nodes, worker, input, ['create','attach','connect'].includes(action)) : undefined;
  const { target: _target, hostId: _host, taskId: _task, projectRoot: _root, ...safe } = input;
  const remoteConnection = !!target && input.notifySession === true && ((action === 'create' && input.connect === true) || action === 'connect' || action === 'attach');
  const result = await worker.secretCall('control', [action, safe, target, remoteConnection]);
  if (!remoteConnection) return result;
  const connected = (result as { connectedTarget?: SecretTarget }).connectedTarget;
  if (!connected || connected.hostId !== target!.hostId || connected.sessionId !== target!.sessionId || connected.taskId !== target!.taskId) throw fail('연결한 원격 작업의 완료 기록을 확인할 수 없습니다.', 503);
  // An uncertain insert is never sent a second time, and cannot undo the committed grant.
  try {
    const link = nodes?.session(input.nodeId as string);
    if (!link) throw fail('원격 알림 연결이 종료되었습니다.', 503);
    const response = await linkRequest(link, 'POST', '/secret-connection-notice', { sessionId: connected.sessionId, taskId: connected.taskId }, 8000, { maxBytes: 4096 });
    if (response.status !== 200) throw fail('원격 알림을 확인하지 못했습니다.', 503);
  } catch { console.warn('Tower could not confirm the remote secret-connection notice; credentials remain discoverable when needed.'); }
  return worker.secretCall('control', ['overview', { ...safe, notifySession: false }, connected]);
}
