import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretInput } from '../../shared/triggers.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

export interface StoredSecret { id: string; name: string; origin: string; value: string; createdAt: string }
const MAX_SECRETS = 50;

const valid = (item: unknown): item is StoredSecret => !!item && typeof item === 'object'
  && ['id', 'name', 'origin', 'value', 'createdAt'].every(key => typeof (item as Record<string, unknown>)[key] === 'string');

/**
 * Header values for HTTP triggers, in an owner-only file apart from trigger definitions. Values are
 * read only to send a request; no operation returns them.
 */
export class SecretStore {
  private secrets = new Map<string, StoredSecret>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly stateDir: string) {}
  private get path() { return join(this.stateDir, 'trigger-secrets.json'); }

  async load(): Promise<void> {
    let saved: unknown;
    try { saved = await readPrivateJson(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Kept aside rather than overwritten, so an unreadable file never silently loses the owner's values.
      console.error('Trigger secrets could not be read and were moved aside:', error);
      await rename(this.path, `${this.path}.unreadable-${Date.now()}`).catch(() => {});
      return;
    }
    for (const item of Array.isArray(saved) ? saved : []) if (valid(item)) this.secrets.set(item.id, item);
  }

  get(id: string): StoredSecret | undefined { return this.secrets.get(id); }
  list(): Array<Omit<StoredSecret, 'value'>> {
    return [...this.secrets.values()].map(({ value: _value, ...secret }) => secret).sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(input: SecretInput, now: number): Promise<Omit<StoredSecret, 'value'>> {
    const secret: StoredSecret = { id: randomUUID(), name: input.name, origin: input.origin, value: input.value, createdAt: new Date(now).toISOString() };
    await this.update(next => {
      if (next.size >= MAX_SECRETS) throw Object.assign(new Error(`At most ${MAX_SECRETS} secrets can be saved. Delete one first.`), { statusCode: 409 });
      next.set(secret.id, secret);
    });
    const { value: _value, ...shown } = secret;
    return shown;
  }

  async remove(id: string): Promise<Omit<StoredSecret, 'value'>> {
    const secret = await this.update(next => {
      const found = next.get(id);
      if (!found) throw Object.assign(new Error('Secret not found.'), { statusCode: 404 });
      next.delete(id);
      return found;
    });
    const { value: _value, ...shown } = secret;
    return shown;
  }

  /** Changes apply one at a time to a copy; only a saved copy becomes current. */
  private update<T>(change: (next: Map<string, StoredSecret>) => T): Promise<T> {
    const write = this.writes.catch(() => {}).then(async () => {
      const next = new Map(this.secrets);
      const result = change(next);
      await writePrivateJson(this.path, JSON.stringify([...next.values()]));
      this.secrets = next;
      return result;
    });
    this.writes = write;
    return write;
  }
}
