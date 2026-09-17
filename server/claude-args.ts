import type { Session } from '../shared/types.js';
import { requestedModel } from './models.js';

// The Claude Code command line is the whole protocol contract: stream-json both
// ways, replayed user messages and host-side permission prompts. Codex needs no
// per-turn flags because its app-server carries the same information over stdio.

export function buildResumeArgs(session: Session, model?: string): string[] {
  const override = requestedModel(model);
  if (session.provider === 'claude') return [
    '-p', '--resume', session.nativeId, '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', ...(override ? ['--model', override] : []),
  ];
  return ['app-server', '--stdio'];
}

export function buildCreateArgs(session: Session, model?: string): string[] {
  const override = requestedModel(model);
  if (session.provider === 'claude') return [
    '-p', '--session-id', session.nativeId, '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', ...(override ? ['--model', override] : []),
  ];
  return ['app-server', '--stdio'];
}
