/** Models are argv/RPC values, never command fragments or provider configuration. */
export function validModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(value);
}

export function requestedModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!validModelId(value)) throw Object.assign(new Error('Invalid model. Choose a valid provider model.'), { statusCode: 400 });
  return value;
}

/** Effort levels are provider-advertised identifiers, validated like models before reaching argv/RPC. */
export function validEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}

/** Claude Code's `--effort` accepts only these levels; Codex advertises its own per model. */
export const CLAUDE_EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function requestedEffort(value: unknown, provider?: 'claude' | 'codex'): string | undefined {
  if (value === undefined) return undefined;
  if (!validEffort(value) || (provider === 'claude' && !CLAUDE_EFFORT_LEVELS.includes(value))) throw Object.assign(new Error('Invalid reasoning effort. Choose a level the model supports.'), { statusCode: 400 });
  return value;
}
