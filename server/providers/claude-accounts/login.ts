import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { removeClaudeStore, type Keychain } from './storage.js';
import type { ClaudeAccountView } from './accounts.js';
import type { ClaudeLoginStatus } from '../../../shared/types.js';

/**
 * Adding a Claude account from Tower: `claude auth login` runs in a new config folder of its own, so the account signed in
 * now is not touched. It prints a sign-in address that hands out a code (it works from any device); the owner signs in
 * there and gives Tower the code, which goes to the login's stdin. Nothing it prints besides that address and its failure
 * line is kept, and no browser opens on this computer.
 */
export type ClaudeLoginState = ClaudeLoginStatus;

const TIMEOUT = 10 * 60_000;
const AUTHORIZE_URL = /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com)\/[^\s"'<>\u001b]*oauth\/authorize\?[^\s"'<>\u001b]+/;
const strip = (text: string): string => text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-9;?<>=]*[a-zA-Z~]/g, '');
// Sign-in settings of the environment would sign this login in elsewhere, or skip it.
const DROPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

export type ClaudeLoginOptions = {
  /** Where new account folders go (the saved accounts' folder). */
  directory: string;
  executable: () => Promise<string | undefined>;
  adopt: (directory: string) => Promise<ClaudeAccountView>;
  onChange: () => void;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  keychain?: Keychain;
  timeoutMs?: number;
};

export class ClaudeLogin {
  private current?: { state: ClaudeLoginState; child?: ChildProcess; directory: string; timer?: ReturnType<typeof setTimeout>; output: string; failure?: string };
  constructor(private readonly options: ClaudeLoginOptions) {}

  status(): ClaudeLoginState | undefined { return this.current ? { ...this.current.state } : undefined; }

  async start(): Promise<ClaudeLoginState> {
    if (this.current && ['starting', 'waiting_code', 'verifying'].includes(this.current.state.state)) return this.status()!;
    await this.discard();
    const executable = await this.options.executable();
    if (!executable) throw new Error('Claude Code CLI를 찾지 못했습니다.');
    const id = randomBytes(6).toString('hex');
    const directory = join(this.options.directory, `login-${id}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...(this.options.env || process.env), CLAUDE_CONFIG_DIR: directory, BROWSER: '/usr/bin/true', NO_COLOR: '1' };
    for (const key of DROPPED_ENV) delete env[key];
    const current: NonNullable<ClaudeLogin['current']> = { state: { id, state: 'starting' }, directory, output: '' };
    this.current = current;
    const child = spawn(executable, ['auth', 'login', '--claudeai'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    current.child = child;
    const read = (chunk: Buffer, stderr: boolean) => {
      if (this.current !== current) return;
      const text = strip(chunk.toString('utf8'));
      if (stderr) {
        const failed = text.split(/\r?\n/).find(line => /Login failed|error/i.test(line));
        if (failed) current.failure = failed.trim().slice(0, 300);
        return;
      }
      if (current.state.url) return;
      current.output = (current.output + text).slice(-8192);
      const url = current.output.match(AUTHORIZE_URL)?.[0];
      if (url) { current.state = { ...current.state, state: 'waiting_code', url }; current.output = ''; this.options.onChange(); }
    };
    child.stdout?.on('data', chunk => read(chunk, false));
    child.stderr?.on('data', chunk => read(chunk, true));
    child.on('error', () => { if (this.current === current) this.fail(current, 'Claude Code 로그인을 시작하지 못했습니다.'); });
    child.on('close', code => { void this.closed(current, code); });
    current.timer = setTimeout(() => { if (this.current === current) { child.kill('SIGTERM'); this.fail(current, '로그인 시간이 지났습니다. 다시 시도하세요.'); } }, this.options.timeoutMs ?? TIMEOUT);
    current.timer.unref?.();
    return this.status()!;
  }

  submitCode(code: string): ClaudeLoginState {
    const current = this.current;
    if (!current || current.state.state !== 'waiting_code' || !current.child?.stdin) throw new Error('코드를 기다리는 로그인이 없습니다.');
    const value = code.trim();
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f\s]/.test(value)) throw new Error('코드 형식이 올바르지 않습니다.');
    current.state = { ...current.state, state: 'verifying' };
    current.child.stdin.write(`${value}\n`);
    this.options.onChange();
    return this.status()!;
  }

  async cancel(): Promise<void> {
    await this.discard();
    this.options.onChange();
  }

  async stop(): Promise<void> { await this.discard(); }

  private async closed(current: NonNullable<ClaudeLogin['current']>, code: number | null): Promise<void> {
    if (current.timer) clearTimeout(current.timer);
    if (this.current !== current || current.state.state === 'failed') return;
    if (code !== 0) return this.fail(current, current.failure?.replace(/^.*Login failed:\s*/i, '') || '로그인하지 못했습니다. 다시 시도하세요.');
    let next: ClaudeLoginState;
    try { next = { ...current.state, state: 'done', account: await this.options.adopt(current.directory) }; }
    catch (error) { next = { ...current.state, state: 'failed', error: error instanceof Error ? error.message : '계정을 저장하지 못했습니다.' }; }
    // The saved account has its own copy now; the login's folder and keychain item go before the result shows.
    await this.removeFolder(current.directory);
    if (this.current !== current) return;
    current.state = next;
    this.options.onChange();
  }

  private fail(current: NonNullable<ClaudeLogin['current']>, error: string): void {
    if (current.timer) clearTimeout(current.timer);
    current.state = { ...current.state, state: 'failed', error };
    if (current.child && current.child.exitCode === null) current.child.kill('SIGTERM');
    void this.removeFolder(current.directory);
    this.options.onChange();
  }

  private async removeFolder(directory: string): Promise<void> {
    try { await removeClaudeStore(directory, { ...(this.options.platform ? { platform: this.options.platform } : {}), ...(this.options.keychain ? { keychain: this.options.keychain } : {}) }); }
    catch { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }

  private async discard(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    if (current.child && current.child.exitCode === null) {
      const closed = new Promise(resolve => current.child!.once('close', resolve));
      current.child.kill('SIGTERM');
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000).unref())]);
    }
    await this.removeFolder(current.directory);
  }
}
