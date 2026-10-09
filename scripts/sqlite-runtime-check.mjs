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
  const legacy = process.argv[2] === 'legacy-loader';
  const sdk = legacy ? undefined : await preflightStorage({ bundle: await captureStorageBundle() });
  console.log(JSON.stringify({ runtime, capability: verdict, sdk, sourceSHA: process.env.VALIDATION_SHA, mode: legacy ? 'legacy-loader-compatibility' : 'supported-floor' }));
  if (legacy) {
    await import('../server/storage/index.ts');
    assert.equal(runtime.node, '22.13.0');
    assert.equal(verdict.supported, false, 'legacy compatibility is not supported SQLite');
  } else {
    assert.equal(verdict.supported, true, JSON.stringify(verdict));
    assert.equal(sdk.supported, true, JSON.stringify(sdk));
  }
} finally {
  database?.close();
}
