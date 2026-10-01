import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SecretContext, SecretMetadata, SecretOperation, SecretRunInput } from '../../../shared/secrets.js';
import { SecretBroker, maskSecretOutput } from '../../../server/secrets/broker.js';
import { parseSecretCli, runSecretsCommand } from '../../../server/secrets/cli.js';
import { SecretService } from '../../../server/secrets/service.js';
import type { RemoteSecretBroker } from '../../../server/secrets/remote.js';

const canary = 'SYNTHETIC-sensitive-canary-42';
async function fixture() {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'tower-broker-fixture-')));
  const root = join(stateDir, 'project'); await mkdir(root);
  const resources = new Map<string, { metadata: SecretMetadata; bytes: Buffer; fields?: Record<string, string> }>();
  const ledger = new Map<string, { fingerprint: string; state: 'pending' | 'done'; result?: unknown }>();
  let locked = false, resolves = 0;
  const denied = new Set<string>();
  let onResolve: ((count: number) => void) | undefined;
  let onFinish: (() => Promise<void>) | undefined;
  const context: SecretContext = { hostId: 'fixture', sessionId: 'session', taskId: randomUUID(), runId: 'run', root };
  const device = { id: 'fixture', name: 'fixture', signingKey: '', encryptionKey: '', fingerprint: '' };
  let peers: unknown[] = [];
  const service = { checkTask: (ctx: SecretContext, id?: string) => { if (locked || ctx.taskId !== context.taskId || (id && denied.has(`tower-secret://remote/${id}@1`))) throw new Error('Task identity denied'); }, device: () => device, peers: () => peers, status: () => ({ initialized: true, locked }), list: async () => [...resources.values()].map(v => v.metadata), fingerprintKey: () => Buffer.alloc(32, 4),
    resolve: async (_ctx: SecretContext, ref: string, _op: SecretOperation) => {
      resolves++; onResolve?.(resolves); if (locked || denied.has(ref)) throw new Error('private denial detail');
      const resource = resources.get(ref); if (!resource) throw new Error('missing');
      return { ...resource, bytes: Buffer.from(resource.bytes), fields: resource.fields ? { ...resource.fields } : undefined };
    },
    beginOperation: async (_ctx: SecretContext, id: string, fingerprint: string) => {
      if (locked || _ctx.taskId !== context.taskId || _ctx.runId !== context.runId) throw new Error('denied');
      const found = ledger.get(id); if (found) { if (found.fingerprint !== fingerprint) throw new Error('identity conflict'); return { ...found, fresh: false }; }
      const entry = { fingerprint, state: 'pending' as const }; ledger.set(id, entry); return { ...entry, fresh: true };
    },
    finishOperation: async (_ctx: SecretContext, id: string, fingerprint: string, result: unknown) => { await onFinish?.(); ledger.set(id, { fingerprint, state: 'done', result: structuredClone(result) }); },
  } as unknown as SecretService;
  const add = (value: string | Buffer, kind: 'scalar' | 'env' | 'file' = 'scalar', fields?: Record<string, string>) => {
    const id = randomUUID(), reference = `tower-secret://fixture/${id}@1`;
    const metadata: SecretMetadata = { id, name: 'fixture secret', kind, groupId: 'group', version: 1, reference };
    resources.set(reference, { metadata, bytes: Buffer.isBuffer(value) ? value : Buffer.from(value), fields }); return reference;
  };
  return { stateDir, root, context, service, resources, ledger, add, denied, locked: (value: boolean) => { locked = value; }, onResolve: (fn: (n: number) => void) => { onResolve = fn; }, onFinish: (fn: () => Promise<void>) => { onFinish = fn; }, peers: (value: unknown[]) => { peers = value; }, cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}
function command(script: string, extra: Partial<SecretRunInput> = {}): SecretRunInput { return { operationId: randomUUID(), command: process.execPath, args: ['-e', script], ...extra }; }

