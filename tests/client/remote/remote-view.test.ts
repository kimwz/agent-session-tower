import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, Snapshot } from '../../../shared/types.js';
import type { RemoteNode } from '../../../shared/link.js';
import { localPart, nodeHeaders, nodeOf, nodePath, pathFor, refusedBeforeRunning, requestId, scopedId, scopeSnapshot, settleRequest, splitScopedId } from '../../../client/src/remote/scope.js';
import { combinedView, hostProblem, hostState, workspaceNote } from '../../../client/src/remote/hosts.js';
import { localOnlyAddress, RemoteContent } from '../../../client/src/remote/remote-content.js';
import { Markdown } from '../../../client/src/chat/Markdown.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { graphProjectId, graphProjectKey } from '../../../client/src/graph/graph-layout.js';
import { canvasVisibleSessions, projectGroupChoices, projectGroupLabel } from '../../../client/src/project-groups/project-groups.js';
import { defaultGraphPreferences, moveManualGraphNodes, parseGraphPreferences, reconcileManualGraph } from '../../../client/src/graph/graph-layout-preferences.js';

const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const at = '2026-09-24T00:00:00.000Z';
const session = (id: string, cwd: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id.split(':')[1], provider: 'codex', title: id, cwd, project: cwd.split('/').at(-1)!,
  status: 'idle', statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...extra });
const snapshot = (sessions: Session[], extra: Partial<Snapshot> = {}): Snapshot => ({ sessions, runs: [], providers: [], scanning: false, hostname: 'h', version: '1.23.0', updatedAt: at, ...extra });
const remote = (id: string, name: string, extra: Partial<RemoteNode> = {}): RemoteNode => ({ id, name, status: 'connected', features: ['read', 'work'], streaming: true, ...extra });

test('ids of another computer carry its name in the page and reach it through its own API path', () => {
  assert.equal(scopedId(undefined, 'codex:1'), 'codex:1', 'this computer keeps its plain ids and saved keys');
  assert.equal(scopedId(B, 'codex:1'), `@${B}/codex:1`);
  assert.deepEqual(splitScopedId(`@${B}//Users/me/app`), { node: B, id: '/Users/me/app' });
  assert.deepEqual(splitScopedId('@someone/else'), { id: '@someone/else' });
  assert.equal(nodeOf(`@${B}/x`), B);
  assert.equal(localPart(`@${B}//Users/me/app`), '/Users/me/app');
  assert.equal(nodePath(undefined, '/api/sessions'), '/api/sessions');
  assert.equal(nodePath(B, '/api/sessions'), `/api/nodes/${B}/sessions`);
  assert.equal(pathFor(`@${B}/codex:a b`, id => `/api/sessions/${encodeURIComponent(id)}/title`), `/api/nodes/${B}/sessions/codex%3Aa%20b/title`);
  const id = requestId(Date.UTC(2026, 8, 24));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(parseInt(id.replace(/-/g, '').slice(0, 12), 16), Date.UTC(2026, 8, 24), 'the request id records when it was made');
});

