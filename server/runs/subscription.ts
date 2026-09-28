import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { MASTER_FOLDER } from '../../shared/master.js';
import type { Session } from '../../shared/types.js';

/**
 * The master talks only through the owner's Claude or ChatGPT subscription sign-in, never through an API key. Its turns
 * run without the environment variables that would make either CLI use a key or another provider, Claude's sign-in is
 * checked before each turn, and Codex is started so that it accepts only a ChatGPT sign-in.
 */
const KEYED_ENVIRONMENT = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY',
];

/** Codex settings for a turn of the master: a ChatGPT sign-in only, and OpenAI's own service. */
export const CODEX_SUBSCRIPTION_CONFIG = ['-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'];
/**
 * How long the master's own tools may take: a call waits for a web that is restarting and paces calls to joined
 * computers, and a tool cut off by the CLI while the host still works would be sent again by the master.
 */
export const MASTER_TOOL_TIMEOUT_SECONDS = 300;

/** A path as the file system names it, links followed; for a path that does not exist (yet), its nearest existing parent's. */
function canonical(path: string): string {
  const full = resolve(path);
  try { return realpathSync(full); } catch {
    const parent = dirname(full);
    return parent === full ? full : join(canonical(parent), basename(full));
  }
}

/**
 * Whether a session is the master's: it runs in the master's folder under Tower's state directory. Both sides are
 * compared with links followed, so a state directory reached through a link (as /var is on macOS) still matches.
 */
export function subscriptionOnly(stateDir: string, cwd: string): boolean {
  if (resolve(cwd) === join(resolve(stateDir), MASTER_FOLDER)) return true;
  return canonical(cwd) === masterFolder(stateDir);
}
/**
 * Whether a folder is the master's or inside it, for lists that leave the master out. Decided without asking the disk
 * for each folder: the master's folder as written, and with links followed (as a CLI records where it runs).
 */
export function inMasterFolder(stateDir: string, cwd: string): boolean {
  if (!cwd || !cwd.startsWith('/')) return false;
  const path = resolve(cwd);
  return [join(resolve(stateDir), MASTER_FOLDER), masterFolder(stateDir)].some(folder => path === folder || path.startsWith(`${folder}/`));
}
/** Sessions marked as the master's (and its subagents'). */
export function markMaster(sessions: Session[], stateDir: string): Session[] {
  return sessions.map(session => inMasterFolder(stateDir, session.cwd) ? { ...session, master: true } : session);
}
/** Folder settings without the master's folder, which is never shown as a project. */
export const withoutMasterFolder = <T extends { cwd: string }>(groups: T[], stateDir: string): T[] => groups.filter(group => !inMasterFolder(stateDir, group.cwd));
/** The master's folder with links followed (itself included), kept a little so busy callers do not ask the disk each time. */
const folders = new Map<string, { path: string; at: number }>();
function masterFolder(stateDir: string): string {
  const known = folders.get(stateDir);
  if (known && Date.now() - known.at < 10_000) return known.path;
  const path = canonical(join(stateDir, MASTER_FOLDER));
  folders.set(stateDir, { path, at: Date.now() });
  return path;
}

/** Takes out what would let a CLI use an API key or another provider. */
export function withoutKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const name of KEYED_ENVIRONMENT) delete next[name];
  return next;
}

export class SubscriptionError extends Error {}

/**
 * Asks Claude Code how it would sign in, with the same program, folder and environment as the turn. Only a claude.ai
 * (subscription) sign-in with Anthropic's own service passes.
 */
export async function checkClaudeSubscription(executable: string, cwd: string, env: NodeJS.ProcessEnv, run: typeof execFile = execFile): Promise<void> {
  const output = await new Promise<string>((done, fail) => {
    run(executable, ['auth', 'status'], { cwd, env, timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => error && !stdout ? fail(error) : done(String(stdout)));
  }).catch(() => undefined);
  let status: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown } | undefined;
  try { status = output ? JSON.parse(output) : undefined; } catch { status = undefined; }
  if (status?.loggedIn === true && status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty') return;
  if (!status) throw new SubscriptionError('Claude Code의 로그인 방식을 확인하지 못해 마스터에게 보내지 않았습니다. 잠시 뒤 다시 보내 주세요.');
  throw new SubscriptionError('마스터는 Claude 구독 로그인(claude.ai)으로만 대화합니다. 이 컴퓨터의 Claude Code가 API 키나 다른 방식으로 로그인되어 있어 보내지 않았습니다. `claude auth login`으로 구독 계정에 로그인해 주세요.');
}

/** The provider Codex opened the master's thread with, as it says (profiles and project settings applied): only OpenAI's own. */
export function checkCodexProvider(provider: unknown): void {
  if (provider === 'openai') return;
  throw new SubscriptionError('마스터는 OpenAI의 기본 서비스로만 대화합니다. Codex 설정이 다른 제공자를 쓰고 있어 보내지 않았습니다.');
}

/** A Codex account read from its app-server: only a ChatGPT sign-in passes. */
export function checkCodexAccount(result: unknown): void {
  const account = (result as { account?: { type?: unknown } | null } | undefined)?.account;
  if (account?.type === 'chatgpt') return;
  throw new SubscriptionError('마스터는 ChatGPT 구독 로그인으로만 대화합니다. 이 컴퓨터의 Codex가 API 키나 다른 방식으로 로그인되어 있어 보내지 않았습니다. `codex login`으로 ChatGPT 계정에 로그인해 주세요.');
}
