import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { BACKUP_EXTENSION, DEFAULT_BACKUP_SETTINGS, MAX_BACKUP_FILE_BYTES, type BackupOverview, type BackupPart, type BackupPreview, type BackupSettingsInput, type BackupStatus, type RemoteBackup, type RestoreReport } from '../../shared/backup.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { BackupError, checkPassphrase, decryptBackup, encryptBackup, readBackupHeader, type BackupHeader } from './crypto.js';
import { collectTriggers, collectWorkerFiles, parsePayload, payloadParts, WORKER_FILES, type BackupPayload, type SkillBackup } from './payload.js';
import { keepBefore, readReport, removePendingWorker, writePendingWorker, writeReport } from './restore-files.js';
import { S3Client, endpointUrl, unsafeKey } from './s3.js';
import { newerVersion } from '../link/service.js';

interface SavedSettings extends BackupSettingsInput { remote: BackupSettingsInput['remote'] & { secretAccessKey?: string } }
/** `machine`: this computer's own mark in backup names, so two computers with one name never remove each other's; never restored. */
interface SavedFile { version: 1; machine: string; settings: SavedSettings; status: Omit<BackupStatus, 'running'> }

/** What the backup needs from the rest of the web process. */
export interface BackupServiceOptions {
  stateDir: string;
  version: string;
  /** The worker's skills, guidance and their confirmations; throws while the worker cannot make them. */
  skills(): Promise<SkillBackup>;
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
/** Files a restore may replace, copied aside first. Skills replaced go to Tower's skill trash as usual. */
const REPLACED = [...Object.keys(WORKER_FILES), 'trigger-engine.json', 'skills.json', 'guidance', 'project-groups.json', 'remote-exclusions.json', 'decisions.json', FILE, join('master', 'settings.json'), join('master', 'elevenlabs-key.json')];

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

