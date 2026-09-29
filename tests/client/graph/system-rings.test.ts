import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { HostNode, type HostData } from '../../../client/src/graph/GraphNodes.js';
import { gigabytes, ringLevel, systemRings } from '../../../client/src/graph/system-rings.js';
import type { SystemStatus } from '../../../shared/types.js';

const GB = 1024 ** 3;
const status = (patch: Partial<SystemStatus> = {}): SystemStatus => ({ cpu: 36.4, cores: 10, load: [4, 4.1, 4.4],
  memory: { total: 16 * GB, used: 9 * GB }, disk: { total: 228 * GB, free: 73 * GB }, sampledAt: '2026-09-29T00:00:00.000Z', ...patch });

test('three rings, C R D, carry whole percentages and turn amber at 75% and red at 90%', () => {
  assert.deepEqual(systemRings(status()).map(ring => [ring.letter, ring.percent, ring.level]), [['C', 36, 'normal'], ['R', 56, 'normal'], ['D', 68, 'normal']]);
  assert.deepEqual(systemRings(status({ cpu: 95, memory: { total: 16 * GB, used: 12 * GB } })).map(ring => ring.level), ['critical', 'high', 'normal']);
  assert.equal(ringLevel(74.9), 'normal');
  assert.equal(ringLevel(undefined), 'normal');
});

test('a ring without a number yet is still drawn, empty', () => {
  const [cpu, , disk] = systemRings(status({ cpu: undefined, disk: undefined }));
  assert.equal(cpu!.percent, undefined);
  assert.equal(disk!.percent, undefined);
});

test('sizes read in GB, with a decimal only below 100 GB', () => {
  assert.equal(gigabytes(73.24 * GB), '73.2');
  assert.equal(gigabytes(155.4 * GB), '155');
});

const host = (patch: Partial<HostData>) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(HostNode as unknown as FunctionComponent<{ id: string; data: HostData }>, { id: 'host', data: { name: 'studio', active: 0, providers: [], disabled: false, onAutoPrompt() {}, version: '1.79.0', ...patch } })));

test('the host node shows the rings under its version, summarised for screen readers', () => {
  const markup = host({ system: status() });
  assert.match(markup, /aria-label="컴퓨터 상태: CPU 36%, 메모리 56%, 디스크 68%"/);
  assert.ok(markup.indexOf('v1.79.0') < markup.indexOf('system-rings'), 'rings follow the version line');
  assert.deepEqual([...markup.matchAll(/<b>([CRD])<\/b>/g)].map(match => match[1]), ['C', 'R', 'D']);
  assert.doesNotMatch(host({}), /system-rings/, 'no numbers, no rings');
  assert.doesNotMatch(host({ system: status(), link: { status: 'offline', live: false } }), /system-rings/, 'a computer out of reach shows none');
});
