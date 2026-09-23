import type { Run, Session, SessionContextUsage } from '../../shared/types.js';
import { validModelId } from '../providers/models.js';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export const contextTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const contextCapacity = (value: unknown): value is number => contextTokens(value) && value > 0;

// Exact entries in Claude Code 2.1.263's native model catalog (context.window).
// These are defaults, not proof of a historical session's settings or capacity.
const CLAUDE_DEFAULT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-sonnet-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  // Observed in native result modelUsage for sessions launched with `--model opus`.
  'claude-opus-5-5': 1_000_000,
};

/**
 * Native results key usage by the configured model, which can carry a context
 * variant such as `claude-opus-5-5[1m]`, while messages report the bare model.
 */
export function modelContextWindow(modelUsage: unknown, model: string): unknown {
  if (!object(modelUsage)) return;
  if (Object.hasOwn(modelUsage, model)) return modelUsage[model]?.contextWindow;
  const variants = Object.keys(modelUsage).filter(key => key.startsWith(`${model}[`) && key.endsWith(']'));
  return variants.length === 1 ? modelUsage[variants[0]]?.contextWindow : undefined;
}

export function claudeInputTokens(usage: unknown): number | undefined {
  if (!object(usage) || !contextTokens(usage.input_tokens)) return;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  if (!contextTokens(written) || !contextTokens(read)) return;
  const usedTokens = usage.input_tokens + written + read;
  return contextTokens(usedTokens) ? usedTokens : undefined;
}

export function claudeContextUsage(model: string | undefined, usedTokens: number, updatedAt: string, previous?: SessionContextUsage): SessionContextUsage {
  const nativeCapacity = previous?.capacitySource === undefined && contextCapacity(previous?.contextWindow) ? previous.contextWindow : undefined;
  const capacity = nativeCapacity ?? (model && Object.hasOwn(CLAUDE_DEFAULT_WINDOWS, model) ? CLAUDE_DEFAULT_WINDOWS[model] : undefined);
  return { usedTokens, updatedAt, ...(capacity ? { contextWindow: capacity, usedPercent: usedTokens / capacity * 100,
    ...(nativeCapacity === undefined ? { capacitySource: 'model-default' as const } : {}) } : {}) };
}

/** Persist only a complete, exact observation; malformed saved metadata is discarded. */
export function nativeContextObservation(value: unknown): Run['contextUsage'] | undefined {
  if (!object(value) || !validModelId(value.model) || !contextTokens(value.usedTokens) || !contextCapacity(value.contextWindow)
    || value.capacitySource !== undefined || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return;
  const usedPercent = value.usedTokens / value.contextWindow * 100;
  if (value.usedPercent !== usedPercent) return;
  return { model: value.model, usedTokens: value.usedTokens, contextWindow: value.contextWindow, usedPercent,
    updatedAt: new Date(value.updatedAt).toISOString() };
}

/** A run can enrich the same native observation, never revive compacted or newer context. */
export function withNativeContext(session: Session, observation: Run['contextUsage'] | undefined): Session {
  const usage = session.contextUsage;
  const exact = nativeContextObservation(observation);
  if (session.provider !== 'claude' || !usage || !exact || session.model !== exact.model
    || usage.usedTokens !== exact.usedTokens || !usage.updatedAt || !Number.isFinite(Date.parse(usage.updatedAt))
    || Date.parse(usage.updatedAt) > Date.parse(exact.updatedAt)
    || (usage.capacitySource === undefined && contextCapacity(usage.contextWindow))) return session;
  const { capacitySource: _estimated, ...nativeUsage } = usage;
  return { ...session, contextUsage: { ...nativeUsage, contextWindow: exact.contextWindow, usedPercent: exact.usedPercent } };
}
