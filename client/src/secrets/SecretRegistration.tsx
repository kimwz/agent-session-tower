import { useEffect, useRef, useState } from 'react';
import { MAX_SECRET_BYTES, SECRET_OPERATIONS, type SecretKind, type SecretOperation, type SecretOverview, type SecretScope } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { registrationPayload, postSecret } from './secrets-client';
import type { SecretChange } from './SecretAccess';

export const operationLabels: Record<SecretOperation, string> = { discover: '목록 확인', env: '환경 변수', pipe: '표준 입력', file: '비공개 파일', compare: '값 비교', fingerprint: '지문 비교' };
export const scopeLabels: Record<SecretScope, string> = { global: '전역', project: '프로젝트', task: '이번 작업' };
export function SecretOperations({ value, onChange, disabled }: { value: SecretOperation[]; onChange: (value: SecretOperation[]) => void; disabled: boolean }) {
  const { t } = useI18n();
  return <fieldset className="secret-choices" disabled={disabled}><legend>{t('허용할 사용 방식')}</legend>{SECRET_OPERATIONS.map(operation => <label key={operation}><input type="checkbox" checked={value.includes(operation)} onChange={event => onChange(event.target.checked ? [...value, operation] : value.filter(item => item !== operation))} />{t(operationLabels[operation])}</label>)}</fieldset>;
}
export function SecretRegistration({ overview, sessionId, token, busy, change, onClose }: { overview: SecretOverview; sessionId?: string; token: string; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(''); const [kind, setKind] = useState<SecretKind>('scalar');
  const [scope, setScope] = useState<SecretScope>(sessionId ? 'task' : 'global'); const [raw, setRaw] = useState('');
  const [groupId, setGroupId] = useState(''); const [groupName, setGroupName] = useState('');
  const [projectId, setProject] = useState(overview.target?.projectId || '');
  const [allProjects, setAllProjects] = useState(false);
  const [activation, setActivation] = useState<'manual' | 'auto'>('manual'); const [operations, setOperations] = useState<SecretOperation[]>(['discover', 'env', 'pipe', 'file']);
  const [fileSelected, setFileSelected] = useState(false);
  const [connect, setConnect] = useState(!!sessionId); const [fields, setFields] = useState<string[]>([]); const [error, setError] = useState(''); const [reading, setReading] = useState(false);
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  const resetRaw = () => { version.current++; setRaw(''); setFileSelected(false); setFields([]); setError(''); };
  const preview = async () => {
    const current = ++version.current;
    try { const next = await postSecret<{ fields: string[] }>('preview', token, { kind, ...(kind === 'file' ? { content: raw } : { value: raw }) }); if (current === version.current) setFields(next.fields); }
    catch { if (current === version.current) setError(t('입력을 확인하지 못했습니다. 형식을 확인하세요.')); }
  };
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation();
    const payload = registrationPayload({ name, kind, scope, groupId, groupName, projectId, allProjects, activation, operations, connect }, raw, sessionId);
    resetRaw();
    if (await change('create', payload)) onClose();
  }}>
    <h3>{t('시크릿 등록')}</h3>
    <label>{t('이름')}<input autoFocus value={name} required maxLength={128} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <label>{t('형식')}<select value={kind} disabled={busy} onChange={event => { resetRaw(); setKind(event.target.value as SecretKind); }}><option value="scalar">{t('단일 값')}</option><option value="env">.env</option><option value="file">{t('파일')}</option></select></label>
    {kind === 'file' ? <label>{t('파일 선택')}<input type="file" disabled={busy || reading} onChange={async event => {
      const file = event.target.files?.[0]; event.currentTarget.value = ''; resetRaw(); if (!file) return;
      if (file.size > MAX_SECRET_BYTES) { setError(t('파일은 1 MiB 이하여야 합니다.')); return; }
      const current = version.current; setReading(true);
      try { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); if (current === version.current) { setRaw(btoa(binary)); setFileSelected(true); if (!name) setName(file.name); } }
      catch { if (current === version.current) setError(t('파일을 읽지 못했습니다.')); }
      finally { setReading(false); }
    }} /></label> : <label>{t(kind === 'env' ? '.env 내용' : '값')}<textarea value={raw} rows={kind === 'env' ? 6 : 3} autoComplete="off" spellCheck={false}  disabled={busy} onChange={event => { version.current++; setRaw(event.target.value); setFields([]); setError(''); }} /></label>}
    {kind === 'env' && <><button type="button" disabled={busy} onClick={() => void preview()}>{t('필드 이름 확인')}</button>{!!fields.length && <p className="secret-field-names">{fields.join(', ')}</p>}</>}
    <label>{t('보관 범위')}<select value={scope} disabled={busy} onChange={event => { setScope(event.target.value as SecretScope); setGroupId(''); setAllProjects(false); }}>
      <option value="global">{t('전역')}</option><option value="project">{t('프로젝트')}</option>{sessionId && <option value="task">{t('이번 작업')}</option>}
    </select></label>
    {scope === 'global' && <><label className="secret-check"><input type="checkbox" checked={allProjects} disabled={busy} onChange={event => setAllProjects(event.target.checked)} />{t('모든 프로젝트에 허용')}</label><p>{t('전역 보관과 공유 권한은 별개입니다. 사용할 프로젝트를 선택하세요.')}</p></>}
    {(scope === 'project' || scope === 'global') && <label>{t(scope === 'global' ? '공유할 프로젝트' : '프로젝트')}<select required={scope === 'project' || (!sessionId && !allProjects)} value={projectId} disabled={busy || (scope === 'global' && allProjects)} onChange={event => { setProject(event.target.value); if (scope === 'project') setGroupId(''); }}><option value="">{t(scope === 'global' && sessionId ? '현재 세션의 프로젝트' : '프로젝트 선택')}</option>{overview.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    {scope === 'global' && !sessionId && !allProjects && !projectId && <p>{t('공유할 프로젝트를 선택하거나 모든 프로젝트에 허용을 직접 선택하세요.')}</p>}
    <label>{t('그룹')}<select value={groupId} disabled={busy} onChange={event => setGroupId(event.target.value)}><option value="">{t('새 그룹')}</option>{overview.groups.filter(group => group.scope === scope && (scope !== 'project' || group.projectId === projectId) && (scope !== 'task' || group.taskId === overview.task?.id)).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
    {!groupId && <label>{t('그룹 이름')}<input value={groupName} placeholder={name} maxLength={128} disabled={busy} onChange={event => setGroupName(event.target.value)} /></label>}
    <label>{t('연결 방식')}<select value={activation} disabled={busy} onChange={event => setActivation(event.target.value as 'manual' | 'auto')}><option value="manual">{t('수동')}</option><option value="auto">{t('자동')}</option></select></label>
    <SecretOperations value={operations} onChange={setOperations} disabled={busy} />
    {sessionId && <label className="secret-check"><input type="checkbox" checked={connect} disabled={busy} onChange={event => setConnect(event.target.checked)} />{t('현재 작업에 연결')}</label>}
    {error && <p role="alert">{error}</p>}
    <div className="secret-actions"><button type="button" onClick={() => { resetRaw(); onClose(); }}>{t('취소')}</button><button type="submit" disabled={busy || reading || !name.trim() || !operations.length || (kind === 'file' && !fileSelected) || (scope === 'project' && !projectId) || (scope === 'global' && !sessionId && !projectId && !allProjects)}>{t('등록')}</button></div>
  </form>;
}
