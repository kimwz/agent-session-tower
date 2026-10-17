import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { TowerError } from '../../shared/errors.js';
import type { TodoRestoreProgress } from '../../shared/todo/types.js';
import { todoFilePath, type TodoFiles } from './files.js';
import type { TodoStore, TodoTables } from './store.js';

/**
 * The todos in Tower's backups. The rows go into the backup itself (`web.todos`, encrypted with its passphrase); the
 * attachments, too large for it, go beside it as objects encrypted with this computer's own key, which only the
 * backup carries. So a changed passphrase never makes them upload again, and every backup opens its attachments.
 *
 * Objects are `<prefix>tower-todo-files/<namespace>/<sha256>/<i>-of-<n>`: pieces of at most 8 MiB, each sealed with
 * AES-256-GCM over `sha256|i|n`. The namespace is `<host>-<machine>-<key id>`, so a new key (a new file) never reuses
 * or overwrites objects another key sealed. Beside each backup, `<backup>.todo-files` (sealed with the key) lists the
 * objects it needs; this computer's objects that neither its file nor a backup still there needs are removed.
 *
 * The backup service gives the bucket (TodoObjectStore); this module never reaches into the backup's own code.
 */

/** A bucket as the backup service reaches it. */
export interface TodoObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  /** Fails for a missing object. */
  get(key: string, maxBytes: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** The keys under `prefix`, and whether the listing reached its end. */
  scan(prefix: string): Promise<{ keys: string[]; complete: boolean }>;
}

/** The todos part of a backup (`web.todos`). `files` says where its attachments are and opens them. */
export interface TodoBackupPart { schema: number; tables: TodoTables; files?: { namespace: string; key: string } }

/** A backup being made: its part, and the attachments its rows name (sha256 → size). */
export interface TodoBackupSnapshot { part: TodoBackupPart; contents: Map<string, number> }

export const TODO_FILES_FOLDER = 'tower-todo-files/';
/** What follows a backup's key in the name of the list of objects it needs. */
export const TODO_SIDECAR = '.todo-files';
const PIECE_BYTES = 8 * 1024 * 1024;
const SEAL_BYTES = 12 + 16;
const MAX_SIDECAR_BYTES = 32 * 1024 * 1024;
const NAMESPACE = /^[a-z0-9-]{1,80}-[0-9a-f]{16}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const pieceName = (sha256: string, index: number, count: number) => `${sha256}/${index}-of-${count}`;
const baseName = (key: string) => key.slice(key.lastIndexOf('/') + 1);

function seal(key: Buffer, label: string, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(label));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function unseal(key: Buffer, label: string, sealed: Buffer): Buffer {
  if (sealed.length < SEAL_BYTES) throw new TowerError('invalid', '첨부 파일 백업 조각이 손상되었습니다.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(label));
    decipher.setAuthTag(sealed.subarray(12, SEAL_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(SEAL_BYTES)), decipher.final()]);
  } catch { throw new TowerError('invalid', '첨부 파일 백업 조각을 열지 못했습니다.'); }
}

/** The contents whose every piece is listed, with their piece count, from keys under `base`. */
function wholeContents(keys: string[], base: string): Map<string, number> {
  const pieces = new Map<string, Set<number>>();
  for (const key of keys) {
    const found = key.startsWith(base) ? /^([0-9a-f]{64})\/(\d{1,6})-of-(\d{1,6})$/.exec(key.slice(base.length)) : null;
    if (!found) continue;
    const id = `${found[1]}|${found[3]}`;
    pieces.set(id, (pieces.get(id) ?? new Set()).add(Number(found[2])));
  }
  const whole = new Map<string, number>();
  for (const [id, seen] of pieces) {
    const [sha256, count] = [id.slice(0, 64), Number(id.slice(65))];
    if (count >= 1 && seen.size === count && [...seen].every(index => index >= 1 && index <= count)) whole.set(sha256, count);
  }
  return whole;
}

/** A backup's todos part, checked for its shape; the store checks the rows themselves when it restores them. */
export function parseTodoPart(value: unknown): TodoBackupPart {
  const wrong = () => new TowerError('invalid', '백업의 할 일이 올바르지 않습니다.');
  if (!record(value) || !Number.isSafeInteger(value.schema) || (value.schema as number) < 1 || !record(value.tables)) throw wrong();
  const tables: TodoTables = {};
  for (const [name, rows] of Object.entries(value.tables)) {
    if (!Array.isArray(rows) || !rows.every(record)) throw wrong();
    tables[name] = rows as Record<string, unknown>[];
  }
  const files = value.files;
  if (files !== undefined && !(record(files) && typeof files.namespace === 'string' && NAMESPACE.test(files.namespace) && typeof files.key === 'string' && KEY.test(files.key))) throw wrong();
  return { schema: value.schema as number, tables, ...(files ? { files: { namespace: files.namespace as string, key: files.key as string } } : {}) };
}

