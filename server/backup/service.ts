import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { BACKUP_EXTENSION, DEFAULT_BACKUP_SETTINGS, MAX_BACKUP_FILE_BYTES, type BackupOverview, type BackupPart, type BackupPreview, type BackupSettingsInput, type BackupStatus, type RemoteBackup, type RestoreReport } from '../../shared/backup.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { BackupError, checkPassphrase, decryptBackup, encryptBackup, readBackupHeader, type BackupHeader } from './crypto.js';
import { stageLegacyImport } from './secrets.js';
import { deferredSecretParts, encryptedVaultOf, machineKeyOf, stageVaultImport } from '../secrets/imports.js';
import { collectTriggers, collectWorkerFiles, parsePayload, payloadParts, WORKER_FILES, type BackupPayload, type WorkerSqlSettings } from './payload.js';
import type { TriggerBackup } from '../triggers/backup.js';
import type { SkillBackup } from '../skills/backup.js';
import { keepBefore, readReport, removePendingWorker, writePendingWorker, writeReport } from './restore-files.js';
import { S3Client, endpointUrl, unsafeKey } from './s3.js';
import { newerVersion } from '../link/service.js';
import type { TodoBackup, TodoBackupSnapshot, TodoObjectStore } from '../todo/backup.js';
import { mergeKeys, type TodoFileKey } from '../todo/store.js';

interface SavedSettings extends BackupSettingsInput { remote: BackupSettingsInput['remote'] & { secretAccessKey?: string } }
/** `machine`: this computer's own mark in backup names, so two computers with one name never remove each other's; never restored. */
interface SavedFile { version: 1; machine: string; settings: SavedSettings; status: Omit<BackupStatus, 'running'> }

/** What the backup needs from the rest of the web process. */
export interface BackupServiceOptions {
  stateDir: string;
  version: string;
  /** The worker's skills, guidance and their confirmations; throws while the worker cannot make them. */
  skills(): Promise<SkillBackup>;
  triggers(): Promise<TriggerBackup | undefined>;
  settings?: () => Promise<WorkerSqlSettings>;
  /** Why no backup can be made right now, if so. */
  unavailable?: () => string | undefined;
  /** Asks the worker to hand over to a new worker at its next quiet moment; false when it cannot. */
  restartWorker(): Promise<boolean>;
  stores: {
    groups: { backupValue(): unknown; restore(value: unknown): Promise<unknown> };
    exclusions: { backupValue(): unknown; restore(value: unknown): Promise<unknown> };
    decisions: { backupValue(): unknown; restore(value: unknown): Promise<unknown> };
  };
  /** The master host's settings call. */
  master?: (body: Record<string, unknown>) => Promise<unknown>;
  /** The owner's todos and their attachments; without it, backups leave todos out and restores report them. */
  todos?: TodoBackup;
  /** The page's snapshot shows what a restore changed (folder titles and the like). */
  onChange?: () => void;
  fetcher?: typeof fetch;
  now?: () => number;
  host?: string;
}

const HOUR = 60 * 60 * 1000;
const CHECK_EVERY = 10 * 60 * 1000;
const RETRY_AFTER = 30 * 60 * 1000;
const CHECKED_KEPT_MS = 10 * 60 * 1000;
const FILE = 'backup-settings.json';
/**
 * Every attachment key a backup from here has carried or a restore here brought: kept apart from the todo file, so a
 * lost todo file never makes later backups drop a key older ones carried, and apart from the settings, which older
 * builds rewrite. Restores add to it; nothing replaces it.
 */
const KEYS_FILE = 'todo-backup-keys.json';
const KEYS_FILE_MAX_BYTES = 256 * 1024 * 1024;
const KEYS_UNREADABLE = '첨부 키 파일(todo-backup-keys.json)을 읽을 수 없어 키를 더하지 못했고, 백업은 부분 백업으로 올라갑니다. 상태 폴더의 이 파일을 확인하세요.';
/** Files a restore may replace, copied aside first. Skills replaced go to Tower's skill trash as usual. */
const REPLACED = [...Object.keys(WORKER_FILES), 'skills.json', 'guidance', 'project-groups.json', 'remote-exclusions.json', 'decisions.json', FILE, join('master', 'settings.json'), join('master', 'elevenlabs-key.json')];

/** What ends the name of a partial backup: one that could not hold all the todos. */
const PARTIAL = `-partial${BACKUP_EXTENSION}`;
/** Partial backups kept, at least (or `keep` when that is more). */
const PARTIAL_KEPT = 30;
/** A backup name's time as one sortable string, the old names (to the second) and the new (to the millisecond) alike. */
const backupTime = (key: string) => { const found = /(\d{8}T\d{6})(\d{3})?Z/.exec(key.slice(key.lastIndexOf('/') + 1)); return found ? `${found[1]}${found[2] ?? '000'}` : ''; };
/** Attachment objects of one computer may be many more than its backups; they are listed this far. */
const TODO_OBJECTS_LISTED = 200_000;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value.trim() : undefined;

