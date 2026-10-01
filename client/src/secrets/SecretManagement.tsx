import { useState } from 'react';
import type { SecretDevice, SecretOverview, SecretProject, SecretRule } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { copyText } from '../common/lib';
import { SecretOperations } from './SecretRegistration';
import type { SecretChange } from './SecretAccess';

export function SecretRuleEditor({ overview, rule, busy, change, onClose }: { overview: SecretOverview; rule?: SecretRule; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n();
  const [groupId, setGroup] = useState(rule?.groupId || overview.groups[0]?.id || '');
  const [secretIds, setIds] = useState(rule?.secretIds || []);
  const [hostId, setHost] = useState(rule?.hostId || overview.device?.id || '');
  const [projectId, setProject] = useState(rule?.projectId || overview.groups.find(group => group.id === (rule?.groupId || overview.groups[0]?.id))?.projectId || '');
  const [root, setRoot] = useState(rule?.root || '');
  const [allProjects, setAllProjects] = useState(rule?.allProjects ?? false);
  const [activation, setActivation] = useState(rule?.activation || 'manual');
  const [operations, setOperations] = useState(rule?.operations || ['discover'] as SecretRule['operations']);
  const [fields, setFields] = useState<Record<string, string[]>>(rule?.fields || {});
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [ttl, setTtl] = useState(rule?.maxTtlMs ? String(rule.maxTtlMs / 60_000) : '');
  const [expires, setExpires] = useState(rule?.expiresAt ? new Date(rule.expiresAt - new Date(rule.expiresAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
  const group = overview.groups.find(group => group.id === groupId);
  const keys = overview.secrets.filter(secret => secret.groupId === groupId);
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation();
    if (await change('rule', { ...(rule ? { id: rule.id } : {}), groupId, secretIds, hostId, ...(projectId && !allProjects ? { projectId } : {}), ...(group?.scope === 'global' && allProjects ? { allProjects: true } : {}), ...(!projectId && !allProjects && root ? { root } : {}), activation, operations, fields, enabled,
      ...(ttl ? { maxTtlMs: Number(ttl) * 60_000 } : {}), ...(expires ? { expiresAt: Date.parse(expires) } : {}) })) onClose();
  }}><h3>{t('공유 규칙')}</h3>
    <label>{t('그룹')}<select autoFocus value={groupId} disabled={busy} required onChange={event => { setGroup(event.target.value); setIds([]); setFields({}); setAllProjects(false); setRoot(''); setProject(overview.groups.find(group => group.id === event.target.value)?.projectId || ''); }}>{overview.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
    <fieldset className="secret-choices" disabled={busy}><legend>{t('공유할 키')}</legend>{keys.map(secret => <div key={secret.id}>
      <label><input type="checkbox" checked={secretIds.includes(secret.id)} onChange={event => { setIds(event.target.checked ? [...secretIds, secret.id] : secretIds.filter(id => id !== secret.id)); if (!event.target.checked) setFields(previous => { const next = { ...previous }; delete next[secret.id]; return next; }); }} />{secret.name}</label>
      {secretIds.includes(secret.id) && !!secret.fields?.length && <div className="secret-fields"><label><input type="checkbox" checked={!fields[secret.id]} onChange={event => setFields(previous => { const next = { ...previous }; if (event.target.checked) delete next[secret.id]; else next[secret.id] = [...secret.fields!]; return next; })} />{t('모든 필드')}</label>
        {fields[secret.id] && secret.fields.map(field => <label key={field}><input type="checkbox" checked={fields[secret.id].includes(field)} onChange={event => setFields(previous => ({ ...previous, [secret.id]: event.target.checked ? [...previous[secret.id], field] : previous[secret.id].filter(item => item !== field) }))} />{field}</label>)}
      </div>}
    </div>)}</fieldset>
    <label>{t('컴퓨터')}<select value={hostId} required disabled={busy} onChange={event => { setHost(event.target.value); setRoot(''); }}>{overview.device && <option value={overview.device.id}>{overview.device.name}</option>}{overview.peers.filter(peer => peer.enabled).map(peer => <option value={peer.device.id} key={peer.device.id}>{peer.device.name}</option>)}{hostId && hostId !== overview.device?.id && !overview.peers.some(peer => peer.enabled && peer.device.id === hostId) && <option value={hostId}>{hostId}</option>}</select></label>
    {group?.scope === 'global' && <label className="secret-check"><input type="checkbox" checked={allProjects} disabled={busy} onChange={event => setAllProjects(event.target.checked)} />{t('모든 프로젝트에 허용')}</label>}
    <label>{t('프로젝트')}<select value={projectId} disabled={busy || allProjects || group?.scope === 'project'} onChange={event => setProject(event.target.value)}><option value="">{root && !allProjects ? root : t('프로젝트 선택')}</option>{overview.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
    <label>{t('연결 방식')}<select value={activation} disabled={busy} onChange={event => setActivation(event.target.value as SecretRule['activation'])}><option value="manual">{t('수동')}</option><option value="auto">{t('자동')}</option></select></label>
    <SecretOperations value={operations} onChange={setOperations} disabled={busy} />
    <label>{t('작업 내 최대 사용 시간 (분)')}<input type="number" min="1" value={ttl} disabled={busy} onChange={event => setTtl(event.target.value)} /></label>
    <label>{t('만료 시각')}<input type="datetime-local" value={expires} disabled={busy} onChange={event => setExpires(event.target.value)} /></label>
    <label className="secret-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />{t('규칙 활성화')}</label>
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" disabled={busy || !groupId || !secretIds.length || !hostId || !operations.length || (group?.scope === 'global' && !allProjects && !projectId && !root) || secretIds.some(id => fields[id]?.length === 0)}>{t('저장')}</button></div>
  </form>;
}

export function SecretProjectEditor({ overview, project, busy, change, onClose }: { overview: SecretOverview; project?: SecretProject; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const [name, setName] = useState(project?.name || ''); const [bindings, setBindings] = useState(project?.bindings.map(binding => ({ ...binding })) || [{ hostId: overview.device?.id || '', root: overview.target?.root || '' }]);
  return <form className="secret-form" onSubmit={async event => { event.preventDefault(); event.stopPropagation(); if (await change('project', { ...(project ? { id: project.id } : {}), name: name.trim(), bindings: bindings.map(binding => ({ hostId: binding.hostId, root: binding.root.trim() })) })) onClose(); }}>
    <h3>{t(project ? '프로젝트 편집' : '프로젝트 등록')}</h3><label>{t('이름')}<input autoFocus value={name} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
    {bindings.map((binding, index) => <fieldset key={index} className="secret-binding" disabled={busy}><legend>{t('프로젝트 위치')}</legend><label>{t('컴퓨터')}<select value={binding.hostId} required onChange={event => setBindings(items => items.map((item, i) => i === index ? { ...item, hostId: event.target.value } : item))}>{overview.device && <option value={overview.device.id}>{overview.device.name}</option>}{overview.peers.filter(peer => peer.enabled).map(peer => <option value={peer.device.id} key={peer.device.id}>{peer.device.name}</option>)}{binding.hostId && binding.hostId !== overview.device?.id && !overview.peers.some(peer => peer.enabled && peer.device.id === binding.hostId) && <option value={binding.hostId}>{binding.hostId}</option>}</select></label>
      <label>{t('폴더 경로')}<input value={binding.root} required onChange={event => setBindings(items => items.map((item, i) => i === index ? { ...item, root: event.target.value } : item))} /></label>{bindings.length > 1 && <button type="button" onClick={() => setBindings(items => items.filter((_, i) => i !== index))}>{t('삭제')}</button>}
    </fieldset>)}
    <button type="button" disabled={busy} onClick={() => setBindings(items => [...items, { hostId: overview.device?.id || '', root: '' }])}>{t('위치 추가')}</button>
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" disabled={busy || !name.trim() || bindings.some(binding => !binding.hostId || !binding.root.trim())}>{t(project ? '저장' : '등록')}</button></div>
  </form>;
}

export function parseSecretDevice(code: string): SecretDevice {
  const device: unknown = JSON.parse(code);
  if (!device || typeof device !== 'object' || !['id', 'name', 'signingKey', 'encryptionKey', 'fingerprint'].every(key => typeof (device as Record<string, unknown>)[key] === 'string' && (device as Record<string, string>)[key].length > 0)) throw new Error('Invalid public device');
  const { id, name, signingKey, encryptionKey, fingerprint } = device as SecretDevice;
  return { id, name, signingKey, encryptionKey, fingerprint };
}
export function SecretTrustEditor({ overview, busy, change, onClose }: { overview: SecretOverview; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const [code, setCode] = useState(''); const [routeId, setRoute] = useState(''); const [direction, setDirection] = useState<'node' | 'controller'>('node'); const [error, setError] = useState(''); const [peer, setPeer] = useState<SecretDevice>();
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation(); if (!peer) return;
    if (await change('trust', { device: peer, routeId: routeId.trim(), direction })) { setCode(''); onClose(); }
  }}><h3>{t('시크릿 컴퓨터 승인')}</h3>
    {overview.device && <div className="secret-public-device"><strong>{overview.device.name}</strong><code>{overview.device.fingerprint}</code><button type="button" onClick={async () => { if (!await copyText(JSON.stringify(overview.device))) setError(t('복사하지 못했습니다.')); }}>{t('이 컴퓨터의 공개 코드 복사')}</button></div>}
    <label>{t('상대 컴퓨터의 공개 코드')}<textarea autoFocus rows={4} value={code} disabled={busy} onChange={event => { setCode(event.target.value); setPeer(undefined); setError(''); }} /></label>
    <button type="button" disabled={busy || !code.trim()} onClick={() => { try { setPeer(parseSecretDevice(code)); setError(''); } catch { setError(t('공개 코드 형식을 확인하세요.')); } }}>{t('지문 확인')}</button>
    {peer && <div className="secret-public-device"><strong>{peer.name}</strong><code>{peer.fingerprint}</code><p>{t('상대 컴퓨터 화면의 지문과 일치하는지 확인한 뒤 승인하세요.')}</p></div>}
    <label>{t('원격 연결 ID')}<input value={routeId} required disabled={busy} onChange={event => setRoute(event.target.value)} /></label>
    <label>{t('연결 방향')}<select value={direction} disabled={busy} onChange={event => setDirection(event.target.value as 'node' | 'controller')}><option value="node">{t('내가 연결한 컴퓨터')}</option><option value="controller">{t('나를 연결한 컴퓨터')}</option></select></label>
    {error && <p role="alert">{error}</p>}
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" disabled={busy || !peer || !routeId.trim()}>{t('컴퓨터 승인')}</button></div>
  </form>;
}