export interface TodoBackupOptions {
  /** The size of an attachment's pieces (tests make it small). */
  pieceBytes?: number;
  /** The page's snapshot shows what changed (attachments brought back). */
  onChange?: () => void;
}

export class TodoBackup {
  private readonly pieceBytes: number;
  private bringing?: { stop: AbortController; done: Promise<void> };

  constructor(private readonly store: TodoStore, private readonly files: TodoFiles, private readonly stateDir: string, private readonly options: TodoBackupOptions = {}) {
    this.pieceBytes = options.pieceBytes ?? PIECE_BYTES;
  }

  /** The todos part of a backup and the attachments it names, read at one moment; undefined when the todos cannot be read. */
  snapshot(computer: string): TodoBackupSnapshot | undefined {
    const data = this.store.backupData();
    if (!data) return undefined;
    const files = data.key ? { namespace: `${computer}-${keyId(Buffer.from(data.key, 'base64url'))}`, key: data.key } : undefined;
    return { part: { schema: data.schema, tables: data.tables, ...(files ? { files } : {}) }, contents: data.contents };
  }

  /**
   * Uploads the attachments a backup names that its namespace lacks (all of them when the namespace cannot be
   * listed), and answers the list of objects to keep beside the backup `backupKey`, and whether the namespace was
   * listed in full. Contents missing on this computer are left out.
   */
  async upload(objects: TodoObjectStore, prefix: string, snapshot: TodoBackupSnapshot, backupKey: string): Promise<{ sidecar?: Buffer; listed: boolean }> {
    const files = snapshot.part.files;
    if (!files) return { listed: false };
    const key = Buffer.from(files.key, 'base64url');
    const base = `${prefix}${TODO_FILES_FOLDER}${files.namespace}/`;
    let present = new Map<string, number>(), listed = false;
    try {
      const listing = await objects.scan(base);
      present = wholeContents(listing.keys, base);
      listed = listing.complete;
    } catch (error) { console.warn(`Todo attachments in the backup could not be listed; all are uploaded: ${error instanceof Error ? error.message : String(error)}`); }
    const kept: string[] = [];
    for (const [sha256, size] of snapshot.contents) {
      if (present.has(sha256)) { kept.push(sha256); continue; }
      if (!await this.files.hasContent(sha256, size)) continue;
      if (await this.uploadContent(objects, base, key, sha256, size)) kept.push(sha256);
    }
    const sidecar = seal(key, `sidecar|${baseName(backupKey)}`, Buffer.from(JSON.stringify({ version: 1, files: [{ namespace: files.namespace, sha256: kept }] })));
    return { sidecar, listed };
  }

