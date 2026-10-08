import assert from 'node:assert/strict';
import { evaluateRuntime } from '../server/storage/runtime.ts';

// Identity only; the existing file-backed StorageClient tests are the product gate.
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
  console.log(JSON.stringify({ runtime, capability: verdict, mode: legacy ? 'legacy-loader-compatibility' : 'supported-floor' }));
  if (legacy) {
    await import('../server/storage/index.ts');
    assert.equal(runtime.node, '22.13.0');
    assert.equal(verdict.supported, false, 'legacy compatibility is not supported SQLite');
  } else {
    assert.equal(verdict.supported, true, JSON.stringify(verdict));
  }
} finally {
  database?.close();
}
