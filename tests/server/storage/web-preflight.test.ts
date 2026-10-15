import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoragePreflight } from '../../../server/storage/preflight.js';
import { webStorageCheck, type WebStorageRefusal } from '../../../server/storage/web-preflight.js';

const refused = (phase: NonNullable<StoragePreflight['refusal']>['phase'], code: NonNullable<StoragePreflight['refusal']>['code']): StoragePreflight =>
  ({ supported: false, refusal: { phase, code, message: code } });

/** A check answering `answers` in turn (a function throws), with how many times it ran and what it reported. */
function scripted(answers: (StoragePreflight | (() => never))[]) {
  let calls = 0;
  const reports: WebStorageRefusal[] = [];
  const ask = webStorageCheck(async () => { const answer = answers[Math.min(calls++, answers.length - 1)]!; return typeof answer === 'function' ? answer() : answer; }, refusal => reports.push(refusal));
  return { ask, calls: () => calls, reports };
}

test('a pass and a deterministic refusal are checked once; concurrent asks share that check', async () => {
  const passed = scripted([{ supported: true }]);
  assert.deepEqual(await Promise.all([passed.ask(), passed.ask()]), [undefined, undefined]);
  assert.equal(await passed.ask(), undefined);
  assert.equal(passed.calls(), 1);
  for (const preflight of [refused('runtime', 'unsupported-runtime'), refused('handshake', 'source-hash-mismatch'), refused('bundle', 'bundle-hash-mismatch'), refused('runtime', 'pragma-mismatch')]) {
    const check = scripted([preflight, { supported: true }]);
    assert.equal((await check.ask())?.code, preflight.refusal!.code);
    assert.equal((await check.ask())?.code, preflight.refusal!.code, `${preflight.refusal!.code} is kept`);
    assert.equal(check.calls(), 1);
    assert.deepEqual(check.reports.map(report => report.code), [preflight.refusal!.code]);
  }
});

test('a transient refusal or a check that threw is answered, then checked again on the next ask', async () => {
  for (const first of [refused('handshake', 'handshake-timeout'), refused('handshake', 'thread-start-failed'), refused('deadline', 'deadline-exceeded'), refused('thread-exit', 'thread-exited'),
    () => { throw new Error('bundle read failed'); }]) {
    const check = scripted([first, { supported: true }, refused('runtime', 'unsupported-runtime')]);
    assert.ok(await check.ask(), 'the transient refusal is answered');
    assert.equal(await check.ask(), undefined, 'the next ask checks again and passes');
    assert.equal(await check.ask(), undefined, 'the pass is kept');
    assert.equal(check.calls(), 2);
  }
  const thrown = scripted([() => { throw new Error('bundle read failed'); }]);
  assert.deepEqual(await thrown.ask(), { code: 'runtime-unsupported', message: 'bundle read failed' });
});