test('a joined computer’s snapshot is renamed throughout, so its links between items still hold', () => {
  const named = scopeSnapshot(B, snapshot([session('codex:parent', '/work/app'), session('codex:child', '/work/app', { parentId: 'codex:parent' })], {
    runs: [{ id: 'run-1', sessionId: 'codex:parent', prompt: 'p', status: 'running', createdAt: at, output: '', attachments: [{ id: 'file-1', name: 'a.png', mimeType: 'image/png', size: 1 }] }],
    autoPrompts: [{ id: 'job-1', provider: 'codex', prompt: 'x', routerModel: 'r', status: 'completed', createdAt: at, updatedAt: at, cwd: '/work/app', sessionId: 'codex:parent', decision: { action: 'resume', cwd: '/work/app', sessionId: 'codex:parent', reason: '' } }],
    groups: [{ cwd: '/work/app', title: 'App', pinned: true }],
    repositories: [{ cwd: '/work/app', root: '/work/app', checkedAt: at }] as Snapshot['repositories'],
  }));
  assert.deepEqual(named.sessions.map(item => [item.id, item.cwd, item.parentId, item.node]), [[`@${B}/codex:parent`, `@${B}//work/app`, undefined, B], [`@${B}/codex:child`, `@${B}//work/app`, `@${B}/codex:parent`, B]]);
  assert.deepEqual([named.runs[0].id, named.runs[0].sessionId, named.runs[0].attachments?.[0].id], [`@${B}/run-1`, `@${B}/codex:parent`, `@${B}/file-1`]);
  const job = named.autoPrompts![0];
  assert.deepEqual([job.id, job.sessionId, job.cwd, job.decision?.sessionId, job.node], [`@${B}/job-1`, `@${B}/codex:parent`, `@${B}//work/app`, `@${B}/codex:parent`, B]);
  assert.equal(named.groups![0].cwd, `@${B}//work/app`);
  assert.deepEqual([named.repositories![0].cwd, named.repositories![0].root], [`@${B}//work/app`, '/work/app']);
});

test('without joined computers the page shows this computer’s snapshot itself', () => {
  const local = snapshot([session('codex:1', '/work/app')]);
  const { view, hosts } = combinedView(local, new Map());
  assert.equal(view, local);
  assert.deepEqual(hosts.map(host => [host.node, host.status, host.canWork]), [[undefined, 'local', true]]);
});

