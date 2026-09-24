import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson } from '../http/requests.js';
import type { RemoteExclusionStore } from '../remote/exclusions.js';
import type { ControllerLinks } from './controller.js';
import type { NodeLinks } from './node.js';
import type { LinkIdentity } from './identity.js';

export interface LinkRoutes {
  identity: LinkIdentity;
  hostname: () => string;
  controller: ControllerLinks;
  node: NodeLinks;
  exclusions: RemoteExclusionStore;
}

/**
 * This Tower's own pages manage its links: the computers it controls, the ones that control it, and the
 * folders it never shares. A remote controller's link has no route here.
 */
export async function handleLinkRoute(req: IncomingMessage, res: ServerResponse, path: string, links: LinkRoutes | { error: string }, json: (res: ServerResponse, status: number, body: unknown) => void): Promise<boolean> {
  if (!path.startsWith('/api/link')) return false;
  if ('error' in links) { json(res, 503, { error: links.error }); return true; }
  const overview = () => ({
    identity: { name: links.hostname(), fingerprint: links.identity.fingerprint, version: links.controller.version },
    hub: links.controller.hub(),
    nodes: links.controller.list(),
    controllers: links.node.list(),
    exclusions: { folders: links.exclusions.list(), revision: links.exclusions.revision, ...(links.exclusions.error ? { error: links.exclusions.error } : {}) },
    ...(links.controller.error || links.node.error ? { errors: [links.controller.error, links.node.error].filter((item): item is string => Boolean(item)) } : {}),
  });
  if (req.method === 'GET' && path === '/api/link') { json(res, 200, overview()); return true; }
  if (req.method !== 'POST') return false;
  const body = await readJson(req, 16 * 1024);
  const only = (...keys: string[]) => Object.keys(body).every(key => keys.includes(key));
  if (path === '/api/link/hub') {
    if (!only('enabled', 'port') || (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.port !== undefined && typeof body.port !== 'number')) { json(res, 400, { error: '연결 받기 설정이 올바르지 않습니다.' }); return true; }
    // A port chosen by the system would change on every restart, and joined computers would lose this one.
    if (body.port !== undefined && (!Number.isInteger(body.port) || (body.port as number) < 1024 || (body.port as number) > 65535)) { json(res, 400, { error: '포트는 1024에서 65535 사이여야 합니다.' }); return true; }
    await links.controller.setHub({ ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}), ...(body.port !== undefined ? { port: body.port as number } : {}) });
    json(res, 200, overview()); return true;
  }
  if (path === '/api/link/invite') {
    if (!only()) { json(res, 400, { error: '요청 본문은 비워 두세요.' }); return true; }
    json(res, 200, await links.controller.invite()); return true;
  }
  if (path === '/api/link/join') {
    if (!only('code') || typeof body.code !== 'string') { json(res, 400, { error: '연결 코드를 붙여 넣으세요.' }); return true; }
    await links.node.join(body.code);
    json(res, 200, overview()); return true;
  }
  const node = path.match(/^\/api\/link\/nodes\/([a-f0-9]{32})(\/remove|\/update)?$/);
  if (node) {
    if (node[2] && !only()) { json(res, 400, { error: '요청 본문은 비워 두세요.' }); return true; }
    if (node[2] === '/remove') await links.controller.remove(node[1]);
    else if (node[2] === '/update') await links.controller.update(node[1]);
    else { if (!only('label') || typeof body.label !== 'string') { json(res, 400, { error: '표시 이름을 입력하세요.' }); return true; } await links.controller.rename(node[1], body.label); }
    json(res, 200, overview()); return true;
  }
  const controller = path.match(/^\/api\/link\/controllers\/([a-f0-9]{32})\/remove$/);
  if (controller) {
    if (!only()) { json(res, 400, { error: '요청 본문은 비워 두세요.' }); return true; }
    await links.node.remove(controller[1]);
    json(res, 200, overview()); return true;
  }
  return false;
}
