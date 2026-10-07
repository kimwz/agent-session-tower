import { useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { CloudUpload, Download, FileUp, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { BACKUP_EXTENSION, MIN_BACKUP_PASSPHRASE, type BackupOverview, type BackupPart, type BackupPreview, type RemoteBackup, type RestoreReport } from '../../../shared/backup';
import { api, ApiError } from '../common/lib';
import { locale, translateMessage, useI18n } from '../i18n/i18n';
import { openSettings } from '../settings/settings-open';
import { SettingsFrameContext, SettingsPane } from '../settings/SettingsPane';
import { RetentionPanel } from './RetentionPanel';

const headers = (token: string) => ({ 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token });
const post = <T,>(path: string, token: string, body: unknown = {}) => api<T>(path, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });

/** Asks for a file and saves what the server sends under the name it gives. */
async function saveFile(path: string, token: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  if (!response.ok) {
    let message = `${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* not JSON */ }
    throw new ApiError(message, response.status);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `tower-backup${BACKUP_EXTENSION}`;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const PART_LABELS: Record<BackupPart, string> = { triggers: '트리거', secretVault: '암호화한 시크릿 보관함', triggerSecrets: '트리거 비밀값', permissions: '권한 규칙', models: '모델 설정', slack: 'Slack 연결과 규칙', github: 'GitHub 자동화 규칙', publicAgents: '공개 에이전트',
  skills: '스킬과 지침', decisions: '빠른 판단', projectGroups: '폴더 그룹·숨김', remoteExclusions: '원격 공유 제외 폴더', master: '마스터 음성 설정', backup: '자동 백업 설정' };

interface RemoteForm { enabled: boolean; endpoint: string; bucket: string; prefix: string; region: string; accessKeyId: string; secretAccessKey: string; passphrase: string; intervalHours: string; keep: string }
const formOf = (overview: BackupOverview): RemoteForm => ({ enabled: overview.settings.enabled, endpoint: overview.settings.remote.endpoint, bucket: overview.settings.remote.bucket, prefix: overview.settings.remote.prefix,
  region: overview.settings.remote.region, accessKeyId: overview.settings.remote.accessKeyId, secretAccessKey: '', passphrase: '', intervalHours: String(overview.settings.intervalHours), keep: String(overview.settings.keep) });

/** Everything Tower is set up with on this computer, as one encrypted file: made now or on a schedule, and restored. */
export function BackupPanel({ token }: { token: string }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<BackupOverview | null>(null);
  const [form, setForm] = useState<RemoteForm | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [exportPass, setExportPass] = useState(['', '']);
  const [file, setFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [remote, setRemote] = useState<RemoteBackup[] | null>(null);
  const load = useCallback(async () => {
    const next = await api<BackupOverview>('/api/backup');
    setOverview(next);
    setForm(current => current ?? formOf(next));
  }, []);
  const { active } = useContext(SettingsFrameContext);
  useEffect(() => { if (active) void load().catch(error => setError(error instanceof Error ? error.message : String(error))); }, [load, active]);
  // While the worker's part waits, the report is looked at again until it is applied.
  const waiting = overview?.restore?.status === 'waiting-worker' || overview?.restore?.status === 'waiting-secrets';
  useEffect(() => {
    if (!active || !waiting) return;
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [active, waiting, load]);

  async function act(name: string, action: () => Promise<void>, done = '') {
    if (busy) return;
    setBusy(name); setError(''); setNotice('');
    try { await action(); if (done) setNotice(done); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  }

  const exportReady = exportPass[0].length >= MIN_BACKUP_PASSPHRASE && exportPass[0] === exportPass[1];
  const exportBackup = (event: FormEvent) => {
    event.preventDefault();
    if (exportReady) void act('export', async () => { await saveFile('/api/backup/export', token, { passphrase: exportPass[0] }); setExportPass(['', '']); }, t('백업 파일을 내려받았습니다. 암호를 잊으면 복원할 수 없습니다.'));
  };
  const checkBackup = (event: FormEvent) => {
    event.preventDefault();
    if (file && restorePass) void act('check', async () => { setPreview(null); setPreview(await post<BackupPreview>('/api/backup/restore/check', token, { file: await file.text(), passphrase: restorePass })); });
  };
  const applyBackup = () => preview && void act('apply', async () => {
    const report = await post<RestoreReport>('/api/backup/restore/apply', token, { id: preview.id });
    setPreview(null); setFile(null); setRestorePass('');
    setOverview(current => current && { ...current, restore: report });
    // The restore may have brought other automatic backup settings: the form and the list start over from them.
    const next = await api<BackupOverview>('/api/backup');
    setOverview(next); setForm(formOf(next)); setRemote(null);
  });
  const saveRemote = (event: FormEvent) => {
    event.preventDefault();
    if (form) void act('save', async () => {
      const next = await post<BackupOverview>('/api/backup/settings', token, { enabled: form.enabled, intervalHours: Number(form.intervalHours), keep: Number(form.keep),
        ...(form.passphrase ? { passphrase: form.passphrase } : {}),
        remote: { endpoint: form.endpoint, bucket: form.bucket, prefix: form.prefix, region: form.region, accessKeyId: form.accessKeyId, ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}) } });
      setOverview(next); setForm(formOf(next));
    }, t('자동 백업 설정을 저장했습니다.'));
  };
  const listRemote = () => act('list', async () => { setRemote((await post<{ backups: RemoteBackup[] }>('/api/backup/remote', token)).backups); });
  const date = (at?: string) => at ? new Date(at).toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const field = (key: keyof RemoteForm) => ({ value: String(form?.[key] ?? ''), disabled: Boolean(busy), onChange: (event: { target: { value: string } }) => setForm(current => current && { ...current, [key]: event.target.value }) });
  const spin = (name: string) => busy === name ? <LoaderCircle className="spin" size={14} /> : null;

  return <SettingsPane title={t('백업')} scope="auth-panel backup-scope" description={t('이 컴퓨터의 Tower 설정을 암호화한 파일로 내보내고 복원')}>
    <RetentionPanel token={token} />
    <p className="auth-hint">{t('트리거, 권한 규칙, Slack, 공개 에이전트, 스킬과 지침, 빠른 판단, 폴더 그룹, 마스터 음성 설정을 한 파일에 담습니다. 세션과 대화 기록, 원격 컴퓨터 연결, 알림 기기, 원격 로그인 계정은 담지 않습니다. 파일에는 토큰과 API 키가 들어 있어 항상 암호화합니다.')}</p>
    {error && <p className="auth-error" role="alert">{translateMessage(error)}</p>}
    {notice && <p className="notification-notice" role="status">{notice}</p>}
    {overview?.unavailable && <p className="auth-hint" role="status">{translateMessage(overview.unavailable)}</p>}
    {!overview ? !error && <LoaderCircle className="spin" aria-label={t('연결 중')} /> : <>
      <section><h3>{t('내보내기')}</h3>
        <form className="backup-form" onSubmit={exportBackup}>
          <label>{t('암호')}<input type="password" autoComplete="new-password" value={exportPass[0]} disabled={Boolean(busy)} onChange={event => setExportPass([event.target.value, exportPass[1]])} /></label>
          <label>{t('암호 확인')}<input type="password" autoComplete="new-password" value={exportPass[1]} disabled={Boolean(busy)} onChange={event => setExportPass([exportPass[0], event.target.value])} /></label>
          <small>{exportPass[0] && exportPass[0].length < MIN_BACKUP_PASSPHRASE ? t('암호는 {0}자 이상이어야 합니다.', { 0: MIN_BACKUP_PASSPHRASE }) : exportPass[1] && exportPass[0] !== exportPass[1] ? t('두 암호가 다릅니다.') : t('이 암호가 없으면 복원할 수 없습니다.')}</small>
          <button className="primary-button" type="submit" disabled={Boolean(busy) || !exportReady || Boolean(overview.unavailable)}>{spin('export') ?? <Download size={14} />}{t('백업 파일 내려받기')}</button>
        </form>
      </section>
      <section><h3>{t('복원')}</h3>
        <p className="auth-hint">{t('백업의 설정이 지금 설정을 대신합니다. 바뀌는 파일은 먼저 상태 폴더의 restore 폴더에 복사해 둡니다. 실행 중인 작업은 멈추지 않습니다. 트리거, 권한, Slack, 공개 에이전트, 스킬은 실행 워커가 쉬는 순간 새 워커로 바뀌며 적용됩니다.')}</p>
        <form className="backup-form" onSubmit={checkBackup}>
          <label>{t('백업 파일')}<input type="file" accept={`${BACKUP_EXTENSION},application/json`} disabled={Boolean(busy)} onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} /></label>
          <label>{t('암호')}<input type="password" autoComplete="off" value={restorePass} disabled={Boolean(busy)} onChange={event => { setRestorePass(event.target.value); setPreview(null); }} /></label>
          <button className="secondary-button" type="submit" disabled={Boolean(busy) || !file || !restorePass}>{spin('check') ?? <FileUp size={14} />}{t('백업 확인')}</button>
        </form>
        {preview && <div className="backup-preview">
          <p>{t('{0}에서 {1}에 만든 백업 (Tower {2})', { 0: preview.from, 1: date(preview.createdAt), 2: preview.towerVersion })}</p>
          {preview.otherComputer && <p className="auth-error">{t('다른 컴퓨터에서 만든 백업입니다. 그 컴퓨터의 Tower가 계속 켜져 있으면 트리거, Slack, GitHub 자동화, 공개 에이전트가 두 곳에서 함께 동작합니다. 옮기는 중이라면 원래 컴퓨터의 Tower를 먼저 끄세요.')}</p>}
          <ul>{preview.parts.map(part => <li key={part}>{t(PART_LABELS[part])}{part === 'skills' ? ` · ${t('{0}개', { 0: preview.skills })}` : ''}</li>)}</ul>
          <button className="primary-button" disabled={Boolean(busy)} onClick={applyBackup}>{spin('apply') ?? <RotateCcw size={14} />}{t('이 백업으로 복원')}</button>
        </div>}
        {overview.restore && <RestoreStatus report={overview.restore} busy={Boolean(busy)} onCancel={() => void act('cancel', async () => { await post('/api/backup/restore/cancel', token, { id: overview.restore!.id }); await load(); })} />}
      </section>
      {form && <section><h3>{t('자동 백업')}</h3>
        <p className="auth-hint">{t('Cloudflare R2 같은 S3 호환 저장소에 주기적으로 암호화한 백업을 올립니다. 이 컴퓨터가 올린 백업 중 오래된 것은 보관 개수만 남기고 지웁니다.')}</p>
        <form className="backup-form" onSubmit={saveRemote}>
          <label className="settings-row"><span>{t('자동 백업')}</span><input type="checkbox" role="switch" className="settings-switch" checked={form.enabled} disabled={Boolean(busy)} onChange={event => setForm({ ...form, enabled: event.target.checked })} /></label>
          <label>{t('엔드포인트')}<input type="url" placeholder="https://<account>.r2.cloudflarestorage.com" spellCheck={false} {...field('endpoint')} /></label>
          <label>{t('버킷')}<input spellCheck={false} {...field('bucket')} /></label>
          <label>{t('경로 접두어')}<input spellCheck={false} {...field('prefix')} /></label>
          <label>{t('리전')}<input spellCheck={false} {...field('region')} /></label>
          <label>{t('액세스 키 ID')}<input autoComplete="off" spellCheck={false} {...field('accessKeyId')} /></label>
          <label>{t('비밀 액세스 키')}<input type="password" autoComplete="off" placeholder={overview.settings.remote.secretSet ? t('저장됨 · 바꿀 때만 입력') : ''} {...field('secretAccessKey')} /></label>
          <label>{t('백업 암호')}<input type="password" autoComplete="new-password" placeholder={overview.settings.passphraseSet ? t('저장됨 · 바꿀 때만 입력') : t('{0}자 이상', { 0: MIN_BACKUP_PASSPHRASE })} {...field('passphrase')} /></label>
          <label>{t('주기 (시간)')}<input type="number" min={1} max={168} {...field('intervalHours')} /></label>
          <label>{t('보관 개수')}<input type="number" min={1} max={100} {...field('keep')} /></label>
          <small>{t('비밀 키와 암호는 이 컴퓨터의 상태 폴더에만 저장되고 화면에 다시 표시되지 않습니다.')}</small>
          <div className="backup-actions">
            <button className="primary-button" type="submit" disabled={Boolean(busy)}>{spin('save')}{t('저장')}</button>
            <button className="secondary-button" type="button" disabled={Boolean(busy) || !overview.settings.remote.secretSet} onClick={() => void act('test', () => post('/api/backup/test', token), t('저장소에 쓰고 지울 수 있습니다.'))}>{spin('test')}{t('연결 테스트')}</button>
            <button className="secondary-button" type="button" disabled={Boolean(busy) || !overview.settings.remote.secretSet || !overview.settings.passphraseSet || Boolean(overview.unavailable)}
              onClick={() => void act('run', async () => { await post('/api/backup/run', token); await load(); }, t('백업을 올렸습니다.'))}>{spin('run') ?? <CloudUpload size={14} />}{t('지금 백업')}</button>
          </div>
        </form>
        <p className="auth-hint">
          {overview.status.running ? t('백업하는 중입니다.') : overview.status.lastSuccessAt ? t('마지막 백업 {0}', { 0: date(overview.status.lastSuccessAt) }) : t('아직 올린 백업이 없습니다.')}
          {overview.status.lastWarning ? <span className="auth-error"> {translateMessage(overview.status.lastWarning)}</span> : null}
          {overview.status.lastError && overview.status.lastAttemptAt && (!overview.status.lastSuccessAt || overview.status.lastAttemptAt > overview.status.lastSuccessAt) ? <span className="auth-error"> {t('마지막 시도 실패: {0}', { 0: translateMessage(overview.status.lastError) })}</span> : null}
        </p>
        <h3>{t('저장된 백업')}<button className="icon-button decision-refresh" title={t('새로고침')} aria-label={t('새로고침')} disabled={Boolean(busy) || !overview.settings.remote.secretSet} onClick={() => void listRemote()}><RefreshCw size={14} /></button></h3>
        {remote === null ? <p className="auth-empty">{t('새로고침을 누르면 저장소의 백업을 봅니다.')}</p> : remote.length ? <ul className="backup-list">{remote.map(item => <li key={item.key}>
          <div><strong>{item.key.slice(item.key.lastIndexOf('/') + 1)}</strong><small>{date(item.modifiedAt)} · {(item.size / 1024).toFixed(0)} KB</small></div>
          <button className="icon-button" title={t('내려받기')} aria-label={t('{0} 내려받기', { 0: item.key })} disabled={Boolean(busy)} onClick={() => void act('download', () => saveFile('/api/backup/remote/download', token, { key: item.key }))}><Download size={15} /></button>
        </li>)}</ul> : <p className="auth-empty">{t('저장소에 백업이 없습니다.')}</p>}
      </section>}
    </>}
  </SettingsPane>;
}

export function RestoreStatus({ report, busy, onCancel }: { report: RestoreReport; busy: boolean; onCancel: () => void }) {
  const { t } = useI18n();
  const parts = (list: BackupPart[]) => list.map(part => t(PART_LABELS[part])).join(', ');
  return <div className={`backup-report ${report.status}`} role="status">
    <strong>{report.status === 'waiting-worker' ? t('복원 적용 중: 실행 워커 교대를 기다립니다') : report.status === 'waiting-secrets' ? t('복원 적용 중: 시크릿 보관함 가져오기를 기다립니다') : report.status === 'applied' ? t('복원을 적용했습니다') : t('복원을 취소했습니다')}</strong>
    <small>{t('{0}의 백업', { 0: report.from || '?' })}</small>
    {report.applied.length > 0 && <small>{t('바로 적용: {0}', { 0: parts(report.applied) })}</small>}
    {report.worker.length > 0 && <small>{report.status === 'waiting-worker' ? t('워커가 적용할 것: {0}', { 0: parts(report.worker) }) : t('워커가 적용: {0}', { 0: parts(report.worker) })}</small>}
    {report.status === 'waiting-secrets' && <><small>{t('시크릿 설정에서 원본 보관함 비밀번호를 입력하여 가져오기를 완료하세요.')}</small><button type="button" className="secondary-button" disabled={busy} onClick={() => openSettings({ section: 'secrets' })}>{t('시크릿 설정 열기')}</button></>}
    {report.status === 'waiting-worker' && <small>{t('실행 중인 작업이 모두 끝나는 순간 적용됩니다. 작업이 계속 이어지면 늦어질 수 있습니다.')}</small>}
    {report.skills?.skipped.length ? <ul>{report.skills.skipped.map(item => <li key={`${item.name}-${item.reason}`}>{item.name}: {translateMessage(item.reason)}</li>)}</ul> : null}
    {report.errors.map(item => <small key={item} className="auth-error">{translateMessage(item)}</small>)}
    {report.notes?.map(item => <small key={item}>{t(item)}</small>)}
    {report.before && <small>{t('바뀌기 전 파일: {0}', { 0: report.before })}</small>}
    {report.status === 'waiting-worker' && <button className="secondary-button" disabled={busy} onClick={onCancel}>{t('워커 적용 취소')}</button>}
  </div>;
}
