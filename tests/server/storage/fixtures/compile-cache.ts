import { createHash } from 'node:crypto';

const directoryToken = '__TOWER_PRIVATE_FIXTURE_DIRECTORY__';
const encoded = (text: string) => JSON.stringify(text).slice(1, -1);

/** A test process has one fixed checkout. Only compiled strings are shared, never modules or live state. */
export class FixtureCompileCache {
  private readonly entries = new Map<string, Promise<string>>();
  constructor(private readonly limit = 32) {}

  async compile(entry: string, directory: string, profile: string, build: (source: string) => Promise<string>, reuse = true): Promise<string> {
    if (!reuse) return build(entry);
    if (entry.includes(directoryToken)) throw new Error('Fixture source contains the reserved directory token');
    const normalized = entry.replaceAll(encoded(directory), directoryToken);
    const key = createHash('sha256').update(profile).update('\0').update(normalized).digest('hex');
    let result = this.entries.get(key);
    if (!result) {
      result = build(normalized);
      this.entries.set(key, result);
      while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
      result.catch(() => { if (this.entries.get(key) === result) this.entries.delete(key); });
    } else {
      this.entries.delete(key);
      this.entries.set(key, result);
    }
    return (await result).replaceAll(directoryToken, encoded(directory));
  }
}

export const fixtureCompileCache = new FixtureCompileCache();
