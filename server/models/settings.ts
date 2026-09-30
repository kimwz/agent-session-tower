import { randomUUID } from 'node:crypto';
import { link, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { initialModelSettings, parseModelSettings, resolveRole, type ModelProvider, type ModelSettings, type ResolvedModel } from '../../shared/models.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/**
 * The one place Tower's own Claude/Codex calls get their provider, model and effort: `<state>/models.json`.
 * Each process (web, worker, master host) reads the file again when it changed, so a saved change applies to the next
 * call everywhere without restarting anything.
 */
export const MODEL_SETTINGS_FILE = 'models.json';
const cache = new Map<string, { mtimeMs: number; size: number; settings: ModelSettings }>();
const writes = new Map<string, Promise<unknown>>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;

/**
 * The first settings of a Tower that had none: the initial values, with the choices the owner had already made
 * elsewhere carried over (the permission reviewer's provider and model, the skill advisor's provider).
 */
export async function migratedModelSettings(stateDir: string): Promise<ModelSettings> {
  const settings = initialModelSettings();
  const read = (name: string) => readPrivateJson(join(stateDir, name)).then(record, () => undefined);
  const [permissions, skills] = await Promise.all([read('permissions.json'), read('skills.json')]);
  const review = record(permissions?.autoReview);
  if (review) {
    const provider: ModelProvider = review.provider === 'codex' ? 'codex' : 'claude';
    // The reviewer only ever accepted these; anything else ran as the provider's first model.
    const allowed = provider === 'claude' ? ['opus', 'sonnet'] : ['gpt-5.6-sol', 'gpt-5.6-terra'];
    settings.roles['permissions.reviewer'] = { ...settings.roles['permissions.reviewer'], provider,
      [provider]: { model: allowed.includes(review.model) ? review.model : allowed[0] } };
  }
  if (record(skills?.settings)?.provider === 'codex') settings.roles['skills.advisor'].provider = 'codex';
  return settings;
}

export async function readModelSettings(stateDir: string): Promise<ModelSettings> {
  const path = join(stateDir, MODEL_SETTINGS_FILE);
  const info = await stat(path).catch(error => { if (missing(error)) return undefined; throw error; });
  if (!info) {
    const settings = await migratedModelSettings(stateDir);
    // Saved once so later changes elsewhere no longer move it; a Tower that cannot write keeps working from memory.
    await save(stateDir, settings, true).catch(() => {});
    return structuredClone(settings);
  }
  const kept = cache.get(path);
  if (kept && kept.mtimeMs === info.mtimeMs && kept.size === info.size) return structuredClone(kept.settings);
  const settings = parseModelSettings(await readPrivateJson(path, 1_000_000).catch(() => undefined));
  cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, settings });
  return structuredClone(settings);
}

/** Replaces the settings with the owner's, which must be valid in full. */
export async function saveModelSettings(stateDir: string, input: unknown): Promise<ModelSettings> {
  const settings = parseModelSettings(input, true, await readModelSettings(stateDir));
  await save(stateDir, settings, false);
  return structuredClone(settings);
}

async function save(stateDir: string, settings: ModelSettings, onlyIfMissing: boolean): Promise<void> {
  const path = join(stateDir, MODEL_SETTINGS_FILE);
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const data = JSON.stringify(settings, null, 2) + '\n';
    if (onlyIfMissing) {
      // Created only where none exists, even against another process: an owner's save is never replaced by a migration.
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writePrivateJson(temporary, data);
      try { await link(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      finally { await unlink(temporary).catch(() => {}); }
    } else await writePrivateJson(path, data);
    cache.delete(path);
  });
  writes.set(path, next);
  await next;
}

/**
 * What a role runs on now. `provider` is the provider of the work a following role judges. `override` is an item's
 * own model choice where one wins over the role (a Slack or GitHub rule's model for its reply-intent judgment), when the
 * role runs on the item's provider.
 */
export async function resolveModel(stateDir: string, role: string, context: { provider?: ModelProvider; override?: { provider: ModelProvider; model?: string; effort?: string } } = {}): Promise<ResolvedModel> {
  const resolved = resolveRole(await readModelSettings(stateDir), role, context);
  // An item's model belongs to its own provider: it wins only while the role runs on that provider.
  if (!context.override?.model || context.override.provider !== resolved.provider) return resolved;
  return { provider: resolved.provider, model: context.override.model, ...(context.override.effort ? { effort: context.override.effort } : {}) };
}
