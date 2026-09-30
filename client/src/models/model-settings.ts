import { useCallback, useEffect, useState } from 'react';
import { resolveRole, type ModelSettings, type ResolvedModel, type RoleSetting } from '../../../shared/models';
import type { ProviderHealth } from '../../../shared/types';
import { towerOperation } from '../triggers/trigger-helpers';

/**
 * Each computer's model settings (Settings › Models), read once per page and shared by every form that starts from
 * them. A computer whose Tower predates them has none, and its forms keep their own defaults.
 */
const cache = new Map<string, ModelSettings>();
const loading = new Map<string, Promise<ModelSettings | undefined>>();
const listeners = new Set<() => void>();
const keyOf = (node?: string) => node ?? '';
const notify = () => { for (const listener of listeners) listener(); };

export function loadModelSettings(token: string, node?: string, force = false): Promise<ModelSettings | undefined> {
  const key = keyOf(node);
  if (!token) return Promise.resolve(cache.get(key));
  if (!force && cache.has(key)) return Promise.resolve(cache.get(key));
  const pending = !force && loading.get(key);
  if (pending) return pending;
  const next = towerOperation<{ settings: ModelSettings }>(token, 'models.settings', {}, node)
    .then(result => { cache.set(key, result.settings); notify(); return result.settings; })
    .finally(() => { if (loading.get(key) === next) loading.delete(key); });
  loading.set(key, next);
  return next;
}

export async function saveModelSettings(token: string, settings: ModelSettings, node?: string): Promise<ModelSettings> {
  const result = await towerOperation<{ settings?: ModelSettings }>(token, 'models.update', { settings }, node);
  // A retried save on another computer answers only that it was done; the settings are read again then.
  if (!result?.settings) return (await loadModelSettings(token, node, true))!;
  cache.set(keyOf(node), result.settings);
  notify();
  return result.settings;
}

export function useModelSettings(token: string, node?: string): { settings?: ModelSettings; error?: string; reload: () => void } {
  const [settings, setSettings] = useState(() => cache.get(keyOf(node)));
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    setError(undefined);
    loadModelSettings(token, node, true).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [token, node]);
  useEffect(() => {
    const update = () => setSettings(cache.get(keyOf(node)));
    listeners.add(update);
    update();
    setError(undefined);
    loadModelSettings(token, node).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { listeners.delete(update); };
  }, [token, node]);
  return { settings, error, reload };
}

/**
 * What a form starts with for `role` on a computer: the role's choice, or, when that provider cannot be used there,
 * the first usable provider with the role's pick for it.
 */
export function presetFor(settings: ModelSettings | undefined, role: string, providers: readonly ProviderHealth[]): ResolvedModel | undefined {
  if (!settings) return undefined;
  const resolved = resolveRole(settings, role);
  if (!providers.length || providers.some(item => item.provider === resolved.provider && item.available)) return resolved;
  const other = providers.find(item => item.available)?.provider;
  if (!other) return resolved;
  return { provider: other, ...pickFor(settings, role, other) };
}

/** The preset for a form, available at once when this page already read the computer's settings. */
export function useModelPreset(token: string, node: string | undefined, role: string, providers: readonly ProviderHealth[]): ResolvedModel | undefined {
  const { settings } = useModelSettings(token, node);
  return presetFor(settings, role, providers);
}

/** The preset from settings this page already read, for a form's first state. */
export function cachedPreset(node: string | undefined, role: string, providers: readonly ProviderHealth[]): ResolvedModel | undefined {
  return presetFor(cache.get(keyOf(node)), role, providers);
}

/** The role's model and effort for one provider, whatever provider the role itself names: what a form uses when the owner switches provider. */
export function pickFor(settings: ModelSettings | undefined, role: string, provider: ResolvedModel['provider']): { model?: string; effort?: string } {
  if (!settings) return {};
  const setting: RoleSetting | undefined = (settings.roles as Record<string, RoleSetting>)[role] ?? settings.custom.find(item => item.id === role);
  const pick = setting?.[provider] ?? {};
  return { ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) };
}
export const cachedPick = (node: string | undefined, role: string, provider: ResolvedModel['provider']) => pickFor(cache.get(keyOf(node)), role, provider);
