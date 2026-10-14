import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { testedInput } from './ci-input.mjs';
import { plan, offlineFile } from './ci-plan.mjs';

const action = process.argv[2], id = process.argv[3];
const lane = id === 'checks' ? { id, os: 'ubuntu-latest', node: '26.0.0', major: '26', large: false, sea: false } : plan().find(l => l.id === id);
const jobDir = resolve(process.env.RUNNER_TEMP ?? 'tmp', `ci-${id}`);
const meta = join(jobDir, 'setup.json');
const run = (cmd, args, env) => new Promise((accept, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.once('error', reject); child.once('close', code => code === 0 ? accept() : reject(new Error(`${cmd} exited ${code}`)));
});
if (action === 'prepare') {
  assert.ok(lane, 'unknown lane');
  assert.equal(process.versions.node, lane.node, 'prepare toolchain must match');
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const root = realpathSync(mkdtempSync(join(jobDir, 'private-')));
  const tmp = realpathSync(mkdtempSync('/tmp/tci-'));
  writeFileSync(join(jobDir, 'tmpdir'), tmp); // lets ci-local-mac.mjs remove it even if prepare fails
  for (const name of ['home', 'codex', 'claude', 'config', 'cache', 'state', 'data', 'runtime', 'npm', 'reports', 'fixture-builds']) mkdirSync(join(root, name), { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    XDG_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    npm_config_cache: join(root, 'npm'), TOWER_AUTO_UPDATE: '0', TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1',
    NODE_OPTIONS: '--max-old-space-size=4096', SQLITE_VALIDATION_CI: '1', VALIDATION_ROOT: root,
    TOWER_SQLITE_OLD122_ROOT: join(root, 'old122'), TOWER_SQLITE_OLD124_ROOT: join(root, 'old124'),
    TOWER_FIXTURE_COMPILE_CACHE: join(root, 'fixture-builds'), SQLITE_RETENTION_LARGE: lane.large ? '1' : '0' };
  const setup = { admitted: Date.now(), env, sha: process.env.GITHUB_SHA, id };
  setup.input = testedInput('.', false);
  const pathNode = spawnSync('node', ['-p', 'process.versions.node'], { env, encoding: 'utf8' });
  assert.equal(pathNode.status, 0); assert.equal(pathNode.stdout.trim(), lane.node, 'child PATH must use the lane Node');
  await run('npm', ['ci', '--foreground-scripts', '--no-audit', '--no-fund'], env);
  if (process.platform === 'darwin') createRequire(resolve('package.json'))('node-pty');
  if (id !== 'checks') {
    await run(process.execPath, ['scripts/sqlite-old124-capture.mjs', '1.122.0'], env);
    await run(process.execPath, ['scripts/sqlite-old124-capture.mjs', '1.124.0'], env);
  }
  if (lane.sea) await run('npm', ['run', 'build:executable'], env);
  if (lane.os === 'ubuntu-latest') await run(process.execPath, ['-e', "require('fs').rmSync('node_modules/node-pty',{recursive:true,force:true})"], env);
  setup.built = { lockSHA256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'),
    storageBundleSHA256: createHash('sha256').update(readFileSync('dist/server/storage/generated/thread-bundle.json')).digest('hex'),
    nodeSHA256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'), installCommand: 'npm ci --no-audit --no-fund', installExit: 0 };
  setup.ready = Date.now(); writeFileSync(meta, JSON.stringify(setup));
} else if (action === 'test') {
  assert.ok(lane);
  const setup = JSON.parse(readFileSync(meta, 'utf8')), { env } = setup;
  const pathNode = spawnSync('node', ['-p', 'process.versions.node'], { env, encoding: 'utf8' });
  assert.equal(pathNode.status, 0); assert.equal(pathNode.stdout.trim(), lane.node, 'test child toolchain must match');
  const receipt = { id, sha: setup.sha, node: process.versions.node, platform: process.platform, files: lane.files,
    arch: arch(), system: release(), pathNode: pathNode.stdout.trim(), input: setup.input, built: setup.built,
    large: env.SQLITE_RETENTION_LARGE === '1', admitted: setup.admitted, ready: setup.ready, started: Date.now(),
    sea: false, benchmark: false, foundation: false, exit: 1 };
  try {
    await run(process.execPath, ['--import', 'tsx', 'scripts/sqlite-runtime-check.mjs', 'supported-floor'], env);
    if (lane.major === '24') await run(process.execPath, ['--import', 'tsx', '-e', "import('./server/tower-tools/read-db.ts').then(m=>{if(!m.lookupsSupported())throw new Error('SQLite authorizer unavailable')})"], env);
    await run(process.execPath, ['--import', 'tsx', '--test', process.platform === 'darwin' ? '--test-concurrency=2' : '--test-concurrency=4', '--test-reporter=tap', ...lane.files], env);
    if (lane.files.includes('tests/server/sessions/retention-storage.test.ts')) receipt.cap = JSON.parse(readFileSync(join(env.VALIDATION_ROOT, 'reports', 'canonical-cap.json'), 'utf8'));
    if (lane.foundation) await run(process.execPath, ['--import', 'tsx', 'scripts/sqlite-foundation-benchmark.mjs', '20'], env);
    receipt.foundation = lane.foundation;
    if (lane.benchmark) { await run(process.execPath, ['--import', 'tsx', 'scripts/test-benchmark-retention-storage.ts', join(env.VALIDATION_ROOT, 'reports', 'retention-benchmark.json')], env); receipt.benchmark = true; }
    if (lane.sea) {
      await run(process.execPath, ['scripts/test-executable.mjs'], env);
      await run(resolve('artifacts/agent-session-tower'), ['--storage-contract'], env);
      await run(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-name-pattern=^final actual CLI source and optional Node26 SEA', offlineFile], { ...env, TOWER_SQLITE_FINAL_BINARY: resolve('artifacts/agent-session-tower') });
      const proof = JSON.parse(readFileSync(join(env.VALIDATION_ROOT, 'reports', 'sea-offline-identity.json'), 'utf8'));
    assert.equal(proof.binarySHA256, createHash('sha256').update(readFileSync('artifacts/agent-session-tower')).digest('hex'));
    assert.equal(proof.compiledSourceSHA256, createHash('sha256').update(readFileSync('dist/executable/monitor.mjs')).digest('hex'));
    assert.equal(proof.effectsStarted, false);
    receipt.sea = true;
    }
    receipt.exit = 0;
  } finally {
    try { if (setup.input) assert.deepEqual(testedInput(), setup.input, 'source changed during local tests'); }
    catch (error) { receipt.exit = 1; receipt.sourceError = error.message; }
    receipt.finished = Date.now(); writeFileSync(join(jobDir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    assert.equal(receipt.exit, 0, receipt.sourceError ?? 'test lane failed');
  }
} else if (action === 'checks') {
  const setup = JSON.parse(readFileSync(meta, 'utf8')), { env } = setup;
  const started = Date.now();
  await run('npm', ['run', 'typecheck'], env);
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') await run(process.execPath, ['--import', 'tsx', 'scripts/test-integrity.ts'], env);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  assert.equal(lock.version, version); assert.equal(lock.packages[''].version, version);
  const { APP_VERSION } = await import('../dist/shared/app-identity.js');
  assert.equal(APP_VERSION, version);
  const tag = spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/v${version}`], { env, encoding: 'utf8' });
  if (tag.status === 0) {
    await run('git', ['fetch', '--no-tags', 'origin', `refs/tags/v${version}:refs/tags/v${version}`], env);
    await run('git', ['diff', '--exit-code', `v${version}`, '--', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'shared/app-identity.ts'], env);
  } else if (tag.status === 2) {
    await run(process.execPath, ['scripts/release.mjs', 'prepare'], { ...env, TZ: 'Asia/Seoul' });
    await run('git', ['diff', '--exit-code', '--', 'shared/app-identity.ts'], env);
  } else throw new Error('Cannot determine release tag presence');
  const receipt = { id, sha: setup.sha, input: setup.input, admitted: setup.admitted, ready: setup.ready, started, finished: Date.now(), exit: 1 };
  await run(process.execPath, ['--import', 'tsx', '--test', 'tests/shared/app-identity.test.ts'], env);
  receipt.finished = Date.now(); writeFileSync(join(jobDir, 'receipt.json'), JSON.stringify(receipt));
} else if (action === 'legacy') {
  const setup = JSON.parse(readFileSync(meta, 'utf8')), env = { ...setup.env, PATH: process.env.PATH };
  const receipt = JSON.parse(readFileSync(join(jobDir, 'receipt.json'), 'utf8'));
  try {
    assert.equal(process.versions.node, '22.13.0');
    await run(process.execPath, ['--import', 'tsx', 'scripts/sqlite-runtime-check.mjs', 'legacy-loader'], env);
    await run(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2', 'tests/server/link/storage-update-legacy.test.ts'], env);
    receipt.legacyNode = process.versions.node; receipt.exit = 0;
  } finally { receipt.finished = Date.now(); writeFileSync(join(jobDir, 'receipt.json'), JSON.stringify(receipt)); }
} else throw new Error('usage: ci-run.mjs prepare|test|checks|legacy <lane>');
