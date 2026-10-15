import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseRunOptions } from '../../server/cli-options.js';

test('--storage-contract is an unknown option, in the words a 1.125–1.137.x update helper reads as a release without storage contracts', () => {
  for (const args of [['--storage-contract'], ['run', '--storage-contract'], ['--storage-contract', '--no-open']]) {
    assert.throws(() => parseRunOptions(args, '/state'), (error: unknown) => error instanceof Error && error.message.startsWith('Unknown option: --storage-contract'), args.join(' '));
  }
  assert.deepEqual(parseRunOptions(['--storage-contract', '--version'], '/state'), { kind: 'version' }, '--version answers whatever else is asked');
});

test('run options: defaults, every option, help and version first, and a port out of range refused', () => {
  assert.deepEqual(parseRunOptions([], '/state'), { kind: 'run', command: 'run', port: 8000, host: '127.0.0.1', open: true, stateDir: '/state', publicUrls: [] });
  assert.deepEqual(parseRunOptions(['doctor', '--no-open', '--port', '8123', '--host', '0.0.0.0', '--public-url', 'https://a', '--public-url', 'https://b', '--state-dir', 'here'], '/state'),
    { kind: 'run', command: 'doctor', port: 8123, host: '0.0.0.0', open: false, stateDir: resolve('here'), publicUrls: ['https://a', 'https://b'] });
  assert.deepEqual(parseRunOptions(['--bogus', '-h'], '/state'), { kind: 'help' });
  for (const port of ['0', '65536', '1.5', 'x']) assert.throws(() => parseRunOptions(['--port', port], '/state'), /Port must be between 1 and 65535/, port);
  assert.throws(() => parseRunOptions(['--port'], '/state'), /--port requires a number/);
});
