import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const directoryToken = '__TOWER_PRIVATE_FIXTURE_DIRECTORY__';
const encoded = (text: string) => JSON.stringify(text).slice(1, -1);

/** One isolated CI job has one fixed checkout; its private disk cache lasts only that job. Only compiled strings are shared, never modules or live state. */
export class FixtureCompileCache {
  private readonly entries = new Map<string, Promise<string>>();
  constructor(private readonly limit = 128, private readonly directory?: string) {}

  private async compiled(key: string, entry: string, build: (source: string) => Promise<string>) {
    const file = this.directory && join(this.directory, `${key}.json`);
    if (file) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(saved.key, key); assert.equal(typeof saved.body, 'string');
        assert.equal(saved.sha256, createHash('sha256').update(saved.body).digest('hex'), 'fixture cache bytes changed');
        return saved.body as string;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const body = await build(entry);
    if (file) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ key, body, sha256: createHash('sha256').update(body).digest('hex') }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file); // atomic publication; racing builders compile the same immutable input
    }
    return body;
  }

  async compile(entry: string, directory: string, profile: string, build: (source: string) => Promise<string>, reuse = true): Promise<string> {
    if (!reuse) return build(entry);
    if (entry.includes(directoryToken)) throw new Error('Fixture source contains the reserved directory token');
    const normalized = entry.replaceAll(encoded(directory), directoryToken);
    const key = createHash('sha256').update(profile).update('\0').update(normalized).digest('hex');
    let result = this.entries.get(key);
    if (!result) {
      result = this.compiled(key, normalized, build);
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

export const fixtureCompileCache = new FixtureCompileCache(128, process.env.TOWER_FIXTURE_COMPILE_CACHE);