test('env/stdin/private file deliver only requested values, remove credentials, redact outputs, and clean private paths', async () => {
  const f = await fixture(); const scalar = f.add(canary), file = f.add(canary, 'file');
  const oldCapability = process.env.TOWER_SECRET_CAPABILITY; process.env.TOWER_SECRET_CAPABILITY = 'b'.repeat(64);
  try {
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service });
    const script = `const fs=require('fs'); let input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{const p=process.argv[1];const v=fs.readFileSync(p,'utf8');console.log(JSON.stringify({argv:process.argv.slice(1),env:process.env.TOKEN,input,file:v,mode:fs.statSync(p).mode&511,dirMode:fs.statSync(require('path').dirname(p)).mode&511,credential:process.env.TOWER_SECRET_CAPABILITY??'ABSENT'}));console.error(process.env.TOKEN);});`;
    const input = command(script, { env: { TOKEN: scalar }, stdin: scalar, files: { KEY: file } }); input.args!.push('{secret-file:KEY}');
    const result = await broker.run(f.context, input);
    assert.equal(result.exitCode, 0); assert.equal(result.stdout.includes(canary), false); assert.equal(result.stderr.includes(canary), false);
    const output = JSON.parse(result.stdout); assert.equal(output.env, '[REDACTED]'); assert.equal(output.input, '[REDACTED]'); assert.equal(output.file, '[REDACTED]'); assert.equal(output.credential, 'ABSENT'); assert.equal(output.mode, 0o600); assert.equal(output.dirMode, 0o700);
    assert.equal(output.argv.length, 1); assert.equal(output.argv[0].includes(canary), false); await assert.rejects(readFile(output.argv[0]));
    assert.deepEqual(await readdir(join(f.stateDir, 'secrets', 'consumers')), []);
    assert.equal(JSON.stringify([...f.ledger.values()]).includes(canary), false); assert.equal(broker.inFlight(), false);
  } finally { if (oldCapability === undefined) delete process.env.TOWER_SECRET_CAPABILITY; else process.env.TOWER_SECRET_CAPABILITY = oldCapability; await f.cleanup(); }
});

test('dotenv bundle and empty values work, scalar fields remain redacted and binary encodings are best-effort masked', async () => {
  const f = await fixture();
  try {
    const bundle = f.add(`TOKEN=${canary}\nEMPTY=\n`, 'env', { TOKEN: canary, EMPTY: '' });
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service });
    const result = await broker.run(f.context, command(`console.log(JSON.stringify({token:process.env.TOKEN,empty:process.env.EMPTY}));`, { envBundle: bundle }));
    assert.deepEqual(JSON.parse(result.stdout), { token: '[REDACTED]', empty: '' });
    const binary = Buffer.from([0, 255, 4, 10]);
    assert.equal(maskSecretOutput(`${binary.toString('base64')} ${binary.toString('hex')}`, [binary]), '[REDACTED] [REDACTED]');
    const special = 'secret "quoted" /? value';
    assert.equal(maskSecretOutput(`${special} ${JSON.stringify(special).slice(1, -1)} ${encodeURIComponent(special)}`, [Buffer.from(special)]), '[REDACTED] [REDACTED] [REDACTED]');
  } finally { await f.cleanup(); }
});

test('overflow discards entire captured prefix instead of leaking a partial long secret', async () => {
  const f = await fixture();
  try {
    const ref = f.add(`SENSITIVE-PREFIX-${'x'.repeat(600_000)}`);
    const result = await new SecretBroker({ stateDir: f.stateDir, service: f.service }).run(f.context, command(`process.stdout.write(process.env.TOKEN.slice(0,30));process.stdout.write('y'.repeat(700000));`, { env: { TOKEN: ref } }));
    // Use stdin because very large env values exceed OS limits before spawn.
    const piped = await new SecretBroker({ stateDir: f.stateDir, service: f.service }).run(f.context, command(`process.stdin.resume();process.stdout.write('SENSITIVE-PREFIX-');process.stdout.write('y'.repeat(700000));`, { stdin: ref }));
    assert.equal(piped.stdout, ''); assert.equal(piped.stderr.includes('출력 크기 제한'), true); assert.equal(JSON.stringify(piped).includes('SENSITIVE-PREFIX'), false);
    assert.equal(result.stdout.includes('SENSITIVE-PREFIX'), false);
  } finally { await f.cleanup(); }
});

test('done requests return cached masked results and uncertain requests never execute twice', async () => {
  const f = await fixture();
  try {
    const marker = join(f.root, 'count');
    const input = command(`require('fs').appendFileSync(process.argv[1],'x');console.log('ok');`); input.args!.push(marker);
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service });
    assert.deepEqual(await broker.run(f.context, input), await broker.run(f.context, input)); assert.equal(await readFile(marker, 'utf8'), 'x');
    await assert.rejects(broker.run(f.context, { ...input, command: 'different' }), /identity conflict/);
    const uncertain = command(`require('fs').appendFileSync(process.argv[1],'y');`); uncertain.args!.push(marker);
    const { createHash } = await import('node:crypto');
    f.ledger.set(uncertain.operationId, { fingerprint: createHash('sha256').update(JSON.stringify(uncertain)).digest('hex'), state: 'pending' });
    await assert.rejects(broker.run(f.context, uncertain), /불확실/); assert.equal(await readFile(marker, 'utf8'), 'x');
  } finally { await f.cleanup(); }
});

