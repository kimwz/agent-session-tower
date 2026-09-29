import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxCpuTimes, macMemoryUsed, SystemMonitor, type CpuTimes, type SystemSources } from '../../../server/system/status.js';
import { systemPercents } from '../../../shared/system-status.js';

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

test('Linux CPU counts iowait as waiting and softirq and steal as time, which os.cpus() leaves out', () => {
  // user nice system idle iowait irq softirq steal guest guest_nice
  const stat = 'cpu  100 0 0 0 900 0 0 0 0 0\ncpu0 100 0 0 0 900 0 0 0 0 0\nintr 1\n';
  assert.deepEqual(linuxCpuTimes(stat, 1), { source: 'proc', cores: 1, idle: 900, total: 1000 }, '1 s running and 9 s on the disk is 10% busy, not 100%');
  assert.deepEqual(linuxCpuTimes('cpu  100 0 0 100 0 0 800 0\n', 4), { source: 'proc', cores: 4, idle: 100, total: 1000 }, 'softirq is busy time');
  assert.equal(linuxCpuTimes('intr 1\n', 1), undefined);
});

/** Cumulative CPU time of `cores` cores at the given busy and idle totals. */
const cpu = (busy: number, idle: number, cores = 2, source: CpuTimes['source'] = 'os'): CpuTimes => ({ source, cores, idle, total: busy + idle });
function fake() {
  const state = { cpu: cpu(0, 0), now: 0, used: 8 * 1024 ** 3, free: 60 * 1024 ** 3, load: [1.5, 1, 0.5], memoryFails: false };
  const sources: SystemSources = {
    cpuTimes: async () => state.cpu, loadavg: () => state.load, now: () => state.now,
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
  state.cpu = cpu(400, 400);
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
  state.cpu = cpu(200, 200);
  state.used += 1024 ** 2; // well under one percent of 16 GB
  await monitor.sample();
  assert.equal(announced, 2, 'CPU appears on the second sample');
  state.now = 20_000;
  state.cpu = cpu(400, 400); // still 50% busy
  state.used += 1024 ** 2;
  await monitor.sample();
  assert.equal(announced, 2, 'an unchanged picture is not sent again at once');
  state.now = 30_000;
  state.cpu = cpu(600, 600);
  state.used += 2 * 1024 ** 3;
  await monitor.sample();
  assert.equal(announced, 3, 'memory moving from 50% to 63% is sent');
  assert.deepEqual(systemPercents(monitor.status()!), { cpu: 50, memory: 63, disk: 40 });
  state.now = 90_000;
  state.cpu = cpu(800, 800);
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

test('CPU starts over when the counter changes, rather than subtracting ticks from milliseconds', async () => {
  const { state, sources } = fake();
  const monitor = new SystemMonitor(sources, () => {});
  await monitor.sample();
  state.cpu = cpu(10, 10, 2, 'proc');
  await monitor.sample();
  assert.equal(monitor.status()?.cpu, undefined);
  state.cpu = cpu(20, 20, 2, 'proc');
  await monitor.sample();
  assert.equal(monitor.status()?.cpu, 50);
});

test('CPU starts over when the number of cores changes, rather than subtracting different cores', async () => {
  const { state, sources } = fake();
  const monitor = new SystemMonitor(sources, () => {});
  await monitor.sample();
  state.cpu = cpu(900, 100, 3);
  await monitor.sample();
  assert.equal(monitor.status()?.cpu, undefined);
  assert.equal(monitor.status()?.cores, 3);
  state.cpu = cpu(1000, 200, 3);
  await monitor.sample();
  assert.equal(monitor.status()?.cpu, 50);
});

test('nothing is announced once the monitor is closed, even by a sample already under way', async () => {
  const { sources } = fake();
  let announced = 0;
  let release!: () => void;
  const slow: SystemSources = { ...sources, memory: () => new Promise(resolve => { release = () => resolve({ total: 16, used: 8 }); }) };
  const monitor = new SystemMonitor(slow, () => { announced++; });
  const sampling = monitor.sample();
  monitor.close();
  release();
  await sampling;
  assert.equal(announced, 0);
});

test('a total of zero gives no percentage instead of 0%', () => {
  assert.deepEqual(systemPercents({ cores: 1, load: [0, 0, 0], memory: { total: 0, used: 0 }, disk: { total: 0, free: 0 }, sampledAt: '2026-09-29T00:00:00.000Z' }), {});
});
