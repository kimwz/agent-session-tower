import { spawn } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve as absolute, sep } from 'node:path';
import { SECRET_OPERATIONS, type SecretContext, type SecretMetadata, type SecretOperation, type SecretRunInput, type SecretRunResult } from '../../shared/secrets.js';
import type { ResolvedSecret, SecretDispatchUse, SecretService } from './service.js';
import type { RemoteSecretBroker } from './remote.js';

type SourceFailure = { sourceHostId: string; code: 'SECRET_SOURCE_UNAVAILABLE' };
type Resolved = ResolvedSecret;
const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OUTPUT_BYTES = 512 * 1024;
const MAX_TIMEOUT = 10 * 60_000;
const MAX_INPUT_BYTES = 1024 * 1024;
const genericResult = (operationId: string, stderr = '시크릿 사용 또는 프로그램 실행을 완료하지 못했습니다. 권한·잠금·참조·실행 경로를 확인하세요.'): SecretRunResult => ({ operationId, exitCode: null, stdout: '', stderr });
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor && descriptor.enumerable);
}
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= limit; }
function reference(value: unknown): value is string { return text(value, 8192) && /^tower-secret:\/\/[^/]+\/[^@/#]+@\d+(?:#.+)?$/.test(value); }
function bindings(value: unknown, max: number): boolean {
  return plain(value) && Object.keys(value).length <= max && Object.entries(value).every(([key, ref]) => ENV_NAME.test(key) && reference(ref));
}
export function validateSecretRunInput(value: unknown): SecretRunInput {
  if (!plain(value) || Object.keys(value).some(key => !['operationId', 'command', 'args', 'cwd', 'timeoutMs', 'env', 'envBundle', 'stdin', 'files'].includes(key))) throw failure('시크릿 실행 요청이 올바르지 않습니다.');
  if (typeof value.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(value.operationId)) throw failure('명령마다 고유한 operationId가 필요합니다.');
  if (!text(value.command, 4096)) throw failure('실행할 프로그램이 필요합니다.');
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 256 || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 32768))) throw failure('명령 인자가 올바르지 않습니다.');
  if (value.cwd !== undefined && (!text(value.cwd, 8192) || !isAbsolute(value.cwd))) throw failure('실행 경로가 올바르지 않습니다.');
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > MAX_TIMEOUT)) throw failure('실행 시간 제한이 올바르지 않습니다.');
  if ((value.env !== undefined && !bindings(value.env, 128)) || (value.files !== undefined && !bindings(value.files, 32)) || (value.envBundle !== undefined && !reference(value.envBundle)) || (value.stdin !== undefined && !reference(value.stdin))) throw failure('시크릿 연결이 올바르지 않습니다.');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_INPUT_BYTES) throw failure('시크릿 실행 요청이 너무 큽니다.');
  return structuredClone(value) as unknown as SecretRunInput;
}
async function privateConsumerDirectory(stateDir: string): Promise<string> {
  const root = absolute(stateDir);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw failure('비공개 임시 경로가 올바르지 않습니다.');
  let current = root;
  for (const part of ['secrets', 'consumers']) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw failure('비공개 임시 경로가 올바르지 않습니다.');
    await chmod(current, 0o700);
  }
  return current;
}

/** Apply before any provider or CLI captures the result, including failed commands. */
export function maskSecretOutput(text: string, values: readonly Buffer[]): string {
  const patterns = new Set<string>();
  for (const bytes of values) {
    if (!bytes.length) continue;
    const value = bytes.toString('utf8');
    for (const pattern of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), bytes.toString('base64'), bytes.toString('hex')]) {
      if (pattern) patterns.add(pattern);
    }
  }
  for (const pattern of [...patterns].sort((a, b) => b.length - a.length)) text = text.split(pattern).join('[REDACTED]');
  return text;
}

/** The only component that gives plaintext to a consumer; public APIs expose its masked result. */
export class SecretBroker {
  private active = 0;
  private readonly sourceFailures = new Map<string, SourceFailure[]>();
  private subject(context: SecretContext): string { return JSON.stringify([context.hostId, context.taskId, context.runId]); }
  unavailableSources(context: SecretContext): SourceFailure[] { return structuredClone(this.sourceFailures.get(this.subject(context)) ?? []); }
  constructor(private readonly options: { stateDir: string; service: SecretService; remote?: RemoteSecretBroker }) {}
  inFlight(): boolean { return this.active > 0; }

