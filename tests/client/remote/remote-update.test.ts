import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeSummary, UpdateStatus } from '../../../shared/link.js';
import { UpdateLine } from '../../../client/src/remote/RemotePanel.js';
import { combinedView, hostProblem, hostState } from '../../../client/src/remote/hosts.js';

const at = '2026-09-24T00:00:00.000Z';
const node = (extra: Partial<NodeSummary> = {}): NodeSummary => ({ id: 'b'.repeat(32), name: 'studio', fingerprint: 'AAAA-BBBB-CCCC', status: 'connected', version: '1.24.0',
  features: ['read', 'work', 'workspace', 'status', 'update'], pairedAt: at, ...extra });
const update = (extra: Partial<UpdateStatus>): UpdateStatus => ({ version: '1.25.0', previous: '1.24.0', stage: 'installing', startedAt: at, updatedAt: at, ...extra });
const line = (summary: NodeSummary) => renderToStaticMarkup(createElement(UpdateLine, { token: 't', node: summary, version: '1.25.0', busy: false, run: async () => true }));

test('each joined computer says in one line where its update stands, and offers to try again after a failure', () => {
  assert.match(line(node({ report: { versions: { web: '1.24.0' }, service: true, update: update({ stage: 'installing' }) } })), /v1\.25\.0\(으\)로 업데이트: 설치하는 중/);
  assert.match(line(node({ status: 'offline', report: { versions: { web: '1.24.0' }, service: true, update: update({ stage: 'verifying' }) } })), /다시 연결되는지 확인하는 중/);
  const failed = line(node({ report: { versions: { web: '1.24.0' }, service: true, update: update({ stage: 'failed', code: 'link-failed', failedStage: 'verifying' }) } }));
  assert.match(failed, /v1\.24\.0로 계속 실행 중입니다\. 새 버전이 이 컴퓨터에 다시 연결하지 못했습니다\./);
  assert.match(failed, /다시 시도/);
  const stuck = line(node({ status: 'offline', report: { versions: { web: '1.24.0' }, service: true, update: update({ stage: 'failed', code: 'rollback-failed', failedStage: 'verifying' }) } }));
  assert.match(stuck, /이전 버전으로도 돌아가지 못했습니다\. 그 컴퓨터에서 Tower를 확인하세요/);
  assert.doesNotMatch(stuck, /다시 시도/);
  assert.equal(line(node({ version: '1.25.0', report: { versions: { web: '1.25.0' }, service: true, update: update({ stage: 'done' }) } })), '', 'an updated computer needs no line');
  assert.equal(line(node({ version: '1.25.0', report: { versions: { web: '1.25.0' }, service: true, update: update({ stage: 'failed', code: 'start-failed', version: '1.25.0' }) } })), '', 'an old failure for a version it now runs is not shown');
});

test('a computer that cannot follow this Tower says why, and a newer one asks for this Tower to be updated', () => {
  assert.match(line(node({ features: ['read', 'work'] })), /한 번 직접 업데이트하면/);
  assert.match(line(node({ features: ['read', 'work', 'status'] })), /백그라운드 서비스로 실행하지 않아/);
  assert.match(line(node({ version: '1.26.0' })), /이 컴퓨터의 Tower를 업데이트하세요/);
  assert.equal(line(node({ version: '1.25.0' })), '');
  assert.equal(line(node({ status: 'offline', features: [] })), '', 'an offline computer is described by its state');
});

test('a computer restarting into a new version is shown as updating, not offline', () => {
  const view = combinedView({ sessions: [], runs: [], providers: [], scanning: false, hostname: 'here', version: '1.25.0', updatedAt: at,
    nodes: [{ id: 'b'.repeat(32), name: 'studio', status: 'offline', features: [], streaming: false, updating: true }] }, new Map());
  assert.equal(hostState(view.hosts[1]), 'updating');
  assert.match(hostProblem(view.hosts[1])!, /새 버전으로 다시 시작하는 중입니다/);
});
