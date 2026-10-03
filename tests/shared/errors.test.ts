import test from 'node:test';
import assert from 'node:assert/strict';
import { fromStatus, invalid, isKind, isTyped, kindOf, STATUS, statusOf, TowerError, type ErrorKind } from '../../shared/errors.js';
import { sourceFiles } from '../helpers/source-scan.js';

test('STATUS names one status per kind and one kind per status, for every code Tower answers with', () => {
  const statuses = Object.values(STATUS);
  assert.equal(new Set(statuses).size, statuses.length);
  assert.deepEqual([...statuses].sort((a, b) => a - b), [400, 401, 403, 404, 409, 410, 413, 415, 422, 423, 429, 500, 502, 503, 507]);
  for (const kind of Object.keys(STATUS) as ErrorKind[]) {
    const error = new TowerError(kind, 'm');
    assert.equal(statusOf(error), STATUS[kind]);
    assert.equal(fromStatus(STATUS[kind], 'm').kind, kind, 'fromStatus inverts statusOf');
    assert.equal(statusOf(fromStatus(STATUS[kind], 'm')), STATUS[kind]);
    assert.equal(kindOf(error), kind);
  }
});

test('a status no kind names is relayed as it came, whatever its value', () => {
  for (const status of [599, 0, null, undefined, Number.NaN, '404', 418]) {
    const error = fromStatus(status, 'relayed');
    assert.equal(error.kind, 'upstream');
    assert.ok(Object.is(statusOf(error), status), String(status));
  }
  assert.equal(kindOf(fromStatus(599, 'x')), 'upstream', 'a relayed status counts as a status');
  assert.equal(kindOf(fromStatus(0, 'x')), undefined, 'an empty relayed status counts as none');
  assert.equal(kindOf(fromStatus(null, 'x')), undefined);
});

test('another error\'s statusCode is read as before; a plain error has no kind', () => {
  const plain = (statusCode: unknown) => Object.assign(new Error('x'), { statusCode });
  assert.equal(statusOf(plain(404)), 404);
  assert.equal(statusOf(plain(599)), 599);
  assert.equal(statusOf(plain('0')), '0');
  assert.equal(statusOf(new Error('x')), undefined);
  assert.equal(kindOf(plain(404)), 'not-found');
  assert.equal(kindOf(plain(599)), 'upstream', 'unmapped but present');
  assert.equal(kindOf(plain('0')), 'upstream', 'a non-empty string is present');
  for (const empty of [0, Number.NaN, undefined, null, '']) assert.equal(kindOf(plain(empty)), undefined, String(empty));
  assert.equal(kindOf(new Error('x')), undefined);
  assert.equal(kindOf('text'), undefined);
  assert.equal(isKind(plain(507), 'storage-full'), true);
  assert.equal(isKind(plain('507'), 'storage-full'), false, 'only the number names a kind');
  assert.throws(() => statusOf(null), TypeError, 'like the reads it replaces');
  assert.throws(() => kindOf(undefined), TypeError);
  assert.equal(isTyped(invalid('x')), true);
  assert.equal(isTyped(plain(0)), true, 'a statusCode key, whatever its value');
  assert.equal(isTyped(new Error('x')), false);
  assert.equal(isTyped(null), false);
});

test('a TowerError is an Error with only what it was given', () => {
  const error = new TowerError('conflict', 'busy');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'Error');
  assert.equal(String(error), 'Error: busy');
  assert.deepEqual(Object.keys(error), ['kind'], 'no statusCode, disposition or relayed status unless given');
  assert.equal('disposition' in error, false);
  const carried = new TowerError('unavailable', 'later', { disposition: 'not-admitted', cause: error });
  assert.equal(carried.disposition, 'not-admitted');
  assert.equal(carried.cause, error);
  assert.deepEqual(Object.keys(carried).sort(), ['disposition', 'kind']);
});

test('every status still written as a number in Tower\'s code has a kind', async () => {
  const known = new Set(Object.values(STATUS));
  const found: string[] = [];
  for (const [path, text] of await sourceFiles(['server', 'shared'])) {
    for (const match of text.matchAll(/(?:statusCode: |httpError\(|fromStatus\()(\d{3})\b/g)) if (!known.has(Number(match[1]))) found.push(`${path} ${match[0]}`);
  }
  assert.deepEqual(found, []);
});