  /** Uploads one attachment in sealed pieces; false (and nothing listed for it) when its contents are not what its name says. */
  private async uploadContent(objects: TodoObjectStore, base: string, key: Buffer, sha256: string, size: number): Promise<boolean> {
    const count = Math.max(1, Math.ceil(size / this.pieceBytes));
    const handle = await open(todoFilePath(this.stateDir, sha256), constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    try {
      for (let index = 1; index <= count; index++) {
        const piece = Buffer.alloc(Math.min(this.pieceBytes, size - (index - 1) * this.pieceBytes));
        const { bytesRead } = await handle.read(piece, 0, piece.length, (index - 1) * this.pieceBytes);
        if (bytesRead !== piece.length) throw new TowerError('internal', `첨부 파일 ${sha256}이(가) 기록보다 짧습니다.`);
        hash.update(piece);
        await objects.put(`${base}${pieceName(sha256, index, count)}`, seal(key, `${sha256}|${index}|${count}`, piece));
      }
    } finally { await handle.close(); }
    if (hash.digest('hex') === sha256) return true;
    console.error(`Todo attachment ${sha256} on this computer does not match its name; the backup does not count on it.`);
    return false;
  }

  /**
   * Removes this computer's attachment objects (`<computer>-*` namespaces) that neither its file names (in the current
   * namespace) nor any backup still there lists. Skipped, answering why, when the file cannot say what it names, a
   * backup's list cannot be read, or a listing is incomplete.
   */
  async cleanup(objects: TodoObjectStore, prefix: string, computer: string, backups: string[]): Promise<string | undefined> {
    const named = this.store.fileContents();
    const key = this.store.filesKey();
    if (!named || !key) return 'the todo file cannot say which attachments it names';
    const current = `${computer}-${keyId(Buffer.from(key, 'base64url'))}`;
    const keep = new Set([...named.keys()].map(sha256 => `${current}/${sha256}`));
    for (const backup of backups) {
      let list: unknown;
      try { list = JSON.parse(unseal(Buffer.from(key, 'base64url'), `sidecar|${baseName(backup)}`, await objects.get(`${backup}${TODO_SIDECAR}`, MAX_SIDECAR_BYTES)).toString('utf8')); }
      catch { return `the attachment list of ${baseName(backup)} cannot be read`; }
      if (!record(list) || !Array.isArray(list.files)) return `the attachment list of ${baseName(backup)} is not valid`;
      for (const entry of list.files) {
        if (!record(entry) || typeof entry.namespace !== 'string' || !Array.isArray(entry.sha256)) return `the attachment list of ${baseName(backup)} is not valid`;
        for (const sha256 of entry.sha256) keep.add(`${entry.namespace}/${String(sha256)}`);
      }
    }
    const base = `${prefix}${TODO_FILES_FOLDER}${computer}-`;
    const listing = await objects.scan(base);
    if (!listing.complete) return 'the attachment objects could not be listed in full';
    for (const item of listing.keys) {
      // Exactly this computer's: another whose name starts the same has more before its key id.
      const found = /^([0-9a-f]{16})\/([0-9a-f]{64})\/\d{1,6}-of-\d{1,6}$/.exec(item.slice(base.length));
      if (found && !keep.has(`${computer}-${found[1]}/${found[2]}`)) await objects.delete(item);
    }
    return undefined;
  }

  /**
   * Replaces the todos with a backup's part, then brings back the attachments this computer lacks from where the
   * backup put them, in the background (see TodoOverview.restore). Answers where the file was copied first.
   */
  async restore(value: unknown, objects: () => TodoObjectStore, prefix: string): Promise<{ before: string }> {
    const part = parseTodoPart(value);
    this.close();
    const before = await this.files.contentTurnOf(() => this.store.restoreData(part.schema, part.tables));
    const stop = new AbortController();
    const done = this.bringBack(part, objects, prefix, stop.signal).catch(error => console.error(`Todo attachments of the restored backup could not be brought back: ${error instanceof Error ? error.message : String(error)}`));
    this.bringing = { stop, done };
    return { before };
  }

  /** Settles when the attachments of the last restore are back, or given up on. */
  async downloads(): Promise<void> { await this.bringing?.done; }

  /** Stops bringing back attachments; what is back stays. */
  close(): void { this.bringing?.stop.abort(); }

  private async bringBack(part: TodoBackupPart, objects: () => TodoObjectStore, prefix: string, signal: AbortSignal): Promise<void> {
    const wanted: [string, number][] = [];
    for (const [sha256, size] of this.store.fileContents() ?? []) if (!await this.files.hasContent(sha256, size)) wanted.push([sha256, size]);
    const progress: TodoRestoreProgress = { state: 'downloading', total: wanted.length, missing: 0 };
    this.store.setRestoreProgress(progress);
    const files = part.files;
    if (wanted.length && files) {
      const key = Buffer.from(files.key, 'base64url');
      const base = `${prefix}${TODO_FILES_FOLDER}${files.namespace}/`;
      let bucket: TodoObjectStore | undefined, counts = new Map<string, number>(), listed = false;
      try {
        bucket = objects();
        const listing = await bucket.scan(base);
        counts = wholeContents(listing.keys, base);
        listed = listing.complete;
      } catch (error) { console.warn(`Todo attachments of the restored backup could not be listed: ${error instanceof Error ? error.message : String(error)}`); }
      for (const [sha256, size] of wanted) {
        if (signal.aborted) return;
        // Listed in full, a content not there is not in the bucket; otherwise it is asked for as this build would have stored it.
        const count = counts.get(sha256) ?? (listed ? undefined : Math.max(1, Math.ceil(size / this.pieceBytes)));
        try {
          if (!bucket || count === undefined) throw new TowerError('not-found', 'not in the backup');
          if (!await this.files.hasContent(sha256, size)) await this.files.importContent(sha256, size, this.pieces(bucket, base, key, sha256, count, signal));
        } catch (error) {
          if (signal.aborted) return;
          progress.missing++;
          if (!(error instanceof TowerError && error.kind === 'not-found')) console.warn(`Todo attachment ${sha256} could not be brought back: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.store.setRestoreProgress(progress);
      }
    } else progress.missing = wanted.length;
    progress.state = progress.missing ? 'partial' : 'done';
    this.store.setRestoreProgress(progress);
    this.store.touch();
    this.options.onChange?.();
  }

  private async *pieces(bucket: TodoObjectStore, base: string, key: Buffer, sha256: string, count: number, signal: AbortSignal): AsyncGenerator<Buffer> {
    for (let index = 1; index <= count; index++) {
      if (signal.aborted) throw new TowerError('unavailable', 'stopped');
      yield unseal(key, `${sha256}|${index}|${count}`, await bucket.get(`${base}${pieceName(sha256, index, count)}`, Math.max(this.pieceBytes, PIECE_BYTES) + SEAL_BYTES));
    }
  }
}
