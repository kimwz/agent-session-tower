import assert from 'node:assert/strict';
import { evaluateRuntime } from '../server/storage/runtime.ts';
import { captureStorageBundle, preflightStorage } from '../server/storage/index.ts';

// The SDK verdict and captured-thread in-memory probe supplement the file-backed product suite.
const sqlite = process.getBuiltinModule('node:sqlite');
const runtime = {
  node: process.versions.node, platform: process.platform, arch: process.arch,
  execPath: process.execPath,
  apis: { DatabaseSync: typeof sqlite?.DatabaseSync === 'function', StatementSync: typeof sqlite?.StatementSync === 'function' },
};
let database;
try {
  database = new sqlite.DatabaseSync(':memory:');
  runtime.sqlite = database.prepare('SELECT sqlite_version() AS version').get().version;
  const verdict = evaluateRuntime(runtime);
  const sdk = await preflightStorage({ bundle: await captureStorageBundle() });
  console.log(JSON.stringify({ runtime, capability: verdict, sdk, sourceSHA: process.env.VALIDATION_SHA, mode: 'supported-floor' }));
  assert.equal(verdict.supported, true, JSON.stringify(verdict));
  assert.equal(sdk.supported, true, JSON.stringify(sdk));
} finally {
  database?.close();
}
