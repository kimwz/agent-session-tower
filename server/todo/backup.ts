import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { TowerError } from '../../shared/errors.js';
import type { TodoRestoreProgress } from '../../shared/todo/types.js';
import type { TodoFiles } from './files.js';
import type { TodoStore, TodoTables } from './store.js';

/**
 * The todos in Tower's backups. The rows go into the backup itself (`web.todos`, encrypted with its passphrase); the
 * attachments, too large for it, go beside it as objects encrypted with this computer's own key, which only the
 * backup carries. So a changed passphrase never makes them upload again, and every backup opens its attachments.
 *
 * Objects are `<prefix>tower-todo-files/<namespace>/<sha256>/<i>-of-<n>`: pieces of at most 8 MiB, each sealed with
 * AES-256-GCM over `sha256|i|n`. The namespace is `<host>-<machine>-<key id>`, so a new key (a new file) never reuses
 * or overwrites objects another key sealed. Objects already there are not sent again, and Tower never removes any:
 * a backup that could not hold all its todos (see `upload`) instead keeps older backups from being removed.
 *
 * The backup service gives the bucket (TodoObjectStore); this module never reaches into the backup's own code.
 */

/** A bucket as the backup service reaches it. */
export interface TodoObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  /** Fails for a missing object. */
  get(key: string, maxBytes: number): Promise<Buffer>;
  /** The keys under `prefix`, and whether the listing reached its end. */
  scan(prefix: string): Promise<{ keys: string[]; complete: boolean }>;
}

/**
 * The todos part of a backup (`web.todos`). `files` says where its attachments are and opens them; `exported` marks a
 * downloaded backup, whose attachments only an automatic backup put in the bucket.
 */
export interface TodoBackupPart { schema: number; tables: TodoTables; files?: { namespace: string; key: string }; exported?: true }

/** A backup being made: its part, and the attachments its rows name (sha256 → size). */
export interface TodoBackupSnapshot { part: TodoBackupPart; contents: Map<string, number> }