function parseSettings(value: unknown, current: SavedSettings): SavedSettings {
  if (!record(value) || !record(value.remote)) throw new BackupError('자동 백업 설정이 올바르지 않습니다.');
  const remote = value.remote;
  const endpoint = text(remote.endpoint, 500) ?? '', bucket = text(remote.bucket, 63) ?? '', prefix = text(remote.prefix, 200) ?? '', region = text(remote.region, 50) || 'auto', accessKeyId = text(remote.accessKeyId, 200) ?? '';
  if (endpoint) endpointUrl(endpoint);
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) throw new BackupError('버킷 이름이 올바르지 않습니다.');
  if (prefix.startsWith('/') || /[\0\\]/.test(prefix) || unsafeKey(prefix)) throw new BackupError('경로 접두어가 올바르지 않습니다.');
  const secret = typeof remote.secretAccessKey === 'string' && remote.secretAccessKey ? remote.secretAccessKey.trim() : current.remote.secretAccessKey;
  if (secret !== undefined && (secret.length > 500 || !secret)) throw new BackupError('비밀 액세스 키가 올바르지 않습니다.');
  const passphrase = typeof value.passphrase === 'string' && value.passphrase ? checkPassphrase(value.passphrase) : current.passphrase;
  const intervalHours = value.intervalHours, keep = value.keep;
  if (!Number.isInteger(intervalHours) || (intervalHours as number) < 1 || (intervalHours as number) > 168) throw new BackupError('백업 주기는 1~168시간이어야 합니다.');
  if (!Number.isInteger(keep) || (keep as number) < 1 || (keep as number) > 100) throw new BackupError('보관 개수는 1~100개여야 합니다.');
  const settings: SavedSettings = { enabled: value.enabled === true, remote: { endpoint, bucket, prefix, region, accessKeyId, ...(secret ? { secretAccessKey: secret } : {}) },
    ...(passphrase ? { passphrase } : {}), intervalHours: intervalHours as number, keep: keep as number };
  if (settings.enabled && !(endpoint && bucket && accessKeyId && secret && passphrase)) throw new BackupError('자동 백업을 켜려면 엔드포인트, 버킷, 액세스 키, 비밀 키, 암호를 모두 입력하세요.');
  return settings;
}

/**
 * Full backups of Tower's settings: made on request or on a schedule (encrypted, to an S3-compatible bucket), and
 * restored through the processes that hold them (see `apply`).
 */
export class BackupService {
  private saved: SavedFile = { version: 1, machine: randomBytes(3).toString('hex'), settings: structuredClone(DEFAULT_BACKUP_SETTINGS), status: {} };
  private writes: Promise<unknown> = Promise.resolve();
  private running?: Promise<string>;
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private readonly checked = new Map<string, { payload: BackupPayload; header: BackupHeader; passphrase: string; at: number }>();
  private readonly now: () => number;
  private readonly host: string;

  constructor(private readonly options: BackupServiceOptions) {
    this.now = options.now ?? Date.now;
    this.host = (options.host ?? hostname()).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tower';
  }
  private get path() { return join(this.options.stateDir, FILE); }

  /** The attachment keys kept in KEYS_FILE, as last written. */
  private todoKeys: TodoFileKey[] = [];
  private keyWrites: Promise<unknown> = Promise.resolve();

