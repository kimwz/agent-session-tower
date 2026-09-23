import type { Session } from '../../shared/types.js';
import { requestedEffort, requestedModel } from '../providers/models.js';

// The Claude Code command line is the whole protocol contract: stream-json both
// ways, replayed user messages and host-side permission prompts. Codex needs no
// per-turn flags because its app-server carries the same information over stdio.

function overrides(model?: string, effort?: string): string[] {
  const modelOverride = requestedModel(model);
  const effortOverride = requestedEffort(effort, 'claude');
  return [...(modelOverride ? ['--model', modelOverride] : []), ...(effortOverride ? ['--effort', effortOverride] : [])];
}

export function buildResumeArgs(session: Session, model?: string, effort?: string): string[] {
  if (session.provider === 'claude') return [
    '-p', '--resume', session.nativeId, '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', ...overrides(model, effort),
  ];
  requestedModel(model); requestedEffort(effort);
  return ['app-server', '--stdio'];
}

export function buildCreateArgs(session: Session, model?: string, effort?: string): string[] {
  if (session.provider === 'claude') return [
    '-p', '--session-id', session.nativeId, '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', ...overrides(model, effort),
  ];
  requestedModel(model); requestedEffort(effort);
  return ['app-server', '--stdio'];
}
