import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { SecretDevice, SecretSettingsView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import { copyText } from '../common/lib';
import type { SecretChange } from './SecretAccess';
import { peerName, type SecretCanvasHost } from './secrets-client';

export type AdvancedEditor = 'trust' | 'import' | 'password';

/** Rarely needed vault management, folded away below the list: trusted computers, a pending import, the recovery password. */
export function SecretAdvanced({ view, hosts, busy, change, open, onToggle, onEdit }: {
  view: SecretSettingsView; hosts: readonly SecretCanvasHost[]; busy: boolean; change: SecretChange; open: boolean; onToggle: (open: boolean) => void; onEdit: (editor: AdvancedEditor) => void;
}) {
  const { t } = useI18n();
  return <details className="secret-advanced" open={open} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary><ChevronDown size={14} aria-hidden="true" />{t('고급')}{!!view.status.pendingImports && <span className="secret-badge">{t('가져오기 대기 중')}</span>}</summary>
    <section className="secret-advanced-section" aria-label={t('연결된 컴퓨터')}>
      <div className="secret-section-head"><h3>{t('연결된 컴퓨터')}</h3><button type="button" disabled={busy} onClick={() => onEdit('trust')}>{t('컴퓨터 승인')}</button></div>
      <p>{t('승인한 컴퓨터의 폴더를 공유 범위로 고를 수 있고, GLOBAL은 승인한 컴퓨터에도 적용됩니다.')}</p>
      {view.peers.length ? <ul>{view.peers.map(peer => <li className="secret-row" key={peer.device.id}><span><strong>{peerName(peer, hosts)}</strong><small>{t(peer.direction === 'node' ? '내가 연결한 컴퓨터' : '나를 연결한 컴퓨터')}</small><code>{peer.device.fingerprint}</code></span>
        <button type="button" disabled={busy} onClick={() => void change('untrust', { id: peer.device.id })}>{t('승인 해제')}</button></li>)}</ul>
        : <p className="secret-empty">{t('승인한 컴퓨터가 없습니다.')}</p>}
    </section>
    {!!view.status.pendingImports && <section className="secret-advanced-section"><h3>{t('가져오기 대기 중')}</h3><p>{t('암호화한 시크릿 보관함의 가져오기가 대기 중입니다.')}</p>
      <div className="secret-actions"><button type="button" disabled={busy || !view.status.pendingImportIds?.length} onClick={() => onEdit('import')}>{t('보관함 가져오기')}</button></div></section>}
    {/* The earlier vault password (owner decision D4): it opens the vault when the Tower password cannot. */}
    <section className="secret-advanced-section"><h3>{t('복구 비밀번호')}</h3><p>{t('기존 보관함 비밀번호입니다. Tower 비밀번호로 열 수 없을 때 이 비밀번호로 보관함을 엽니다.')}</p>
      <div className="secret-actions"><button type="button" disabled={busy} onClick={() => onEdit('password')}>{t('복구 비밀번호 변경')}</button></div></section>
  </details>;
}

export function parseSecretDevice(code: string): SecretDevice {
  const device: unknown = JSON.parse(code);
  if (!device || typeof device !== 'object' || !['id', 'name', 'signingKey', 'encryptionKey', 'fingerprint'].every(key => typeof (device as Record<string, unknown>)[key] === 'string' && (device as Record<string, string>)[key].length > 0)) throw new Error('Invalid public device');
  const { id, name, signingKey, encryptionKey, fingerprint } = device as SecretDevice;
  return { id, name, signingKey, encryptionKey, fingerprint };
}
export interface SecretComputer { node: string; name: string; connected: boolean }
export function SecretTrustEditor({ device, computers = [], busy, change, onClose }: { device?: SecretDevice; computers?: SecretComputer[]; busy: boolean; change: SecretChange; onClose: () => void }) {
  const { t } = useI18n(); const [code, setCode] = useState(''); const [routeId, setRoute] = useState(''); const [direction, setDirection] = useState<'node' | 'controller'>('node'); const [error, setError] = useState(''); const [peer, setPeer] = useState<SecretDevice>();
  return <form className="secret-form" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation(); if (!peer) return;
    if (await change('trust', { device: peer, routeId: routeId.trim(), direction })) { setCode(''); onClose(); }
  }}><h3>{t('시크릿 컴퓨터 승인')}</h3>
    {device && <div className="secret-public-device"><strong>{device.name}</strong><code>{device.fingerprint}</code><button type="button" onClick={async () => { if (!await copyText(JSON.stringify(device))) setError(t('복사하지 못했습니다.')); }}>{t('이 컴퓨터의 공개 코드 복사')}</button></div>}
    <label>{t('상대 컴퓨터의 공개 코드')}<textarea autoFocus rows={4} value={code} disabled={busy} onChange={event => { setCode(event.target.value); setPeer(undefined); setError(''); }} /></label>
    <button type="button" disabled={busy || !code.trim()} onClick={() => { try { setPeer(parseSecretDevice(code)); setError(''); } catch { setError(t('공개 코드 형식을 확인하세요.')); } }}>{t('지문 확인')}</button>
    {peer && <div className="secret-public-device"><strong>{peer.name}</strong><code>{peer.fingerprint}</code><p>{t('상대 컴퓨터 화면의 지문과 일치하는지 확인한 뒤 승인하세요.')}</p></div>}
    <label>{t('연결 방향')}<select value={direction} disabled={busy} onChange={event => { setDirection(event.target.value as 'node' | 'controller'); setRoute(''); }}><option value="node">{t('내가 연결한 컴퓨터')}</option><option value="controller">{t('나를 연결한 컴퓨터')}</option></select></label>
    {direction === 'node' && computers.length ? <label>{t('연결된 컴퓨터')}<select value={routeId} required disabled={busy} onChange={event => setRoute(event.target.value)}><option value="">{t('컴퓨터 선택')}</option>{computers.map(computer => <option value={computer.node} key={computer.node} disabled={!computer.connected}>{computer.name}{computer.connected ? '' : ` (${t('연결 끊김')})`}</option>)}</select></label> : <label>{t('원격 연결 ID')}<input value={routeId} required disabled={busy} onChange={event => setRoute(event.target.value)} /></label>}
    {error && <p role="alert">{error}</p>}
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" disabled={busy || !peer || !routeId.trim()}>{t('컴퓨터 승인')}</button></div>
  </form>;
}