test('run remains active until finish journal commits, including its failure path', async () => {
  const f = await fixture();
  let finishEntered!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { finishEntered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.onFinish(async () => { finishEntered(); await gate; throw new Error('journal unavailable'); });
  const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service });
  try {
    const pending = broker.run(f.context, command(`console.log('ok')`)); const rejected = assert.rejects(pending, /journal unavailable/);
    await entered; assert.equal(broker.inFlight(), true); release(); await rejected; assert.equal(broker.inFlight(), false);
  } finally { release(); await f.cleanup(); }
});

test('revocation and lock during staging prevent spawn and temp files are still cleaned', async () => {
  for (const reason of ['revoke', 'lock']) {
    const f = await fixture();
    try {
      const ref = f.add(canary, 'file'); const marker = join(f.root, 'executed');
      f.onResolve(count => { if (count === 2) { if (reason === 'revoke') f.denied.add(ref); else f.locked(true); } });
      const input = command(`require('fs').writeFileSync(process.argv[1],'executed')`, { files: { KEY: ref } }); input.args!.push(marker);
      const result = await new SecretBroker({ stateDir: f.stateDir, service: f.service }).run(f.context, input);
      assert.equal(result.exitCode, null); await assert.rejects(readFile(marker)); assert.deepEqual(await readdir(join(f.stateDir, 'secrets', 'consumers')), []);
      assert.equal(JSON.stringify(result).includes('private denial detail'), false);
    } finally { await f.cleanup(); }
  }
});

test('symlinked consumer parent never receives secret bytes', async () => {
  const f = await fixture();
  try {
    const outside = join(f.stateDir, 'outside'); await mkdir(outside); await mkdir(join(f.stateDir, 'secrets')); await symlink(outside, join(f.stateDir, 'secrets', 'consumers'));
    const ref = f.add(canary, 'file');
    const result = await new SecretBroker({ stateDir: f.stateDir, service: f.service }).run(f.context, command(`console.log('should not execute')`, { files: { KEY: ref } }));
    assert.equal(result.exitCode, null); assert.equal(result.stdout, ''); assert.deepEqual(await readdir(outside), []);
  } finally { await f.cleanup(); }
});

test('strict input maps reject forged values, oversized requests and unsupported fields before journaling', async () => {
  const f = await fixture();
  try {
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service });
    for (const extra of [{ env: [] }, { files: 'bad' }, { env: { TOKEN: canary } }, { stdin: false }, { cwd: 1 }, { timeoutMs: '10' }, { extra: true }, { args: ['x'.repeat(40000)] }, { files: { '../escape': f.add('value') } }]) {
      await assert.rejects(broker.run(f.context, command('console.log(1)', extra as unknown as Partial<SecretRunInput>)));
    }
    assert.equal(f.ledger.size, 0);
  } finally { await f.cleanup(); }
});

test('remote Buffer contract works and unavailable source status remains visible per run', async () => {
  const f = await fixture();
  try {
    const sourceId = 'remote', ref = 'tower-secret://remote/secret@1';
    f.peers([{ enabled: true, direction: 'controller', device: { id: sourceId } }]);
    let available = false, corrupt = false;
    const remote = { request: async (_peer: string, _ctx: SecretContext, op: string) => {
      if (!available) throw new Error('private network detail');
      if (op === 'list') return [{ id: 'secret', name: 'remote', version: 1, reference: ref, kind: 'scalar', groupId: 'group', ...(corrupt ? { value: canary } : {}) }];
      return { metadata: { id: 'secret', reference: ref, version: 1 }, bytes: Buffer.from(canary) };
    } } as unknown as RemoteSecretBroker;
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service, remote });
    assert.deepEqual(await broker.list(f.context), []); assert.deepEqual(broker.unavailableSources(f.context), [{ sourceHostId: sourceId, code: 'SECRET_SOURCE_UNAVAILABLE' }]);
    assert.deepEqual(broker.unavailableSources({ ...f.context, runId: 'other' }), []);
    available = true; assert.equal((await broker.list(f.context))[0]!.sourceHostId, sourceId); assert.deepEqual(broker.unavailableSources(f.context), []);
    const result = await broker.run(f.context, command(`console.log(process.env.TOKEN)`, { env: { TOKEN: ref } })); assert.equal(result.stdout.trim(), '[REDACTED]');
    corrupt = true; assert.deepEqual(await broker.list(f.context), []); assert.equal(broker.unavailableSources(f.context).length, 1); assert.equal(JSON.stringify(broker.unavailableSources(f.context)).includes(canary), false);
  } finally { await f.cleanup(); }
});