  async list(context: SecretContext): Promise<SecretMetadata[]> {
    const local = await this.options.service.list(context);
    this.options.service.checkTask(context);
    const failures: SourceFailure[] = [];
    const peers = this.options.service.peers().filter(peer => peer.enabled && peer.direction === 'controller');
    const remote = await Promise.all(peers.map(async peer => {
      try {
        if (!this.options.remote) throw failure('원격 원본에 연결할 수 없습니다.', 503);
        this.options.service.checkTask(context);
        const result = await this.options.remote.request(peer.device.id, context, 'list', {});
        this.options.service.checkTask(context);
        if (!Array.isArray(result) || result.length > 4096 || result.some(item => !plain(item)
          || Object.keys(item).some(key => !['id', 'name', 'groupId', 'kind', 'version', 'reference', 'fields', 'expiresAt', 'operations', 'activation', 'sourceHostId'].includes(key))
          || !reference(item.reference) || !item.reference.startsWith(`tower-secret://${peer.device.id}/`)
          || !text(item.id, 1024) || !text(item.name, 256) || !text(item.groupId, 1024) || !['scalar', 'env', 'file'].includes(String(item.kind))
          || !Number.isSafeInteger(item.version) || Number(item.version) < 1
          || (item.fields !== undefined && (!Array.isArray(item.fields) || item.fields.length > 4096 || item.fields.some(field => typeof field !== 'string' || !ENV_NAME.test(field))))
          || (item.operations !== undefined && (!Array.isArray(item.operations) || item.operations.some(operation => !SECRET_OPERATIONS.includes(operation))))
          || (item.expiresAt !== undefined && !Number.isSafeInteger(item.expiresAt))
          || (item.activation !== undefined && !['auto', 'manual'].includes(String(item.activation))))) throw failure('원격 목록이 올바르지 않습니다.', 502);
        return result.filter(item => { try { this.options.service.checkTask(context, item.id); return true; } catch { return false; } }).map(item => ({ ...item, sourceHostId: peer.device.id })) as SecretMetadata[];
      } catch { failures.push({ sourceHostId: peer.device.id, code: 'SECRET_SOURCE_UNAVAILABLE' }); return []; }
    }));
    this.options.service.checkTask(context);
    if (this.sourceFailures.size >= 256) this.sourceFailures.delete(this.sourceFailures.keys().next().value!);
    this.sourceFailures.set(this.subject(context), failures);
    return [...local, ...remote.flat()];
  }

