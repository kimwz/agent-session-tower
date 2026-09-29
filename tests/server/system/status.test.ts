import test from 'node:test';
import assert from 'node:assert/strict';
import type { CpuInfo } from 'node:os';
import { macMemoryUsed, SystemMonitor, type SystemSources } from '../../../server/system/status.js';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    75296.
Pages active:                                 348790.
Pages inactive:                               356033.
Pages speculative:                             39327.
Pages wired down:                             136151.
Pages purgeable:                                3340.
Anonymous pages:                              373555.
Pages stored in compressor:                   282510.
Pages occupied by compressor:                  58011.
`;

test('a Mac counts memory in use as Activity Monitor does, not only the never-used pages as free', () => {
  assert.equal(macMemoryUsed(VM_STAT), (373555 - 3340 + 136151 + 58011) * 16384);
  assert.equal(macMemoryUsed('Pages free: 12.'), undefined, 'output it cannot read gives no number');
});

const cpu = (busy: number, idle: number): Pick<CpuInfo, 'times'> => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
function fake() {
  const state = { cores: [cpu(0, 0), cpu(0, 0)], now: 0, used: 8 * 1024 ** 3, free: 60 * 1024 ** 3, load: [1.5, 1, 0.5], memoryFails: false };
  const sources: SystemSources = {
    cpus: () => state.cores, loadavg: () => state.load, now: () => state.now,
    memory: async () => { if (state.memoryFails) throw new Error('no memory'); return { total: 16 * 1024 ** 3, used: state.used }; },
    disk: async () => ({ total: 100 * 1024 ** 3, free: state.free }),
  };
  return { state, sources };
}

test('CPU is the busy share of all cores between two samples, and absent on the first', async () => {
  const { state, sources } = fake();
  const monitor = new SystemMonitor(sources, () => {});
  await monitor.sample();
  assert.equal(monitor.status()?.cpu, undefined);
  assert.deepEqual(monitor.status()?.memory, { total: 16 * 1024 ** 3, used: 8 * 1024 ** 3 });
  assert.deepEqual(monitor.status()?.disk, { total: 100 * 1024 ** 3, free: 60 * 1024 ** 3 });
  assert.deepEqual(monitor.status()?.load, [1.5, 1, 0.5]);
  assert.equal(monitor.status()?.cores, 2);
  state.cores = [cpu(300, 100), cpu(100, 300)];
  state.now = 10_000;
  await monitor.sample();
  assert.equal(monitor.status()?.cpu, 50);
  assert.equal(monitor.status()?.sampledAt, new Date(10_000).toISOString());
});

test('a new sample is announced when a shown percentage moves, or once a minute so its details stay current', async () => {
  const { state, sources } = fake();
  let announced = 0;
  const monitor = new SystemMonitor(sources, () => { announced++; });
  await monitor.sample();
  assert.equal(announced, 1, 'the first sample is news');
  state.now = 10_000;
  state.cores = [cpu(100, 100), cpu(100, 100)];
  state.used += 1024 ** 2; // well under one percent of 16 GB
  await monitor.sample();
  assert.equal(announced, 2, 'CPU appears on the second sample');
  state.now = 20_000;
  state.cores = [cpu(200, 200), cpu(200, 200)]; // still 50% busy
  state.used += 1024 ** 2;
  await monitor.sample();
  assert.equal(announced, 2, 'an unchanged picture is not sent again at once');
  state.now = 30_000;
  state.used += 2 * 1024 ** 3;
  await monitor.sample();
  assert.equal(announced, 3, 'memory moving from 50% to 63% is sent');
  state.now = 90_000;
  await monitor.sample();
  assert.equal(announced, 4, 'a minute after the last one, the same percentages are sent with their new details');
});

test('a sample that fails keeps the last one', async () => {
  const { state, sources } = fake();
  let announced = 0;
  const monitor = new SystemMonitor(sources, () => { announced++; });
  await monitor.sample();
  const before = monitor.status();
  state.memoryFails = true;
  state.now = 90_000;
  await monitor.sample();
  assert.equal(monitor.status(), before);
  assert.equal(announced, 1);
});