  async start(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    try {
      const value = await readPrivateJson(this.path) as Partial<SavedFile>;
      if (record(value) && record(value.settings)) {
        const settings = parseSettings({ ...value.settings, enabled: false }, value.settings as SavedSettings);
        this.saved = { version: 1, machine: typeof value.machine === 'string' && /^[0-9a-f]{6}$/.test(value.machine) ? value.machine : this.saved.machine,
          settings: { ...settings, enabled: value.settings.enabled === true }, status: record(value.status) ? value.status as SavedFile['status'] : {} };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Backup settings could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Checks every ten minutes whether an automatic backup is due. */
  schedule(): void {
    const tick = () => { void this.runIfDue().catch(() => {}); };
    this.first = setTimeout(tick, 2 * 60 * 1000);
    this.timer = setInterval(tick, CHECK_EVERY);
    this.first.unref(); this.timer.unref();
  }
  close(): void { if (this.first) clearTimeout(this.first); if (this.timer) clearInterval(this.timer); }
  async flush(): Promise<void> { await this.restores.catch(() => {}); await this.writes.catch(() => {}); await this.running?.catch(() => {}); }

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
      catch (error) { this.saved = before; throw new BackupError(`백업 설정을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 503); }
    });
    this.writes = next;
    return next;
  }

  // ---- Making a backup ---------------------------------------------------------------------------

  private async payload(): Promise<BackupPayload> {
    const stateDir = this.options.stateDir;
    const skills = await this.options.skills();
    const triggers = await collectTriggers(stateDir);
    const master = await readPrivateJson(join(stateDir, 'master', 'settings.json')).catch(() => undefined);
    const voiceKey = await readPrivateJson(join(stateDir, 'master', 'elevenlabs-key.json')).catch(() => undefined);
    const { passphrase: _passphrase, ...settings } = this.saved.settings;
    return {
      version: 1,
      worker: { files: await collectWorkerFiles(stateDir), ...(triggers ? { triggers } : {}), skills },
      web: { projectGroups: this.options.stores.groups.backupValue(), remoteExclusions: this.options.stores.exclusions.backupValue(), decisions: this.options.stores.decisions.backupValue(), backup: settings },
      master: { ...(record(master) && master.voice !== undefined ? { settings: { voice: master.voice } } : {}), ...(record(voiceKey) && typeof voiceKey.apiKey === 'string' ? { voiceKey: voiceKey.apiKey } : {}) },
    };
  }

  private fileName(at: number): string { return `tower-backup-${this.host}-${this.saved.machine}-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}${BACKUP_EXTENSION}`; }

  /** An encrypted backup to download. */
  async export(passphrase: unknown): Promise<{ name: string; text: string }> {
    const secret = checkPassphrase(passphrase);
    const at = this.now();
    const text = await encryptBackup(await this.payload(), secret, { towerVersion: this.options.version, from: hostname(), createdAt: new Date(at).toISOString() });
    return { name: this.fileName(at), text };
  }

  // ---- Automatic backups -------------------------------------------------------------------------

  private client(settings: SavedSettings = this.saved.settings): S3Client {
    const { remote } = settings;
    if (!remote.secretAccessKey) throw new BackupError('비밀 액세스 키를 입력하세요.');
    return new S3Client({ endpoint: remote.endpoint, bucket: remote.bucket, region: remote.region || 'auto', accessKeyId: remote.accessKeyId, secretAccessKey: remote.secretAccessKey }, this.options.fetcher);
  }
  private ownPrefix(settings: SavedSettings): string { return `${settings.remote.prefix}tower-backup-${this.host}-${this.saved.machine}-`; }
  /** Exactly this computer's automatic backups: its own name and mark, then a time and nothing else. */
  private own(key: string, prefix: string): boolean { return key.startsWith(prefix) && /^\d{8}T\d{6}Z\.towerbackup$/.test(key.slice(prefix.length)); }

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
   * computer's oldest backups afterwards may fail (a key allowed only to write) without making it upload again.
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
      await this.change(() => { this.saved = { ...this.saved, status: { ...this.saved.status, lastAttemptAt: new Date(at).toISOString() } }; }).catch(() => {});
      const key = `${settings.remote.prefix}${this.fileName(at)}`;
      try {
        const text = await encryptBackup(await this.payload(), settings.passphrase, { towerVersion: this.options.version, from: hostname(), createdAt: new Date(at).toISOString() });
        await client.put(key, Buffer.from(text), 'application/octet-stream');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.change(() => { this.saved = { ...this.saved, status: { ...this.saved.status, lastError: message } }; }).catch(() => {});
        throw error;
      }
      let warning: string | undefined;
      try {
        const mine = (await client.list(own)).filter(item => this.own(item.key, own)).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        for (const item of mine.slice(0, Math.max(0, mine.length - settings.keep))) await client.delete(item.key);
      } catch (error) { warning = `오래된 백업을 정리하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`; }
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
    return (await this.client().list(this.saved.settings.remote.prefix)).filter(item => item.key.endsWith(BACKUP_EXTENSION)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.key.localeCompare(a.key));
  }

  async download(key: unknown): Promise<{ name: string; text: string }> {
    const prefix = this.saved.settings.remote.prefix;
    if (typeof key !== 'string' || !key.startsWith(prefix) || !key.endsWith(BACKUP_EXTENSION) || key.length > 1024 || unsafeKey(key)) throw new BackupError('백업을 찾을 수 없습니다.', 404);
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
    if (newerVersion(header.towerVersion, this.options.version)) throw new BackupError(`Tower ${header.towerVersion}에서 만든 백업입니다. 이 Tower(${this.options.version})를 업데이트한 뒤 복원하세요.`, 409);
    let parsed: BackupPayload;
    try { parsed = parsePayload(payload); } catch (error) { throw new BackupError(error instanceof Error ? error.message : String(error)); }
    const now = this.now();
    for (const [id, item] of this.checked) if (now - item.at > CHECKED_KEPT_MS) this.checked.delete(id);
    // Each holds a whole decrypted backup; only the latest one is kept.
    this.checked.clear();
    const id = randomUUID();
    this.checked.set(id, { payload: parsed, header, passphrase: secret, at: now });
    return { id, createdAt: header.createdAt, from: header.from, towerVersion: header.towerVersion, parts: payloadParts(parsed), skills: parsed.worker.skills?.bundle.skills.length ?? 0 };
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
    if (!item || this.now() - item.at > CHECKED_KEPT_MS) throw new BackupError('확인한 백업이 만료되었습니다. 파일을 다시 확인하세요.', 409);
    this.checked.delete(id as string);
    const { payload, header, passphrase } = item;
    const stateDir = this.options.stateDir;
    const before = await keepBefore(stateDir, REPLACED, new Date(this.now()));
    // A worker part still waiting from an earlier restore is replaced by this one.
    await removePendingWorker(stateDir);
    const worker = payloadParts({ ...payload, web: {}, master: undefined });
    const applied: BackupPart[] = [], errors: string[] = [];
    const step = async (part: BackupPart, work: () => Promise<unknown>) => {
      try { await work(); applied.push(part); }
      catch (error) { errors.push(`${part}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const { web, master } = payload;
    if (web.projectGroups !== undefined) await step('projectGroups', () => this.options.stores.groups.restore(web.projectGroups));
    if (web.remoteExclusions !== undefined) await step('remoteExclusions', () => this.options.stores.exclusions.restore(web.remoteExclusions));
    if (web.decisions !== undefined) await step('decisions', () => this.options.stores.decisions.restore(web.decisions));
    if (web.backup !== undefined) await step('backup', () => this.change(() => {
      const incoming = record(web.backup) ? web.backup : {};
      // The passphrase this backup was opened with protects the backups made from here on.
      const settings = parseSettings({ ...incoming, passphrase, enabled: false }, structuredClone(DEFAULT_BACKUP_SETTINGS));
      const complete = Boolean(settings.remote.endpoint && settings.remote.bucket && settings.remote.accessKeyId && settings.remote.secretAccessKey);
      this.saved = { ...this.saved, settings: { ...settings, enabled: incoming.enabled === true && complete } };
    }));
    if (master && this.options.master) await step('master', () => this.options.master!({ ...(master.settings?.voice !== undefined ? { voice: master.settings.voice } : {}), voiceKey: master.voiceKey ?? null }));
    if (applied.length) this.options.onChange?.();
    const requestedAt = new Date(this.now()).toISOString();
    const report: RestoreReport = { id: randomUUID(), status: worker.length ? 'waiting-worker' : 'applied', requestedAt, from: header.from, createdAt: header.createdAt, applied, worker, errors, before,
      ...(worker.length ? {} : { appliedAt: requestedAt }) };
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

  /** Stops a restore whose worker part has not been taken yet. What the web and the master applied stays. */
  cancel(id: unknown): Promise<RestoreReport> { return this.oneRestore(() => this.cancelNow(id)); }
  private async cancelNow(id: unknown): Promise<RestoreReport> {
    const report = await readReport(this.options.stateDir);
    if (report?.status !== 'waiting-worker' || report.id !== id) throw new BackupError('기다리는 복원이 없습니다.', 409);
    // Once a worker has taken it, it is being applied and can no longer be stopped.
    if (!await removePendingWorker(this.options.stateDir)) throw new BackupError('실행 워커가 이미 복원을 적용하고 있습니다.', 409);
    const next: RestoreReport = { ...report, status: 'cancelled' };
    await writeReport(this.options.stateDir, next);
    return next;
  }
}
