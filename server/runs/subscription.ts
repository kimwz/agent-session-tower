import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { MASTER_FOLDER } from '../../shared/master.js';

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

/** Whether a session is the master's: it runs in the master's folder under Tower's state directory. */
export function subscriptionOnly(stateDir: string, cwd: string): boolean {
  return resolve(cwd) === join(resolve(stateDir), MASTER_FOLDER);
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
  throw new SubscriptionError('마스터는 Claude 구독 로그인(claude.ai)으로만 대화합니다. 이 컴퓨터의 Claude Code가 API 키나 다른 방식으로 로그인되어 있어 보내지 않았습니다. `claude auth login`으로 구독 계정에 로그인해 주세요.');
}

/** A Codex account read from its app-server: only a ChatGPT sign-in passes. */
export function checkCodexAccount(result: unknown): void {
  const account = (result as { account?: { type?: unknown } | null } | undefined)?.account;
  if (account?.type === 'chatgpt') return;
  throw new SubscriptionError('마스터는 ChatGPT 구독 로그인으로만 대화합니다. 이 컴퓨터의 Codex가 API 키나 다른 방식으로 로그인되어 있어 보내지 않았습니다. `codex login`으로 ChatGPT 계정에 로그인해 주세요.');
}
