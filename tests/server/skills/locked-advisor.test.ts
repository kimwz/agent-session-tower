import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, Session } from '../../../shared/types.js';
import { SkillService } from '../../../server/skills/service.js';
import { blockQuarantine, captureErrors } from '../../helpers/quarantine.js';
import { until } from '../../helpers/until.ts';

/**
 * A skill store locked because its state could not be read or moved aside: the automatic advisor of the production
 * composition (advise on) must not read the owner's history, ask the model or change the store's call counter or state,
 * and its background pass must not leave a rejected promise behind.
 */
const ORIGINAL = '{ "version": 1, "reflected": not json';
const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

/**
 * Removes a fixture's folder at the end of its test, whatever point the test stopped at: registered as soon as the folder
 * exists, it first stops the service the fixture made (if it got that far), waits until no advisor pass is in flight and
 * its writes are done, then removes exactly that folder.
 */
function fixtureRoot(t: test.TestContext, root: string) {
  let service: SkillService | undefined;
  t.after(async () => {
    if (service) {
      const running = service;
      running.close();
      await until(() => !(running as unknown as { advisor: { inFlight(): boolean } }).advisor.inFlight(), 5_000);
      await running.flush();
    }
    await rm(root, { recursive: true, force: true });
  });
  return { own: (made: SkillService) => { service = made; return made; } };
}

async function lockedAdvisor(t: test.TestContext, requestText: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-locked-advisor-')));
  const owned = fixtureRoot(t, root);
  const home = join(root, 'home'), project = join(home, 'work', 'shop'), stateDir = join(root, 'state');
  await mkdir(project, { recursive: true }); await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, 'skills.json');
  await writeFile(file, ORIGINAL, { mode: 0o600 });
  // The worker starts now; the owner asks something a minute later and the session is then quiet for over ten minutes,
  // which is when the advisor looks (its clock is moved to then).
  const started = Date.now(), later = started + 30 * 60_000;
  const session: Session = { id: 'claude:owner', nativeId: 'owner', provider: 'claude', title: 'Owner work', cwd: project, project: 'shop', status: 'completed', statusReason: '',
    createdAt: minutesAgo(started, 120), updatedAt: minutesAgo(later, 25), lastRequestAt: minutesAgo(later, 29), lastMessage: '', messageCount: 2, isSubagent: false, resumable: true };
  const histories: string[] = [], models: string[] = [];
  const messages: ChatMessage[] = [{ id: 'u', role: 'user', text: requestText, timestamp: minutesAgo(later, 29) }, { id: 'a', role: 'assistant', text: 'Done.', timestamp: minutesAgo(later, 26) }];
  const blocked = await blockQuarantine(t, file);
  captureErrors(t, file);
  const service = owned.own(new SkillService({
    stateDir, homes: { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'), trash: join(stateDir, 'trash'), store: join(stateDir, 'skills'), journal: join(stateDir, 'skills-moves.json') },
    sessions: () => [session], runs: () => [], history: async item => { histories.push(item.id); return messages; },
    model: async request => { models.push(request.prompt); throw new Error('the fixture model is never answered'); },
    // As the worker composes it on the owner's own state folder.
    advise: true,
  }));
  await service.start();
  blocked.release();
  const internals = service as unknown as { state: { locked?: string; get(): { startedAt: string; calls: { day: string; count: number } } }; advisor: { tick(): Promise<void>; inFlight(): boolean; due(): Session[]; deps: { now?: () => number } } };
  assert.ok(internals.state.locked, 'the store is locked');
  internals.advisor.deps.now = () => later;
  assert.deepEqual(internals.advisor.due().map(item => item.id), [session.id], 'the session is due, as it would be in the worker');
  return { service, file, histories, models, internals, calls: () => structuredClone(internals.state.get().calls) };
}

for (const [label, text] of [['a short request', 'Fix it.'], ['a request long enough to be read by the model', 'Design it first, have Codex review the design, then implement and cross review.']] as const) {
  test(`a locked skill store's advisor reads nothing, asks nothing and changes nothing (${label})`, async t => {
    const f = await lockedAdvisor(t, text);
    const before = f.calls();
    // Two passes: a second model failure is the other path that writes the store.
    await f.internals.advisor.tick();
    await f.internals.advisor.tick();
    assert.deepEqual(f.histories, [], 'no owner history is read');
    assert.deepEqual(f.models, [], 'the model is never asked');
    assert.deepEqual(f.calls(), before, 'the daily call counter is unchanged');
    assert.equal(await readFile(f.file, 'utf8'), ORIGINAL);
  });
}

test('the advisor timer of a locked skill store leaves no rejected pass behind', async t => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });
  // Only the advisor's interval is driven by the test; every other timer runs as usual.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await lockedAdvisor(t, 'Fix it.');
  t.mock.timers.tick(2 * 60_000);
  t.mock.timers.tick(2 * 60_000);
  // Each pass the timer started has finished, and any rejection had its turn to surface.
  await until(() => !f.internals.advisor.inFlight(), 5_000);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.deepEqual(f.histories, []);
  assert.deepEqual(f.models, []);
  assert.equal(await readFile(f.file, 'utf8'), ORIGINAL);
});

test('an advisor pass the timer started that fails is logged, not left unhandled', async t => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('unhandledRejection', onUnhandled); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tower-advisor-failing-pass-')));
  const owned = fixtureRoot(t, root);
  const home = join(root, 'home'), project = join(home, 'work', 'shop'), stateDir = join(root, 'state');
  await mkdir(project, { recursive: true });
  const started = Date.now(), later = started + 30 * 60_000;
  const session: Session = { id: 'claude:owner', nativeId: 'owner', provider: 'claude', title: 'Owner work', cwd: project, project: 'shop', status: 'completed', statusReason: '',
    createdAt: minutesAgo(started, 120), updatedAt: minutesAgo(later, 25), lastRequestAt: minutesAgo(later, 29), lastMessage: '', messageCount: 2, isSubagent: false, resumable: true };
  const service = owned.own(new SkillService({
    stateDir, homes: { home, agentsHome: join(home, '.agents'), claudeHome: join(home, '.claude'), codexHome: join(home, '.codex'), trash: join(stateDir, 'trash'), store: join(stateDir, 'skills'), journal: join(stateDir, 'skills-moves.json') },
    sessions: () => [session], runs: () => [], history: async () => [{ id: 'u', role: 'user', text: 'Fix it.', timestamp: minutesAgo(later, 29) }],
    model: async () => { throw new Error('not asked for a short request'); }, advise: true,
  }));
  await service.start();
  const internals = service as unknown as { state: { locked?: string }; advisor: { inFlight(): boolean; deps: { now?: () => number } } };
  assert.equal(internals.state.locked, undefined, 'an unlocked store whose next save fails');
  internals.advisor.deps.now = () => later;
  // The store's next save cannot replace skills.json: the pass rejects from state.update.
  await rm(join(stateDir, 'skills.json'));
  await mkdir(join(stateDir, 'skills.json', 'blocked'), { recursive: true });
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  t.mock.timers.tick(2 * 60_000);
  await until(() => !internals.advisor.inFlight() && logged.length > 0, 5_000);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.match(String(logged[0][0]), /^The skill advisor's pass failed: /);
  await rm(join(stateDir, 'skills.json'), { recursive: true, force: true });
});