test('two computers with the same folder and session ids stay apart in lists, frames and saved places', () => {
  const local = snapshot([session('codex:1', '/work/app')], { nodes: [remote(B, 'studio'), remote(C, 'laptop', { status: 'offline', streaming: false, label: 'Laptop' })] });
  const same = snapshot([session('codex:1', '/work/app')]);
  const { view, hosts } = combinedView(local, new Map([[B, same], [C, same]]));
  const ids = view!.sessions.map(item => item.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(new Set(view!.sessions.map(graphProjectKey)).size, 3, 'each computer’s folder is its own frame');
  assert.equal(new Set(view!.sessions.map(item => graphProjectId(graphProjectKey(item)))).size, 3);
  assert.deepEqual(projectGroupChoices(view!.sessions, []).map(([key]) => key).sort(), ['/work/app', `@${B}//work/app`, `@${C}//work/app`].sort());
  assert.equal(projectGroupLabel(`@${B}//work/app`), 'app');
  assert.deepEqual(hosts.map(host => [host.name, host.live, host.canWork, host.known]), [['h', true, true, true], ['studio', true, true, true], ['Laptop', false, false, true]]);
  const older = combinedView(snapshot([], { nodes: [remote(B, 'studio', { features: ['read'] })] }), new Map([[B, same]]));
  assert.equal(older.hosts[1].canWork, false, 'a computer whose worker cannot take remote work is shown but not sent work');
});

test('temporary folders stay off the canvas on every computer', () => {
  const sessions = [session(`@${B}/codex:1`, `@${B}//private/tmp/worktree`, { node: B }), session(`@${B}/codex:2`, `@${B}//work/app`, { node: B })];
  assert.deepEqual(canvasVisibleSessions(sessions, [], false).map(item => item.id), [`@${B}/codex:2`]);
});

test('hand-placed cards of a computer not heard from yet keep their places, and its host node keeps its own', () => {
  const card = `@${B}/codex:1`;
  const project = graphProjectId(`@${B}//work/app`);
  const layout = { ...defaultGraphPreferences().layout, projects: { [project]: { position: { x: 400, y: 200 }, width: 282, height: 330 } }, agents: { [card]: { projectId: project, position: { x: 20, y: 106 } } } };
  const kept = reconcileManualGraph(layout, [], true, [], [], { retain: id => id === card || id === project });
  assert.ok(kept.agents[card] && kept.projects[project]);
  const pruned = reconcileManualGraph(layout, [], true, [], []);
  assert.equal(pruned.agents[card], undefined, 'a computer this page knows no longer has that session');
  const moved = moveManualGraphNodes(layout, [{ id: `host:${B}`, position: { x: 900, y: -40 } }]);
  assert.deepEqual(moved.hosts, { [B]: { x: 900, y: -40 } });
  const saved = parseGraphPreferences(JSON.stringify({ version: 1, mode: 'manual', layout: moved }));
  assert.deepEqual(saved.layout.hosts, { [B]: { x: 900, y: -40 } });
});

test('links from another computer to its own local addresses are recognized so they are not opened here', () => {
  for (const href of ['http://localhost:3000/', 'http://127.0.0.1:8080', 'http://[::1]:5173/', 'http://192.168.0.12/', 'http://10.1.2.3', 'http://172.20.0.1', 'http://169.254.1.1', 'http://studio.local:3000', 'http://100.101.1.2', 'http://[fd00::1]/'])
    assert.equal(localOnlyAddress(href), true, href);
  for (const href of ['//localhost:3000/app', 'http://localhost.:3000/app', '/api/snapshot', 'relative/page', 'http://intranet/', 'http://0.0.0.0:8000'])
    assert.equal(localOnlyAddress(href), true, href);
  for (const href of ['https://github.com/kimwz/agent-session-tower', 'http://172.32.0.1', 'https://fda.gov', 'https://fc2.com', 'mailto:me@example.com', undefined])
    assert.equal(localOnlyAddress(href), false, String(href));
});

test('another computer’s conversation shows its local links as text and keeps other links', () => {
  const render = (value: string | undefined) => renderToStaticMarkup(createElement(RemoteContent.Provider, { value }, createElement(Markdown, null, '[dev server](http://localhost:3000) and [docs](https://example.com)')));
  const remote = render('studio');
  assert.match(remote, /<span class="markdown-local-link" title="studio에서만 열 수 있는 주소입니다: http:\/\/localhost:3000">dev server<\/span>/);
  assert.match(remote, /<a href="https:\/\/example.com" target="_blank"/);
  assert.match(render(undefined), /<a href="http:\/\/localhost:3000"/, 'this computer’s own links open as before');
});

test('a request to another computer keeps its ID until it is settled, and changed content is a new request', () => {
  const id = (headers: Record<string, string>) => headers['X-Tower-Request-Id'];
  const first = id(nodeHeaders(B, {}, 'message:x', '{"prompt":"a"}'));
  assert.equal(id(nodeHeaders(B, {}, 'message:x', '{"prompt":"a"}')), first, 'sending it again after an unknown outcome is the same request');
  assert.notEqual(id(nodeHeaders(C, {}, 'message:x', '{"prompt":"a"}')), first, 'another computer is another request');
  const edited = id(nodeHeaders(B, {}, 'message:x', '{"prompt":"b"}'));
  assert.notEqual(edited, first);
  settleRequest(B, 'message:x');
  assert.notEqual(id(nodeHeaders(B, {}, 'message:x', '{"prompt":"b"}')), edited, 'once settled, the next send is new');
  // A send that may have run keeps its ID, even when a later attempt is refused before running.
  const risky = id(nodeHeaders(B, {}, 'message:y', 'same'));
  settleRequest(B, 'message:y', { status: 409, disposition: 'uncertain' });
  assert.equal(id(nodeHeaders(B, {}, 'message:y', 'same')), risky);
  settleRequest(B, 'message:y', { status: 503, disposition: 'not-admitted' });
  assert.equal(id(nodeHeaders(B, {}, 'message:y', 'same')), risky);
  settleRequest(B, 'message:y');
  assert.notEqual(id(nodeHeaders(B, {}, 'message:y', 'same')), risky, 'a success settles it');
  const refused = id(nodeHeaders(B, {}, 'message:z', 'same'));
  settleRequest(B, 'message:z', { status: 400 });
  assert.notEqual(id(nodeHeaders(B, {}, 'message:z', 'same')), refused, 'a plain refusal never ran');
  assert.deepEqual(nodeHeaders(undefined, { a: '1' }, 'message:x', 'x'), { a: '1' }, 'this computer needs no request ID');
  assert.equal(refusedBeforeRunning({ status: 503, disposition: 'not-admitted' }), true);
  assert.equal(refusedBeforeRunning({ status: 409 }), true);
  assert.equal(refusedBeforeRunning({ status: 409, disposition: 'uncertain' }), false, 'the ledger says it may have run');
  assert.equal(refusedBeforeRunning({ status: 503, disposition: 'uncertain' }), false);
  assert.equal(refusedBeforeRunning(new TypeError('Failed to fetch')), false);
});

test('a computer still reading its sessions is not treated as known, so saved places and read marks stay', () => {
  const { hosts } = combinedView(snapshot([], { nodes: [remote(B, 'studio')] }), new Map([[B, snapshot([], { scanning: true })]]));
  assert.equal(hosts[1].known, false);
});

test('each state of a joined computer explains in one sentence why work cannot go there, or says nothing when it can', () => {
  const view = (node: Partial<RemoteNode>, known = true) => combinedView(snapshot([], { nodes: [remote(B, 'studio', node)] }), known ? new Map([[B, snapshot([])]]) : new Map()).hosts[1];
  assert.equal(hostState(view({})), 'ready');
  assert.equal(hostProblem(view({})), undefined);
  assert.equal(hostState(view({ status: 'offline', streaming: false })), 'offline');
  assert.match(hostProblem(view({ status: 'offline', streaming: false }))!, /studio이\(가\) 오프라인입니다/);
  assert.equal(hostState(view({ streaming: false })), 'loading');
  assert.equal(hostState(view({ features: ['read'] })), 'read-only');
  assert.match(hostProblem(view({ features: ['read'] }))!, /업데이트하면 작업을 보낼 수 있습니다/);
  assert.equal(hostState(view({ status: 'update-required', streaming: false })), 'update-required');
  assert.equal(hostState(view({ status: 'removed-by-node', streaming: false })), 'removed-by-node');
  assert.match(hostProblem(view({ status: 'removed-by-node', streaming: false }))!, /새 명령이 필요합니다/);
  assert.equal(view({ status: 'offline', streaming: false }, false).known, false);
});

test('files and terminals of a joined computer open while it is connected and runs a Tower that serves them', () => {
  const view = (node: Partial<RemoteNode>) => combinedView(snapshot([], { nodes: [remote(B, 'studio', { features: ['read', 'work', 'workspace'], ...node })] }), new Map([[B, snapshot([])]])).hosts;
  const [here, ready] = view({});
  assert.equal(here.workspace, true);
  assert.equal(ready.workspace, true);
  assert.equal(workspaceNote(ready), undefined);
  assert.equal(view({ features: ['workspace'], streaming: false })[1].workspace, true, 'a computer whose worker is away still serves its files');
  const old = view({ features: ['read', 'work'] })[1];
  assert.equal(old.workspace, false);
  assert.match(workspaceNote(old)!, /studio의 Tower를 업데이트하면 파일과 터미널을/);
  const away = view({ status: 'offline', streaming: false })[1];
  assert.equal(away.workspace, false);
  assert.equal(workspaceNote(away), undefined, 'an offline computer is explained by its state, not by an update');
});

test('until this Tower has read its joined computers, the page treats the list as incomplete', () => {
  assert.equal(combinedView(snapshot([]), new Map()).complete, false, 'a snapshot without the list of computers');
  assert.equal(combinedView(snapshot([], { nodes: [] }), new Map()).complete, true);
});