test('CLI parser accepts references, preserves program --help, and rejects ambiguous bindings', async () => {
  const ref = 'tower-secret://fixture/id@1';
  assert.throws(() => parseSecretCli(['run', '--', process.execPath]), /operation-id/);
  assert.throws(() => parseSecretCli(['pipe', '--secret', ref, '--', process.execPath]), /operation-id/);
  const repeat = ['run', '--operation-id', 'stable-operation', '--', process.execPath, '-e', 'console.log(1)'];
  assert.deepEqual(parseSecretCli(repeat), parseSecretCli(repeat));
  const parsed = parseSecretCli(['pipe', '--secret', ref, '--operation-id', 'op1', '--', process.execPath, '--help']);
  assert.equal(parsed.kind, 'run'); if (parsed.kind === 'run') { assert.equal(parsed.input.stdin, ref); assert.deepEqual(parsed.input.args, ['--help']); }
  for (const argv of [ ['run', '--operation-id', 'op1', '--env', `TOKEN=${ref}`, '--env', `TOKEN=${ref}`, '--', 'node'], ['pipe', '--operation-id', 'op1', '--secret', ref, '--stdin', ref, '--', 'node'], ['run', '--operation-id', 'op1', '--env', `TOKEN=${canary}`, '--', 'node'], ['run', '--operation-id', 'op1', '--timeout-ms', '-1', '--', 'node'] ]) assert.throws(() => parseSecretCli(argv));
});

