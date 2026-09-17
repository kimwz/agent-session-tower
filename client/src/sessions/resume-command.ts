import type { Session } from '../../../shared/types';

const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that continues a session in the user's own terminal. Claude Code leaves sessions
 * started with `-p`, which is how Tower starts them, out of its resume picker, so the ID is the
 * only way in. The `cd` keeps the agent in the session's project folder: both CLIs open a session
 * by ID from anywhere and would otherwise work in whatever folder the terminal happens to be in.
 */
export function resumeCommand(session: Pick<Session, 'provider' | 'nativeId' | 'cwd' | 'resumable'>): string | undefined {
  if (!session.resumable || !SAFE_NATIVE_ID.test(session.nativeId)) return undefined;
  const resume = session.provider === 'claude' ? `claude --resume ${session.nativeId}` : `codex resume ${session.nativeId}`;
  return session.cwd?.startsWith('/') ? `cd ${shellQuote(session.cwd)} && ${resume}` : resume;
}
