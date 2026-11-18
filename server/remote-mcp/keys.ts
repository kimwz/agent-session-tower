import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { REMOTE_MCP_SCOPES, type RemoteMcpKeyView, type RemoteMcpScope } from '../../shared/remote-mcp.js';
import { TowerError } from '../../shared/errors.js';
import { quarantineFile, readPrivateJson, writePrivateJson } from '../stores/private-json.js';

export const REMOTE_MCP_KEYS_FILE = 'remote-mcp-keys.json';
export const MAX_REMOTE_MCP_KEYS = 20;
const KEY = /^tower_mcp_[A-Za-z0-9_-]{43}$/;
/** Last use is kept in memory at once and written at most this often, so busy clients do not rewrite the file. */
const LAST_USED_WRITE_MS = 5 * 60_000;

const Record = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(60), scope: z.enum(REMOTE_MCP_SCOPES),
  hash: z.string().regex(/^[a-f0-9]{64}$/), hint: z.string().max(8), createdAt: z.string().datetime(), lastUsedAt: z.string().datetime().optional(),
}).strict();
type KeyRecord = z.infer<typeof Record>;
const File = z.object({ version: z.literal(1), keys: z.array(Record).max(MAX_REMOTE_MCP_KEYS) }).strict();

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');
const view = ({ hash: _hash, ...record }: KeyRecord): RemoteMcpKeyView => record;

/**
 * The keys that let the owner's outside MCP clients use Tower through `/mcp` on its public HTTPS address. Only their
 * hashes are kept, in an owner-only file of the state directory; a key is shown once, when it is made.
 */
export class RemoteMcpKeys {
  private keys: KeyRecord[] = [];
  private byHash = new Map<string, KeyRecord>();
  private error?: string;
  private writing: Promise<unknown> = Promise.resolve();
  private lastWrite = 0;

  private constructor(private readonly path: string) {}

  /** Reads the saved keys. A file this build cannot read is set aside and reported, and no key works until new ones are made. */
  static async open(stateDir: string, log: (message: string) => void = console.warn): Promise<RemoteMcpKeys> {
    const store = new RemoteMcpKeys(join(stateDir, REMOTE_MCP_KEYS_FILE));
    let raw: unknown;
    try { raw = await readPrivateJson(store.path, 1_000_000); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      raw = undefined;
    }
    const parsed = File.safeParse(raw);
    if (parsed.success) { store.replace(parsed.data.keys); return store; }
    const aside = await quarantineFile(store.path).catch(() => undefined);
    store.error = aside ? `저장된 원격 MCP 키를 읽지 못해 ${aside}로 옮겼습니다. 키를 새로 만드세요.` : '저장된 원격 MCP 키를 읽지 못했습니다. 키를 새로 만드세요.';
    log(`[remote-mcp] ${store.error}`);
    return store;
  }

  list(): { keys: RemoteMcpKeyView[]; error?: string } { return { keys: this.keys.map(view), ...(this.error ? { error: this.error } : {}) }; }

  /** The key's record when `presented` is a current key; the time it was used is noted. */
  verify(presented: unknown): RemoteMcpKeyView | undefined {
    if (typeof presented !== 'string' || !KEY.test(presented)) return undefined;
    const record = this.byHash.get(hashOf(presented));
    if (!record) return undefined;
    const now = Date.now();
    record.lastUsedAt = new Date(now).toISOString();
    if (now - this.lastWrite >= LAST_USED_WRITE_MS) {
      this.lastWrite = now;
      // Last use is bookkeeping: a failed write only leaves an older time on disk.
      void this.save().catch(error => console.warn(`[remote-mcp] 마지막 사용 시각을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`));
    }
    return view(record);
  }

  async create(input: { name: unknown; scope: unknown }): Promise<{ key: string; created: RemoteMcpKeyView }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new TowerError('invalid', '키 이름은 1~60자로 정하세요.');
    if (!REMOTE_MCP_SCOPES.includes(input.scope as RemoteMcpScope)) throw new TowerError('invalid', '권한은 read 또는 write입니다.');
    if (this.keys.length >= MAX_REMOTE_MCP_KEYS) throw new TowerError('conflict', `원격 MCP 키는 ${MAX_REMOTE_MCP_KEYS}개까지 만들 수 있습니다. 쓰지 않는 키를 폐기하세요.`);
    const key = `tower_mcp_${randomBytes(32).toString('base64url')}`;
    const record: KeyRecord = { id: randomUUID(), name, scope: input.scope as RemoteMcpScope, hash: hashOf(key), hint: key.slice(-4), createdAt: new Date().toISOString() };
    const previous = this.keys;
    this.replace([...this.keys, record]);
    try { await this.save(); }
    catch (error) { this.replace(previous); throw error; }
    this.error = undefined;
    return { key, created: view(record) };
  }

  /** Revoked at once: the key stops working before the file is written. */
  async revoke(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !this.keys.some(record => record.id === id)) throw new TowerError('not-found', '원격 MCP 키를 찾을 수 없습니다.');
    this.replace(this.keys.filter(record => record.id !== id));
    await this.save();
  }

  /** Waits for writes under way; for tests and shutdown. */
  async flush(): Promise<void> { await this.writing; }

  private replace(keys: KeyRecord[]): void {
    this.keys = keys;
    this.byHash = new Map(keys.map(record => [record.hash, record]));
  }

  /** Writes are queued, each writing the keys as they are when it runs. */
  private save(): Promise<void> {
    const next = this.writing.catch(() => {}).then(() => writePrivateJson(this.path, `${JSON.stringify({ version: 1, keys: this.keys } satisfies z.infer<typeof File>, null, 2)}\n`));
    this.writing = next;
    return next;
  }
}