  private async resolve(context: SecretContext, reference: string, operation: SecretOperation): Promise<Resolved> {
    const match = /^tower-secret:\/\/([^/]+)\/([^@/#]+)@(\d+)(?:#.+)?$/.exec(reference);
    if (!match) throw failure('유효한 시크릿 참조가 필요합니다.');
    if (match[1] === this.options.service.device().id) return this.options.service.resolve(context, reference, operation);
    this.options.service.checkTask(context, match[2]);
    if (!this.options.remote) throw failure('시크릿 원본 컴퓨터에 연결할 수 없습니다.', 503);
    const answer = await this.options.remote.request(match[1], context, 'resolve', { reference, operation }) as Resolved;
    try {
      this.options.service.checkTask(context, match[2]);
      if (!plain(answer) || !Buffer.isBuffer(answer.bytes) || answer.bytes.length > MAX_INPUT_BYTES || !plain(answer.metadata)
        || answer.metadata.id !== match[2] || answer.metadata.reference !== reference.split('#')[0]
        || !Number.isSafeInteger(answer.metadata.version) || answer.metadata.version !== Number(match[3])
        || (answer.metadata.sourceHostId !== undefined && answer.metadata.sourceHostId !== match[1])
        || (answer.fields !== undefined && (!plain(answer.fields) || Object.keys(answer.fields).length > 2048
          || Object.entries(answer.fields).some(([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string')
          || Object.values(answer.fields).reduce((total, value) => total + Buffer.byteLength(value), 0) > MAX_INPUT_BYTES))) throw failure('원격 시크릿 응답이 올바르지 않습니다.', 502);
      return { ...answer, metadata: { ...answer.metadata, sourceHostId: match[1] } };
    } catch (error) { if (Buffer.isBuffer(answer?.bytes)) answer.bytes.fill(0); throw error; }
  }

  async run(context: SecretContext, supplied: SecretRunInput): Promise<SecretRunResult> {
    const input = validateSecretRunInput(supplied), timeoutMs = input.timeoutMs ?? 60_000;
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    this.active++;
    try {
      const claim = await this.options.service.beginOperation(context, input.operationId, digest);
      if (!claim.fresh) {
        if (claim.state === 'done') return claim.result as SecretRunResult;
        throw failure('이 요청의 전달 상태가 불확실합니다. 같은 요청을 다시 실행하지 않았습니다.', 409);
      }
      const values: Buffer[] = [];
      let deliveredBytes = 0;
      let temporary: string | undefined;
      let result: SecretRunResult;
      try {
        const cwd = await realpath(input.cwd ?? context.root), root = await realpath(context.root);
        const nested = relative(root, cwd);
        if (nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested)) throw failure('현재 프로젝트 안에서만 실행할 수 있습니다.', 403);
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']) if (process.env[key]) env[key] = process.env[key];
        const put = (name: string, value: string) => {
          if (!ENV_NAME.test(name) || /^(TOWER_|AGENT_MONITOR_|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/.test(name) || value.includes('\0')) throw failure('이 환경변수 이름 또는 값은 사용할 수 없습니다.');
          env[name] = value; values.push(Buffer.from(value));
        };
        const used: SecretDispatchUse[] = [];
        const get = async (ref: string, operation: SecretOperation) => {
          const value = await this.resolve(context, ref, operation);
          deliveredBytes += value.bytes.length;
          if (deliveredBytes > 8 * MAX_INPUT_BYTES) { value.bytes.fill(0); throw failure('연결한 시크릿 전체 크기가 너무 큽니다.'); }
          used.push({ ref, operation, value }); values.push(value.bytes);
          if (value.fields) values.push(...Object.values(value.fields).map(field => Buffer.from(field)));
          return value;
        };
        if (input.envBundle) {
          const bundle = await get(input.envBundle, 'env');
          if (!bundle.fields) throw failure('환경변수 묶음 참조가 필요합니다.');
          for (const [name, value] of Object.entries(bundle.fields)) put(name, value);
        }
        for (const [name, ref] of Object.entries(input.env ?? {})) {
          const value = await get(ref, 'env'); if (value.fields) throw failure('단일 환경변수에는 값 또는 field 참조를 사용하세요.'); put(name, value.bytes.toString('utf8'));
        }
        let stdin: Buffer | undefined;
        if (input.stdin) stdin = (await get(input.stdin, 'pipe')).bytes;
        const paths = new Map<string, string>();
        for (const [name, ref] of Object.entries(input.files ?? {})) {
          const stateWithinProject = relative(root, absolute(this.options.stateDir));
          if (!stateWithinProject || (stateWithinProject !== '..' && !stateWithinProject.startsWith(`..${sep}`) && !isAbsolute(stateWithinProject))) throw failure('프로젝트 밖의 비공개 상태 경로가 필요합니다.');
          const value = await get(ref, 'file');
          if (!temporary) temporary = await mkdtemp(join(await privateConsumerDirectory(this.options.stateDir), 'consumer-'));
          if (await realpath(temporary) !== temporary || (await lstat(temporary)).isSymbolicLink()) throw failure('비공개 임시 경로가 올바르지 않습니다.');
          const path = join(temporary, name), file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(value.bytes); } finally { await file.close(); }
          paths.set(name, path);
        }
        const args = (input.args ?? []).map(arg => arg.replace(/\{secret-file:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
          const path = paths.get(name); if (!path) throw failure('연결하지 않은 시크릿 파일 참조입니다.'); return path;
        }));
        if (temporary) { await privateConsumerDirectory(this.options.stateDir); if (await realpath(temporary) !== temporary) throw failure('비공개 임시 경로가 올바르지 않습니다.'); }
        // Staging files and fetching another secret can await owner policy changes. Re-authorize each use before spawning.
        for (const item of used) {
          const current = await this.resolve(context, item.ref, item.operation);
          try { if (current.metadata.id !== item.value.metadata.id || current.metadata.version !== item.value.metadata.version || !current.bytes.equals(item.value.bytes) || JSON.stringify(current.fields) !== JSON.stringify(item.value.fields)) throw failure('시크릿 권한 또는 값이 변경되었습니다.', 403); }
          finally { current.bytes.fill(0); }
        }
        const dispatched = await this.options.service.dispatch(context, used, () => this.consume(input, args, cwd, env, stdin, timeoutMs, values));
        result = await dispatched.result;
      } catch { result = genericResult(input.operationId); }
      finally {
        try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
        catch { result = genericResult(input.operationId, '비공개 임시 파일을 정리하지 못했습니다.'); }
        for (const value of values) value.fill(0);
      }
      await this.options.service.finishOperation(context, input.operationId, digest, result!);
      return result!;
    } finally { this.active--; }
  }

  private consume(input: SecretRunInput, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin: Buffer | undefined, timeoutMs: number, values: Buffer[]): Promise<SecretRunResult> {
    return new Promise(resolve => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(input.command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { resolve({ operationId: input.operationId, exitCode: null, stdout: '', stderr: '프로그램을 시작할 수 없습니다.' }); return; }
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let size = 0, timedOut = false, exceeded = false, settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (exitCode: number | null, failed = false) => {
        if (settled) return; settled = true; if (timer) clearTimeout(timer);
        // A descendant can retain inherited pipes after the consumer exits. Limits do not wait for its close.
        child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
        try {
          if (timedOut) { resolve({ ...genericResult(input.operationId, '프로그램 실행 시간이 만료되었습니다. 출력은 폐기했습니다.'), timedOut: true }); return; }
          if (exceeded) { resolve(genericResult(input.operationId, '출력 크기 제한에 도달했습니다. 출력은 폐기했습니다.')); return; }
          if (failed) { resolve(genericResult(input.operationId, '프로그램을 시작하거나 입력을 전달하지 못했습니다.')); return; }
          const maskedStdout = maskSecretOutput(Buffer.concat(stdout).toString('utf8'), values), maskedStderr = maskSecretOutput(Buffer.concat(stderr).toString('utf8'), values);
          if (Buffer.byteLength(maskedStdout) + Buffer.byteLength(maskedStderr) > OUTPUT_BYTES) { resolve(genericResult(input.operationId, '마스킹된 출력 크기 제한에 도달했습니다. 출력은 폐기했습니다.')); return; }
          resolve({ operationId: input.operationId, exitCode, stdout: maskedStdout, stderr: maskedStderr });
        } finally { for (const chunk of [...stdout, ...stderr]) chunk.fill(0); stdout.length = 0; stderr.length = 0; }
      };
      const stopConsumer = (failed = false) => {
        if (settled) return;
        // This handle is solely the consumer this broker spawned, never a provider, shell or descendant.
        child.kill('SIGKILL'); finish(null, failed);
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > OUTPUT_BYTES) { exceeded = true; stopConsumer(); } else target.push(chunk);
      };
      child.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.stdout!.on('error', () => stopConsumer(true));
      child.stderr!.on('error', () => stopConsumer(true));
      child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
        // Consumers may exit without reading stdin; other input failures terminate this consumer only.
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') stopConsumer(true);
      });
      timer = setTimeout(() => { timedOut = true; stopConsumer(); }, timeoutMs);
      child.once('error', () => finish(null, true));
      child.once('close', code => finish(code));
      child.stdin!.end(stdin);
    });
  }

  async compare(context: SecretContext, left: string, right: string): Promise<{ equal: boolean }> {
    const a = await this.resolve(context, left, 'compare');
    const b = await this.resolve(context, right, 'compare');
    return { equal: a.bytes.length === b.bytes.length && timingSafeEqual(a.bytes, b.bytes) };
  }

  async fingerprint(context: SecretContext, reference: string, domain = 'object'): Promise<{ algorithm: 'HMAC-SHA256'; fingerprint: string }> {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(domain)) throw failure('fingerprint domain이 올바르지 않습니다.');
    const value = await this.resolve(context, reference, 'fingerprint');
    const fingerprint = createHmac('sha256', this.options.service.fingerprintKey()).update(JSON.stringify(['tower-secret-fingerprint-v1', this.options.service.device().id, domain, value.metadata.id])).update(value.bytes).digest('hex');
    return { algorithm: 'HMAC-SHA256', fingerprint };
  }
}
