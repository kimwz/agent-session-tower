import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { arch, release } from 'node:os';
import { testedInput } from './ci-input.mjs';
import { checksReceipt, plan } from './ci-plan.mjs';
import { slowTests } from './test-durations.mjs';

const action = process.argv[2], id = process.argv[3];
const lane = id === 'checks' ? { id, os: 'ubuntu-latest', node: '26.0.0', major: '26', sea: false } : plan().find(l => l.id === id);
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
  for (const name of ['home', 'codex', 'claude', 'config', 'cache', 'state', 'data', 'runtime', 'npm', 'reports', 'fixture-builds']) mkdirSync(join(root, name), { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    XDG_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    npm_config_cache: join(root, 'npm'), TOWER_AUTO_UPDATE: '0', TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1',
    NODE_OPTIONS: '--max-old-space-size=4096', SQLITE_VALIDATION_CI: '1', VALIDATION_ROOT: root,
    TOWER_FIXTURE_COMPILE_CACHE: join(root, 'fixture-builds') };
  const setup = { admitted: Date.now(), env, sha: process.env.GITHUB_SHA, id };
  setup.input = testedInput('.', false);
  const pathNode = spawnSync('node', ['-p', 'process.versions.node'], { env, encoding: 'utf8' });
  assert.equal(pathNode.status, 0); assert.equal(pathNode.stdout.trim(), lane.node, 'child PATH must use the lane Node');
  await run('npm', ['ci', '--foreground-scripts', '--no-audit', '--no-fund'], env);
  if (process.platform === 'darwin') createRequire(resolve('package.json'))('node-pty');
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
    admitted: setup.admitted, ready: setup.ready, started: Date.now(), sea: false, foundation: false, exit: 1 };
  // Every test's duration, beside the TAP log; the receipt carries the tests of a second or more (reporting only).
  const durations = join(env.VALIDATION_ROOT, 'reports', 'test-durations.jsonl');
  try {
    await run(process.execPath, ['--import', 'tsx', 'scripts/sqlite-runtime-check.mjs'], env);
    if (lane.major === '24') await run(process.execPath, ['--import', 'tsx', '-e', "import('./server/tower-tools/read-db.ts').then(m=>{if(!m.lookupsSupported())throw new Error('SQLite authorizer unavailable')})"], env);
    try {
      await run(process.execPath, ['--import', 'tsx', '--test', process.platform === 'darwin' ? '--test-concurrency=2' : '--test-concurrency=4',
        '--test-reporter=tap', '--test-reporter-destination=stdout',
        `--test-reporter=${resolve('scripts/test-durations.mjs')}`, `--test-reporter-destination=${durations}`, ...lane.files], env);
    } finally {
      try { receipt.slow = slowTests(durations); } catch (error) { console.warn(`Test durations unreadable: ${error.message}`); }
    }
    if (lane.foundation) await run(process.execPath, ['--import', 'tsx', 'scripts/sqlite-foundation-benchmark.mjs', '20'], env);
    receipt.foundation = lane.foundation;
    if (lane.sea) {
      await run(process.execPath, ['scripts/test-executable.mjs'], env);
      receipt.sea = true;
    }
    receipt.exit = 0;
  } finally {
    try { if (setup.input) assert.deepEqual(testedInput(), setup.input, 'source changed during tests'); }
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
  // The quick suite (gates, release scripts, app identity) is all the testing a quick change gets of its own.
  await run('npm', ['run', 'test:quick'], env);
  writeFileSync(join(jobDir, 'receipt.json'), JSON.stringify(checksReceipt({ ...setup, id }, started, Date.now())));
} else throw new Error('usage: ci-run.mjs prepare|test|checks <lane>');