  /**
   * Reads the kept keys again. A file that cannot be read or understood is left exactly as it is (it may hold the only
   * copy of a key) and the keys are unavailable until it can be read: answers false then, logged, never thrown.
   */
  private async loadKeys(): Promise<boolean> {
    try {
      // Far above any real list (every restore of another key adds one entry of about 100 bytes).
      const value = await readPrivateJson(join(this.options.stateDir, KEYS_FILE), KEYS_FILE_MAX_BYTES);
      if (!record(value) || !Array.isArray(value.keys)) throw new Error('not a list of keys');
      this.todoKeys = mergeKeys([], (value.keys as unknown[]).filter((item): item is TodoFileKey => record(item) && typeof item.namespace === 'string' && typeof item.key === 'string'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`The kept attachment keys (${KEYS_FILE}) cannot be read; backups are partial until it can be: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      this.todoKeys = [];
    }
    return true;
  }


  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    await this.rememberKeys([]).catch(error => console.error(`The kept attachment keys could not be looked at: ${error instanceof Error ? error.message : String(error)}`));
    try {
      const value = await readPrivateJson(this.path) as Partial<SavedFile>;
      // This computer's mark survives settings that can no longer be read, so its old backups are still its own.
      if (record(value) && typeof value.machine === 'string' && /^[0-9a-f]{6}$/.test(value.machine)) this.saved.machine = value.machine;
      if (record(value) && record(value.settings)) {
        const settings = parseSettings({ ...value.settings, enabled: false }, value.settings as SavedSettings);
        this.saved = { version: 1, machine: typeof value.machine === 'string' && /^[0-9a-f]{6}$/.test(value.machine) ? value.machine : this.saved.machine,
          settings: { ...settings, enabled: value.settings.enabled === true }, status: record(value.status) ? value.status as SavedFile['status'] : {} };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { console.error(`Backup settings could not be read: ${error instanceof Error ? error.message : String(error)}`); return; }
      // The first start keeps this computer's mark, so its own backups are recognized after a restart.
      await this.change(() => {}).catch(error => console.error(`Backup settings could not be saved: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** Checks every ten minutes whether an automatic backup is due. */
  schedule(): void {
    const tick = () => { void this.runIfDue().catch(() => {}); };
    this.first = setTimeout(tick, 2 * 60 * 1000);
    this.timer = setInterval(tick, CHECK_EVERY);
    this.first.unref(); this.timer.unref();
  }
  /** Stops the schedule and any upload under way; the next start backs up again when due. */
  close(): void { if (this.first) clearTimeout(this.first); if (this.timer) clearInterval(this.timer); this.closing.abort(); }
  private readonly closing = new AbortController();
  async flush(): Promise<void> {
    await this.restores.catch(() => {}); await this.writes.catch(() => {}); await this.running?.catch(() => {});
    // best-effort: a key write's failure already reached the backup or restore that asked for it.
    await this.keyWrites.catch(() => {});
  }

  async overview(): Promise<BackupOverview> {
    const { passphrase, remote: { secretAccessKey, ...remote }, ...settings } = this.saved.settings;
    const restore = await readReport(this.options.stateDir);
    const unavailable = this.options.unavailable?.();
    return { settings: { ...settings, remote: { ...remote, secretSet: Boolean(secretAccessKey) }, passphraseSet: Boolean(passphrase) },
      status: { ...this.saved.status, running: Boolean(this.running) }, ...(restore ? { restore } : {}), ...(unavailable ? { unavailable } : {}) };
  }

  saveSettings(value: unknown): Promise<BackupOverview> {
    return this.change(async () => { this.saved = { ...this.saved, settings: parseSettings(value, this.saved.settings) }; }).then(() => this.overview());
  }

  private change(work: () => Promise<void> | void): Promise<void> {
    const next = this.writes.catch(() => {}).then(async () => {
      const before = this.saved;
      await work();
      try { await writePrivateJson(this.path, JSON.stringify(this.saved)); }
      catch (error) { this.saved = before; throw new BackupError(`백업 설정을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'unavailable'); }
    });
    this.writes = next;
    return next;
  }

  // ---- Making a backup ---------------------------------------------------------------------------

  /** `saved`: the settings the backup is made with, so a change meanwhile never splits what it records from where it goes. */
  private async payload(todos?: TodoBackupSnapshot, saved: SavedSettings = this.saved.settings): Promise<BackupPayload> {
    const stateDir = this.options.stateDir;
    const skills = await this.options.skills();
    const triggers = await collectTriggers(this.options.triggers);
    // Missing is "none"; unreadable fails the backup rather than record a key as absent (a restore would remove it).
    const optional = (path: string) => readPrivateJson(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new BackupError(`${path}을(를) 읽지 못해 백업하지 않았습니다: ${error instanceof Error ? error.message : String(error)}`, 'internal');
    });
    const master = await optional(join(stateDir, 'master', 'settings.json'));
    const voiceKey = await optional(join(stateDir, 'master', 'elevenlabs-key.json'));
    const { passphrase: _passphrase, ...settings } = saved;
    return {
      version: 1,
      machine: this.saved.machine,
      worker: { files: await collectWorkerFiles(stateDir, this.options.settings), encryptedVault: await encryptedVaultOf(stateDir), ...await machineKeyOf(stateDir).then(machineKey => machineKey ? { machineKey } : {}), ...(triggers ? { triggers } : {}), skills },
      web: { projectGroups: this.options.stores.groups.backupValue(), remoteExclusions: this.options.stores.exclusions.backupValue(), decisions: this.options.stores.decisions.backupValue(),
        ...(todos ? { todos: todos.part } : {}), backup: settings },
      // Only a computer that set the master up has anything to bring back.
      ...(record(master) && master.voice !== undefined || record(voiceKey) && typeof voiceKey.apiKey === 'string'
        ? { master: { ...(record(master) && master.voice !== undefined ? { settings: { voice: master.voice } } : {}), ...(record(voiceKey) && typeof voiceKey.apiKey === 'string' ? { voiceKey: voiceKey.apiKey } : {}) } } : {}),
    };
  }

  /** This computer in backup names: its host name and its mark. */
  private get computer(): string { return `${this.host}-${this.saved.machine}`; }
  private fileName(at: number): string { return `tower-backup-${this.computer}-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}${BACKUP_EXTENSION}`; }
  /** An automatic backup's name: its time to the millisecond and a random part, so no two runs ever share a key; tagged when partial. */
  private uploadName(at: number, partial: boolean): string {
    return `tower-backup-${this.computer}-${new Date(at).toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}${partial ? PARTIAL : BACKUP_EXTENSION}`;
  }

  /** An encrypted backup to download. */
  /**
   * An encrypted backup to download. It holds the todos and where their attachments are in the bucket, but not the
   * attachments' contents, which only automatic backups put there: it is marked as exported, and `notice` tells the page
   * when there were attachments whose contents it does not hold, or when the todos could not be read and are not in it.
   */
  async export(passphrase: unknown): Promise<{ name: string; text: string; notice?: 'todo-attachments-omitted' | 'todos-omitted' }> {
    const secret = checkPassphrase(passphrase);
    const at = this.now();
    const todos = this.todoSnapshot();
    const text = await encryptBackup(await this.payload(todos && { ...todos, part: { ...todos.part, exported: true } }, structuredClone(this.saved.settings)), secret, { towerVersion: this.options.version, from: hostname(), createdAt: new Date(at).toISOString() });
    const notice = this.options.todos && !todos ? 'todos-omitted' as const : todos?.contents.size ? 'todo-attachments-omitted' as const : undefined;
    return { name: this.fileName(at), text, ...(notice ? { notice } : {}) };
  }

  /**
   * The todos to back up, carrying every attachment key this computer has known (see SavedFile.todoKeys); undefined
   * (logged) when their file cannot be read, so the rest is still backed up.
   */
  private todoSnapshot(): TodoBackupSnapshot | undefined {
    let snapshot: TodoBackupSnapshot | undefined;
    try { snapshot = this.options.todos?.snapshot(this.computer); }
    catch (error) { console.warn(`The todos could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    if (this.options.todos && !snapshot) console.warn('The todos were left out of the backup.');
    const files = snapshot?.part.files;
    if (!snapshot || !files) return snapshot;
    const own = { namespace: files.namespace, key: files.key };
    const keys = mergeKeys([own], mergeKeys(files.keys ?? [], this.todoKeys)).slice(1);
    return { ...snapshot, part: { ...snapshot.part, files: { ...own, ...(keys.length ? { keys } : {}) } } };
  }

  /**
   * Adds keys to the ones this computer keeps (KEYS_FILE), never dropping any: one at a time, each reading the file
   * again first. Settles once the keys are on disk, and fails when they could not be written; answers false, writing
   * nothing, while the file cannot be read (merging into what cannot be read could drop a key).
   */
  private rememberKeys(keys: TodoFileKey[]): Promise<boolean> {
    // best-effort: the write before already gave its failure to its own caller; this one looks again at what is on disk.
    const next = this.keyWrites.catch(() => {}).then(async () => {
      if (!await this.loadKeys()) return false;
      const merged = mergeKeys(this.todoKeys, keys);
      if (merged.length === this.todoKeys.length) return true;
      await writePrivateJson(join(this.options.stateDir, KEYS_FILE), JSON.stringify({ version: 1, keys: merged }));
      this.todoKeys = merged;
      return true;
    });
    this.keyWrites = next;
    return next;
  }


  // ---- Automatic backups -------------------------------------------------------------------------

  private client(settings: SavedSettings = this.saved.settings): S3Client {
    const { remote } = settings;
    if (!remote.secretAccessKey) throw new BackupError('비밀 액세스 키를 입력하세요.');
    return new S3Client({ endpoint: remote.endpoint, bucket: remote.bucket, region: remote.region || 'auto', accessKeyId: remote.accessKeyId, secretAccessKey: remote.secretAccessKey }, this.options.fetcher, undefined, this.closing.signal);
  }
  private ownPrefix(settings: SavedSettings): string { return `${settings.remote.prefix}tower-backup-${this.computer}-`; }
  /** The bucket as the todos' attachments use it. */
  private objects(client: S3Client): TodoObjectStore {
    return { put: (key, body) => client.put(key, body), get: (key, maxBytes) => client.get(key, maxBytes),
      scan: async prefix => { const listing = await client.scan(prefix, TODO_OBJECTS_LISTED); return { keys: listing.items.map(item => item.key), complete: listing.complete }; } };
  }
  /** Exactly this computer's automatic backups: its own name and mark, then a time and nothing else. */
  private own(key: string, prefix: string): boolean { return key.startsWith(prefix) && /^\d{8}T\d{6}(?:\d{3}Z-[0-9a-f]{8}(?:-partial)?|Z)\.towerbackup$/.test(key.slice(prefix.length)); }

  /** Makes an automatic backup when one is due: never made, older than the interval, or retried a while after a failure. */
  async runIfDue(): Promise<void> {
    const { settings, status } = this.saved;
    if (!settings.enabled || this.running) return;
    const now = this.now();
    const success = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : undefined, attempt = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : undefined;
    if (success !== undefined && now - success < settings.intervalHours * HOUR) return;
    // A failed attempt is tried again after a while, not every ten minutes.
    if (attempt !== undefined && (success === undefined || attempt > success) && now - attempt < RETRY_AFTER) return;
    await this.upload().catch(() => {});
  }

  /**
   * Makes a backup now and uploads it; answers its key. One at a time. The upload is what counts: removing this
   * computer's oldest backups afterwards may fail (a key allowed only to write) without making it upload again. A
   * backup that could not hold all its todos goes up as a partial backup, which never removes a complete one: a
   * complete one may be the last that can bring them back.
   */
  upload(): Promise<string> {
    if (this.running) return this.running;
    const work = (async () => {
      // One set of settings for the whole backup, even if they are changed meanwhile.
      const settings = structuredClone(this.saved.settings);
      if (!settings.passphrase) throw new BackupError('자동 백업 암호를 먼저 저장하세요.');
      const client = this.client(settings);
      const own = this.ownPrefix(settings);
      const at = this.now();
      const attempted = this.saved.status.lastAttemptAt;
      await this.change(() => { this.saved = { ...this.saved, status: { ...this.saved.status, lastAttemptAt: new Date(at).toISOString() } }; }).catch(() => {});
      const undoAttempt = () => this.change(() => { const { lastAttemptAt: _at, ...status } = this.saved.status; this.saved = { ...this.saved, status: { ...status, ...(attempted ? { lastAttemptAt: attempted } : {}) } }; }).catch(() => {});
      // A restore after this point replaces what the snapshot below holds: the round then removes nothing.
      const generation = this.options.todos?.generation();
      // Why this backup cannot hold all the todos, known before it goes up; any of it makes it a partial backup.
      const partial: string[] = [];
      const warnings: string[] = [];
      // The kept keys read again first, so the snapshot carries them (a fixed file is used again without a restart).
      let keysReadable = await this.rememberKeys([]);
      const todos = this.todoSnapshot();
      if (this.options.todos && !todos) partial.push('할 일 저장소를 읽지 못해 할 일이 빠졌습니다');
      if (todos?.newer) partial.push('더 새로운 Tower가 바꾼 할 일 저장소라 이 Tower가 아는 내용만 담았습니다');
      let key = '';
      try {
        const text = await encryptBackup(await this.payload(todos, settings), settings.passphrase, { towerVersion: this.options.version, from: hostname(), createdAt: new Date(at).toISOString() });
        // Kept before the backup goes up: a later backup carries these keys even if the todo file is lost meanwhile.
        if (todos?.part.files) keysReadable = await this.rememberKeys([{ namespace: todos.part.files.namespace, key: todos.part.files.key }, ...todos.part.files.keys ?? []]);
        if (!keysReadable) {
          partial.push('첨부 키 파일을 읽을 수 없어 예전 백업의 첨부 키를 모두 싣지 못했습니다');
          warnings.push(KEYS_UNREADABLE);
        }
        key = `${settings.remote.prefix}${this.uploadName(at, partial.length > 0)}`;
        // The backup first, so a slow or stopped attachment upload never costs the settings. It carries every key the
        // todos know, so attachments that then do not go up stay openable wherever the bucket already holds them.
        await client.put(key, Buffer.from(text), 'application/octet-stream');
        if (todos) {
          const attachments = await this.options.todos!.upload(this.objects(client), settings.remote.prefix, todos, this.closing.signal);
          if (attachments.damaged.length) warnings.push(`이 컴퓨터에서 손상된 첨부 파일 ${attachments.damaged.length}개는 올리지 않았습니다.`);
          if (attachments.failed.length) warnings.push(`첨부 파일 ${attachments.failed.length}개를 저장소에 올리지 못했습니다. 다음 백업 때 다시 올립니다.`);
          if (attachments.missing.length) warnings.push(`이 컴퓨터에 내용이 없는 첨부 파일 ${attachments.missing.length}개는 올리지 않았습니다(저장소에 다른 키로 남아 있으면 복원할 수 있습니다).`);
        }
      } catch (error) {
        // Stopped because Tower is shutting down: not a failure, and the next start tries again when due.
        if (this.closing.signal.aborted) { await undoAttempt(); throw error; }
        const message = error instanceof Error ? error.message : String(error);
        await this.change(() => { this.saved = { ...this.saved, status: { ...this.saved.status, lastError: message } }; }).catch(() => {});
        throw error;
      }
      if (partial.length) warnings.push(`할 일이 온전히 들어가지 않은 부분 백업으로 올렸고, 온전한 백업은 지우지 않았습니다: ${partial.join(', ')}. 할 일 저장소를 고치거나 Tower를 업데이트하면 다시 온전한 백업이 만들어집니다.`);
      try {
        const listing = await client.scan(own);
        // Only a whole listing says which backups are the oldest; from any other nothing is removed.
        if (!listing.complete) throw new BackupError('저장소의 백업 목록을 끝까지 읽지 못해 정리하지 않았습니다.', 'upstream');
        const mine = [...new Set(listing.items.filter(item => this.own(item.key, own)).map(item => item.key))]
          .sort((a, b) => backupTime(a).localeCompare(backupTime(b)) || (a < b ? -1 : a > b ? 1 : 0));
        // Partial backups never push out complete ones: complete ones rotate only after a complete backup, partial
        // ones (a bounded number) after any.
        const partials = mine.filter(item => item.endsWith(PARTIAL)), completes = mine.filter(item => !item.endsWith(PARTIAL));
        const doomed = [...partials.slice(0, Math.max(0, partials.length - Math.max(settings.keep, PARTIAL_KEPT))),
          ...(partial.length ? [] : completes.slice(0, Math.max(0, completes.length - settings.keep)))];
        // Decided in turn with restores: one applied while this backup was made means it removes nothing. The
        // removing itself is not held up behind: a restore that starts now already holds the backup it applies.
        const restored = await this.oneRestore(async () => Boolean(this.options.todos && this.options.todos.generation() !== generation));
        if (restored) warnings.push('백업하는 동안 할 일을 복원했습니다. 이번에는 오래된 백업을 지우지 않았습니다.');
        else for (const item of doomed) await client.delete(item);
      } catch (error) { warnings.push(`오래된 백업을 정리하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`); }
      const warning = warnings.length ? warnings.join(' ') : undefined;
      await this.change(() => {
        const { lastError: _error, lastWarning: _warning, ...status } = this.saved.status;
        this.saved = { ...this.saved, status: { ...status, lastSuccessAt: new Date(at).toISOString(), lastKey: key, ...(warning ? { lastWarning: warning } : {}) } };
      }).catch(() => {});
      return key;
    })().finally(() => { this.running = undefined; });
    this.running = work;
    return work;
  }

  /** Writes and removes a small object, to show the settings reach the bucket. */
  async test(): Promise<void> {
    const client = this.client();
    const key = `${this.saved.settings.remote.prefix}.tower-backup-test-${randomUUID()}`;
    await client.put(key, Buffer.from('ok'), 'text/plain');
    await client.delete(key);
    // Keeping only the newest backups needs to list them too.
    await client.list(this.ownPrefix(this.saved.settings), 1);
  }

  async remote(): Promise<RemoteBackup[]> {
    return (await this.client().list(`${this.saved.settings.remote.prefix}tower-backup-`)).filter(item => item.key.endsWith(BACKUP_EXTENSION)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.key.localeCompare(a.key));
  }

  async download(key: unknown): Promise<{ name: string; text: string }> {
    const prefix = this.saved.settings.remote.prefix;
    if (typeof key !== 'string' || !key.startsWith(prefix) || !key.endsWith(BACKUP_EXTENSION) || key.length > 1024 || unsafeKey(key)) throw new BackupError('백업을 찾을 수 없습니다.', 'not-found');
    const text = (await this.client().get(key, MAX_BACKUP_FILE_BYTES)).toString('utf8');
    readBackupHeader(text);
    return { name: key.slice(key.lastIndexOf('/') + 1), text };
  }

  // ---- Restoring ---------------------------------------------------------------------------------

  /** Decrypts and checks a backup, and keeps it ready to apply for ten minutes. Nothing is written. */
  async check(file: unknown, passphrase: unknown): Promise<BackupPreview> {
    if (typeof file !== 'string') throw new BackupError('백업 파일을 고르세요.');
    const secret = checkPassphrase(passphrase);
    const { header, payload } = await decryptBackup(file, secret);
    // A newer Tower may save settings this build cannot read; they could keep its worker from starting.
    if (newerVersion(header.towerVersion, this.options.version)) throw new BackupError(`Tower ${header.towerVersion}에서 만든 백업입니다. 이 Tower(${this.options.version})를 업데이트한 뒤 복원하세요.`, 'conflict');
    let parsed: BackupPayload;
    try { parsed = parsePayload(payload); } catch (error) { throw new BackupError(error instanceof Error ? error.message : String(error)); }
    const now = this.now();
    // Each holds a whole decrypted backup; only the latest one is kept.
    this.checked.clear();
    const id = randomUUID();
    this.checked.set(id, { payload: parsed, header, passphrase: secret, at: now });
    const todos = parsed.web.todos;
    // A downloaded backup holds no attachment contents; the page says they come from the bucket, if still there.
    const fetched = record(todos) && todos.exported === true && record(todos.tables) && Array.isArray(todos.tables.todo_files) && todos.tables.todo_files.length > 0;
    return { id, createdAt: header.createdAt, from: header.from, towerVersion: header.towerVersion, parts: payloadParts(parsed), skills: parsed.worker.skills?.bundle.skills.length ?? 0, otherComputer: this.otherComputer(parsed, header),
      ...(fetched ? { todoFilesFetched: true } : {}) };
  }

  /**
   * Applies a checked backup. Files it replaces are copied aside first. The web's and the master's settings apply now,
   * through their stores; the worker's part waits in `restore/` for the next worker, which is asked to take over at
   * its next quiet moment, so no running turn or shell is interrupted.
   */
  apply(id: unknown): Promise<RestoreReport> { return this.oneRestore(() => this.applyNow(id)); }

  /** Restores and their cancellation run one at a time, so neither acts on the other's files. */
  private restores: Promise<unknown> = Promise.resolve();
  private oneRestore<T>(work: () => Promise<T>): Promise<T> {
    const next = this.restores.catch(() => {}).then(work);
    this.restores = next;
    return next;
  }

  private async applyNow(id: unknown): Promise<RestoreReport> {
    const item = typeof id === 'string' ? this.checked.get(id) : undefined;
    if (!item || this.now() - item.at > CHECKED_KEPT_MS) throw new BackupError('확인한 백업이 만료되었습니다. 파일을 다시 확인하세요.', 'conflict');
    this.checked.delete(id as string);
    const { header, passphrase } = item;
    const payload = structuredClone(item.payload);
    const stateDir = this.options.stateDir;
    if (!this.options.settings) throw new Error('Worker SQL settings owner is unavailable.');
    const settingsBefore = await this.options.settings();
    const triggersBefore = await collectTriggers(this.options.triggers);
    const targetHasVault = Boolean(await encryptedVaultOf(stateDir));
    const before = await keepBefore(stateDir, targetHasVault ? REPLACED.filter(name => name !== 'trigger-secrets.json') : REPLACED, new Date(this.now()), triggersBefore, settingsBefore);
    // A worker part still waiting from an earlier restore is replaced by this one.
    await removePendingWorker(stateDir);
    const restoreId = randomUUID(); const pendingSecretImports: string[] = [];
    if (payload.worker.encryptedVault) { pendingSecretImports.push(await stageVaultImport(stateDir, payload.worker.encryptedVault, restoreId, payload.worker.machineKey)); delete payload.worker.encryptedVault; }
    delete payload.worker.machineKey;
    const { legacy } = deferredSecretParts(payload.worker, targetHasVault, pendingSecretImports.length > 0);
    if (legacy) {
      pendingSecretImports.push(await stageLegacyImport(stateDir, legacy.records, passphrase, restoreId, legacy.triggers));
      delete payload.worker.files['trigger-secrets.json']; delete payload.worker.triggers;
    }
    const worker = payloadParts({ ...payload, web: {}, master: undefined });
    const applied: BackupPart[] = [], errors: string[] = [];
    let passphraseAdopted = false;
    const step = async (part: BackupPart, work: () => Promise<unknown>) => {
      try { await work(); applied.push(part); }
      catch (error) { errors.push(`${part}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const { web, master } = payload;
    if (web.projectGroups !== undefined) await step('projectGroups', () => this.options.stores.groups.restore(web.projectGroups));
    // Folders kept from sharing are this computer's own paths: another computer's backup only adds to them.
    const exclusions = this.otherComputer(payload, header) && record(web.remoteExclusions) && Array.isArray(web.remoteExclusions.folders)
      ? { folders: [...new Set([...(this.options.stores.exclusions.backupValue() as { folders: string[] }).folders, ...web.remoteExclusions.folders as string[]])] } : web.remoteExclusions;
    if (web.remoteExclusions !== undefined) await step('remoteExclusions', () => this.options.stores.exclusions.restore(exclusions));
    if (web.decisions !== undefined) await step('decisions', () => this.options.stores.decisions.restore(web.decisions));
    if (web.backup !== undefined) await step('backup', () => this.change(() => {
      const incoming = record(web.backup) ? web.backup : {};
      // A passphrase already saved here stays; without one, the passphrase this backup was opened with protects the
      // backups made from here on (the report says so).
      const kept = this.saved.settings.passphrase;
      const settings = parseSettings({ ...incoming, passphrase: kept ?? passphrase, enabled: false }, structuredClone(DEFAULT_BACKUP_SETTINGS));
      if (!kept) passphraseAdopted = true;
      const complete = Boolean(settings.remote.endpoint && settings.remote.bucket && settings.remote.accessKeyId && settings.remote.secretAccessKey);
      this.saved = { ...this.saved, settings: { ...settings, enabled: incoming.enabled === true && complete } };
    }));
    // After the backup settings: its attachments come from the bucket those name.
    let todoBefore: string | undefined;
    const restoreNotes: string[] = [];
    if (web.todos !== undefined) await step('todos', async () => {
      if (!this.options.todos) throw new BackupError('할 일을 사용할 수 없습니다.', 'unavailable');
      const restored = await this.options.todos.restore(web.todos, () => this.objects(this.client()), this.saved.settings.remote.prefix, this.computer);
      todoBefore = restored.before;
      // Its keys stay in the todo file either way; the kept keys need the file readable to take them too.
      if (!await this.rememberKeys(restored.keys)) restoreNotes.push(KEYS_UNREADABLE);
    });
    if (master && this.options.master) await step('master', () => this.options.master!({ ...(master.settings?.voice !== undefined ? { voice: master.settings.voice } : {}), voiceKey: master.voiceKey ?? null }));
    if (applied.length) this.options.onChange?.();
    const requestedAt = new Date(this.now()).toISOString();
    const report: RestoreReport = { id: restoreId, status: worker.length ? 'waiting-worker' : pendingSecretImports.length ? 'waiting-secrets' : 'applied', requestedAt, from: header.from, createdAt: header.createdAt, applied, worker, errors, before, ...(todoBefore ? { todoBefore } : {}), ...(pendingSecretImports.length ? { pendingSecretImports } : {}),
      ...((passphraseAdopted || pendingSecretImports.length || restoreNotes.length) ? { notes: [...(passphraseAdopted ? ['자동 백업은 이제 이 백업을 연 암호로 암호화됩니다.'] : []), ...(pendingSecretImports.length ? ['시크릿과 트리거 복원은 암호화 가져오기 대기 중입니다. Vault 기록에는 원본 Vault 비밀번호를, 트리거·이전 시크릿 기록에는 백업 암호를 입력하세요.'] : []), ...restoreNotes] } : {}),
      ...(worker.length || pendingSecretImports.length ? {} : { appliedAt: requestedAt }) };
    await writeReport(stateDir, report);
    if (!worker.length) return report;
    try { await writePendingWorker(stateDir, { ...payload.worker, id: report.id }); }
    catch (error) {
      const failed: RestoreReport = { ...report, status: 'cancelled', errors: [...errors, `실행 워커의 설정을 복원 대기열에 쓰지 못했습니다: ${error instanceof Error ? error.message : String(error)}`] };
      await writeReport(stateDir, failed);
      return failed;
    }
    const asked = await this.options.restartWorker().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); return false; });
    if (!asked) {
      report.errors = [...errors, '실행 워커에 교대를 요청하지 못했습니다. Tower를 다시 시작하면 워커가 시작할 때 적용됩니다.'];
      // The web's own report; a worker that took the part meanwhile records its outcome beside it.
      await writeReport(stateDir, report);
    }
    return (await readReport(stateDir)) ?? report;
  }

  /** Made by another Tower, by its mark (two computers may share a host name). Without a mark it counts as another. */
  private otherComputer(payload: BackupPayload, _header: BackupHeader): boolean {
    return payload.machine !== this.saved.machine;
  }

  /** Stops a restore whose worker part has not been taken yet. What the web and the master applied stays. */
  cancel(id: unknown): Promise<RestoreReport> { return this.oneRestore(() => this.cancelNow(id)); }
  private async cancelNow(id: unknown): Promise<RestoreReport> {
    const report = await readReport(this.options.stateDir);
    if (report?.status !== 'waiting-worker' || report.id !== id) throw new BackupError('기다리는 복원이 없습니다.', 'conflict');
    // Once a worker has taken it, it is being applied and can no longer be stopped.
    if (!await removePendingWorker(this.options.stateDir)) throw new BackupError('실행 워커가 이미 복원을 적용하고 있습니다.', 'conflict');
    const next: RestoreReport = { ...report, status: 'cancelled' };
    await writeReport(this.options.stateDir, next);
    return next;
  }
}