test('standalone CLI refuses missing/forged capability and never derives auth from cwd or native session env', async () => {
  const previous = { capability: process.env.TOWER_SECRET_CAPABILITY, directory: process.env.TOWER_SECRET_STATE_DIR, thread: process.env.CODEX_THREAD_ID };
  try {
    delete process.env.TOWER_SECRET_CAPABILITY; delete process.env.TOWER_SECRET_STATE_DIR; process.env.CODEX_THREAD_ID = 'native-looking-id';
    await assert.rejects(runSecretsCommand(['list']), /권한이 없습니다/);
    process.env.TOWER_SECRET_CAPABILITY = 'forged-capability'; await assert.rejects(runSecretsCommand(['list']), /권한이 없습니다/);
    process.env.TOWER_SECRET_CAPABILITY = 'a'.repeat(64); await assert.rejects(runSecretsCommand(['list']), /transport 경로/);
  } finally {
    for (const [key, value] of [['TOWER_SECRET_CAPABILITY', previous.capability], ['TOWER_SECRET_STATE_DIR', previous.directory], ['CODEX_THREAD_ID', previous.thread]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('encrypted domain fixture denies forged task and revoked policy through the actual broker', async () => {
  const f = await fixture(); const service = new SecretService({ stateDir: f.stateDir });
  try {
    await service.start(); await service.initialize('fixture-strong-password-42');
    const target = await service.ensureTask('fixture-session', f.root), context = { ...target, runId: 'owner-run' };
    const metadata = await service.create({ name: 'fixture-token', kind: 'scalar', scope: 'global', value: canary, target, connect: true, operations: ['env', 'discover', 'compare', 'fingerprint'] });
    const broker = new SecretBroker({ stateDir: f.stateDir, service });
    await assert.rejects(broker.run({ ...context, taskId: randomUUID() }, command(`console.log('no')`, { env: { TOKEN: metadata.reference } })));
    const used = await broker.run(context, command(`console.log(process.env.TOKEN)`, { env: { TOKEN: metadata.reference } })); assert.equal(used.stdout.trim(), '[REDACTED]');
    const dotenv = await service.create({ name: 'selected-fields', kind: 'env', scope: 'global', value: `TOKEN=${canary}\nPRIVATE=unselected-canary`, target, activation: 'auto', operations: ['env', 'discover'] });
    const rule = service.overview(target).rules.find(item => item.secretIds.includes(dotenv.id))!;
    await service.setRule({ ...rule, fields: { [dotenv.id]: ['TOKEN'] } });
    const partial = await broker.run(context, command(`console.log(JSON.stringify({token:process.env.TOKEN,private:process.env.PRIVATE??'ABSENT'}));`, { envBundle: dotenv.reference }));
    assert.deepEqual(JSON.parse(partial.stdout), { token: '[REDACTED]', private: 'ABSENT' });
    await service.revoke(target, [metadata.id]); const denied = await broker.run(context, command(`console.log('should not run')`, { env: { TOKEN: metadata.reference } })); assert.equal(denied.exitCode, null); assert.equal(denied.stdout, '');
    assert.equal((await readFile(join(f.stateDir, 'secrets', 'vault.json'), 'utf8')).includes(canary), false);
    assert.equal((await readFile(join(f.stateDir, 'secrets', 'journal.json'), 'utf8')).includes(canary), false);
    await service.lock(); await assert.rejects(broker.run(context, command(`console.log('no')`, { env: { TOKEN: metadata.reference } })));
  } finally { await service.lock(); await f.cleanup(); }
});

test('consumer files never stage under a state directory inside the project', async () => {
  const f = await fixture();
  try {
    const inside = join(f.root, 'state'); await mkdir(inside);
    const result = await new SecretBroker({ stateDir: inside, service: f.service }).run(f.context, command(`console.log('should not run')`, { files: { KEY: f.add(canary, 'file') } }));
    assert.equal(result.exitCode, null); assert.equal(result.stdout, ''); assert.deepEqual(await readdir(inside), []);
  } finally { await f.cleanup(); }
});

test('redaction expansion is bounded before journaling and oversized aggregate input is denied', async () => {
  const f = await fixture();
  try {
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service });
    const result = await broker.run(f.context, command(`process.stdout.write(process.env.TOKEN.repeat(60000));`, { env: { TOKEN: f.add('x') } }));
    assert.equal(result.stdout, ''); assert.equal(result.stderr.includes('마스킹된 출력 크기 제한'), true);
    const size = f.ledger.size;
    await assert.rejects(broker.run(f.context, command('', { args: Array.from({ length: 100 }, () => 'a'.repeat(20000)) })));
    assert.equal(f.ledger.size, size);
  } finally { await f.cleanup(); }
});

test('compare and domain fingerprint disclose only their derived result', async () => {
  const f = await fixture();
  try {
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service }), left = f.add(canary), equal = f.add(canary), unequal = f.add('different');
    assert.deepEqual(await broker.compare(f.context, left, equal), { equal: true }); assert.deepEqual(await broker.compare(f.context, left, unequal), { equal: false });
    const first = await broker.fingerprint(f.context, left, 'object'); assert.deepEqual(first, await broker.fingerprint(f.context, left, 'object'));
    assert.notEqual(first.fingerprint, (await broker.fingerprint(f.context, left, 'other')).fingerprint); assert.equal(first.algorithm, 'HMAC-SHA256'); assert.equal(JSON.stringify(first).includes(canary), false);
    f.denied.add(left); await assert.rejects(broker.compare(f.context, left, equal)); await assert.rejects(broker.fingerprint(f.context, left));
  } finally { await f.cleanup(); }
});

test('remote resolved metadata and bytes must match the requested device, ID, version and reference', async () => {
  const f = await fixture();
  try {
    const ref = 'tower-secret://remote/secret@1';
    let metadata: Record<string, unknown> = { id: 'secret', version: 1, reference: ref }, bytes = Buffer.from(canary);
    const remote = { request: async () => ({ metadata, bytes: Buffer.from(bytes) }) } as unknown as RemoteSecretBroker;
    const broker = new SecretBroker({ stateDir: f.stateDir, service: f.service, remote });
    for (const changed of [{ id: 'different' }, { version: 2 }, { reference: 'tower-secret://wrong/secret@1' }, { sourceHostId: 'wrong' }]) {
      metadata = { id: 'secret', version: 1, reference: ref, ...changed };
      const result = await broker.run(f.context, command(`console.log('must-not-run')`, { env: { TOKEN: ref } })); assert.equal(result.exitCode, null); assert.equal(result.stdout, '');
    }
    metadata = { id: 'secret', version: 1, reference: ref, sourceHostId: 'remote' }; bytes = Buffer.alloc(1024 * 1024 + 1);
    const tooLarge = await broker.run(f.context, command(`console.log('must-not-run')`, { stdin: ref })); assert.equal(tooLarge.exitCode, null); assert.equal(tooLarge.stdout, '');
  } finally { await f.cleanup(); }
});