export const TODO_FILES_FOLDER = 'tower-todo-files/';
const PIECE_BYTES = 8 * 1024 * 1024;
/** Attachments the bucket refuses one after another before the rest of a round's are given up. */
const REFUSALS_IN_A_ROW = 3;
const SEAL_BYTES = 12 + 16;
const NAMESPACE = /^[a-z0-9-]{1,80}-[0-9a-f]{16}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const pieceName = (sha256: string, index: number, count: number) => `${sha256}/${index}-of-${count}`;

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
  /** Counts restores that replaced the todos; a backup round started before one does not speak for what is there now. */
  private restores = 0;
  /** The last restore's attachments being brought back; `active` until that ends or another restore replaces it. */
  private bringing?: { stop: AbortController; done: Promise<void>; active: boolean };

  constructor(private readonly store: TodoStore, private readonly files: TodoFiles, private readonly options: TodoBackupOptions = {}) {
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
   * Uploads the attachments a backup names that its namespace lacks (all of them when it cannot be listed). Answers
   * what the backup could not hold: contents damaged here (`damaged`: not what their hash says, so the copies already
   * in the bucket stay as they are), contents that could not be read or sent (`failed`), and contents neither here nor
   * in the namespace (`missing`). A failure of one object leaves the others to try; a bucket that does not answer at all
   * (an error marked `unreachable`), or refuses several in a row, fails the rest of them at once. Once `signal` says Tower is stopping, a failure is
   * the backup's.
   */
  async upload(objects: TodoObjectStore, prefix: string, snapshot: TodoBackupSnapshot, signal?: AbortSignal): Promise<{ damaged: string[]; failed: string[]; missing: string[] }> {
    const files = snapshot.part.files;
    const damaged: string[] = [], failed: string[] = [], missing: string[] = [];
    if (!files) return { damaged, failed, missing: [...snapshot.contents.keys()] };
    const key = Buffer.from(files.key, 'base64url');
    const base = `${prefix}${TODO_FILES_FOLDER}${files.namespace}/`;
    let present = new Map<string, number>();
    try { present = wholeContents((await objects.scan(base)).keys, base); }
    catch (error) { console.warn(`Todo attachments in the backup could not be listed; all are uploaded: ${error instanceof Error ? error.message : String(error)}`); }
    const wanted = [...snapshot.contents].filter(([sha256]) => !present.has(sha256));
    let refused = 0;
    for (const [index, [sha256, size]] of wanted.entries()) {
      try {
        if (!await this.files.hasContent(sha256, size)) missing.push(sha256);
        else if (!await this.uploadContent(objects, base, key, sha256, size)) damaged.push(sha256);
        else refused = 0;
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`Todo attachment ${sha256} was not backed up: ${error instanceof Error ? error.message : String(error)}`);
        // A bucket that does not answer, or refuses several in a row, would refuse the rest too.
        if ((error as { unreachable?: boolean }).unreachable || ++refused >= REFUSALS_IN_A_ROW) { failed.push(...wanted.slice(index).map(([item]) => item)); break; }
        failed.push(sha256);
      }
    }
    return { damaged, failed, missing };
  }

  /** Moves each time a restore replaces the todos. */
  generation(): number { return this.restores; }

  /** Whether a restore is still bringing attachments back: a backup made now would not hold them. */
  restoring(): boolean { return Boolean(this.bringing?.active); }

  /**
   * Uploads one attachment in sealed pieces. Its contents are checked against their hash before anything is sent:
   * pieces of damaged contents would replace good ones an earlier backup needs. False when they do not match.
   */
  private async uploadContent(objects: TodoObjectStore, base: string, key: Buffer, sha256: string, size: number): Promise<boolean> {
    const count = Math.max(1, Math.ceil(size / this.pieceBytes));
    const handle = await this.files.openContent(sha256, size);
    try {
      const whole = createHash('sha256');
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) whole.update(chunk as Buffer);
      if (whole.digest('hex') !== sha256) {
        console.error(`Todo attachment ${sha256} on this computer does not match its name; it was not backed up.`);
        return false;
      }
      const hash = createHash('sha256');
      for (let index = 1; index <= count; index++) {
        const piece = Buffer.alloc(Math.min(this.pieceBytes, size - (index - 1) * this.pieceBytes));
        const { bytesRead } = await handle.read(piece, 0, piece.length, (index - 1) * this.pieceBytes);
        if (bytesRead !== piece.length) throw new TowerError('internal', `첨부 파일 ${sha256}이(가) 기록보다 짧습니다.`);
        hash.update(piece);
        await objects.put(`${base}${pieceName(sha256, index, count)}`, seal(key, `${sha256}|${index}|${count}`, piece));
      }
      if (hash.digest('hex') === sha256) return true;
      console.error(`Todo attachment ${sha256} changed while it was backed up; the backup does not count on it.`);
      return false;
    } finally { await handle.close(); }
  }

  /**
   * Replaces the todos with a backup's part, then brings back the attachments this computer lacks from where the
   * backup put them, in the background (see TodoOverview.restore). Answers where the file was copied first.
   */
  async restore(value: unknown, objects: () => TodoObjectStore, prefix: string): Promise<{ before: string }> {
    const part = parseTodoPart(value);
    const before = await this.files.contentTurnOf(() => this.store.restoreData(part.schema, part.tables));
    this.restores++;
    // Only once these rows are in does the earlier restore's bringing back stop: a refused restore leaves it going.
    this.close();
    const stop = new AbortController();
    const bringing = { stop, done: Promise.resolve(), active: true };
    const progress: TodoRestoreProgress & { fetched?: number } = { state: 'downloading', total: 0, missing: 0 };
    bringing.done = this.bringBack(part, objects, prefix, stop.signal, progress)
      .catch(error => {
        console.error(`Todo attachments of the restored backup could not be brought back: ${error instanceof Error ? error.message : String(error)}`);
        // Whatever stopped it, the page is not left waiting: what was not brought back counts as missing.
        if (stop.signal.aborted) return;
        progress.state = 'partial';
        progress.missing = progress.total - (progress.fetched ?? 0);
        this.store.setRestoreProgress(progress);
      })
      .finally(() => { bringing.active = false; });
    this.bringing = bringing;
    return { before };
  }

  /** Settles when the attachments of the last restore are back, or given up on. */
  async downloads(): Promise<void> { await this.bringing?.done; }

  /** Stops bringing back attachments; what is back stays. */
  close(): void { if (this.bringing) { this.bringing.stop.abort(); this.bringing.active = false; } }

  private async bringBack(part: TodoBackupPart, objects: () => TodoObjectStore, prefix: string, signal: AbortSignal, progress: TodoRestoreProgress & { fetched?: number }): Promise<void> {
    // Each step that shows something first checks this restore is still the last one: a later one owns the page.
    const show = (progress: TodoRestoreProgress) => { if (!signal.aborted) this.store.setRestoreProgress(progress); };
    const wanted: [string, number][] = [];
    // Contents here that are not what their hash says (damaged, or replaced in place) are brought back too.
    for (const [sha256, size] of this.store.fileContents() ?? []) {
      if (!await this.verified(sha256, size)) wanted.push([sha256, size]);
      if (signal.aborted) return;
    }
    progress.total = wanted.length;
    progress.fetched = 0;
    show(progress);
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
          if (!await this.verified(sha256, size)) await this.files.importContent(sha256, size, this.pieces(bucket, base, key, sha256, count, signal));
          progress.fetched!++;
        } catch (error) {
          if (signal.aborted) return;
          progress.missing++;
          if (!(error instanceof TowerError && error.kind === 'not-found')) console.warn(`Todo attachment ${sha256} could not be brought back: ${error instanceof Error ? error.message : String(error)}`);
        }
        show(progress);
      }
    } else progress.missing = wanted.length;
    if (signal.aborted) return;
    progress.state = progress.missing ? 'partial' : 'done';
    show(progress);
    this.store.touch();
    this.options.onChange?.();
  }

  /** Whether local contents are there and right; one that cannot be read counts as not, so it is fetched again. */
  private verified(sha256: string, size: number): Promise<boolean> {
    return this.files.verifyContent(sha256, size).catch(error => {
      console.warn(`Todo attachment ${sha256} on this computer could not be checked; it is brought back: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
  }

  private async *pieces(bucket: TodoObjectStore, base: string, key: Buffer, sha256: string, count: number, signal: AbortSignal): AsyncGenerator<Buffer> {
    for (let index = 1; index <= count; index++) {
      if (signal.aborted) throw new TowerError('unavailable', 'stopped');
      yield unseal(key, `${sha256}|${index}|${count}`, await bucket.get(`${base}${pieceName(sha256, index, count)}`, Math.max(this.pieceBytes, PIECE_BYTES) + SEAL_BYTES));
    }
  }
}
