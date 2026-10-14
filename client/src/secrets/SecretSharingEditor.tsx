import { useState } from 'react';
import { Folder, Globe, Monitor, Search, X } from 'lucide-react';
import type { SecretSettingsItem, SecretSettingsView } from '../../../shared/secrets';
import { useI18n } from '../i18n/i18n';
import type { SecretChange } from './SecretAccess';
import {
  computerName, describeChoice, describeFolder, describeKey, folderIdentity, folderMatches, machineChoices, sharingDraft, sharingPayload,
  type FolderView, type MachineChoice, type SecretCanvas, type SharingSummary,
} from './secrets-client';
import { clearShare, pendingShare } from './share-request';

/** How many folders the picker lists before asking for a narrower search. */
const SHOWN_FOLDERS = 60;

const folderTitle = (folder: FolderView) => `${folder.label} · ${folder.root}${folder.computer ? ` · ${folder.computer}` : ''}`;
/** The end of a path, enough to tell same-named folders apart in a chip; the title holds all of it. */
const shortPath = (root: string) => { const parts = root.split('/').filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : root; };
function FolderChipBody({ folder }: { folder: FolderView }) {
  return <><Folder size={11} aria-hidden="true" /><strong>{folder.label}</strong><small>{shortPath(folder.root)}</small>{folder.computer && <small>{folder.computer}</small>}</>;
}

/** A row's sharing at a glance: all machines, computer and folder chips, or not shared; a legacy secret says its rules still decide. */
export function SecretSharingChips({ summary }: { summary: SharingSummary }) {
  const { t } = useI18n();
  const nothing = !summary.allMachines && !summary.machines.length && !summary.folders.length;
  // Withheld sharing is not in effect until saved again; its chips only show what was stored.
  const muted = summary.withheld ? 'secret-chip-muted' : '';
  const covered = summary.allMachines || summary.withheld ? 'secret-chip-muted' : '';
  return <div className="secret-sharing" aria-label={t('공유 범위')}>
    {summary.legacy && <span className="secret-badge secret-legacy">{t('기존 규칙')}</span>}
    {summary.allMachines && <span className={`secret-chip secret-chip-global ${muted}`}><Globe size={11} aria-hidden="true" />{t('모든 내 머신')}{summary.allComputers.length ? ` · ${summary.allComputers.join(', ')}` : ''}</span>}
    {summary.machines.map(machine => <span key={machine.hostId} className={`secret-chip ${covered}`} title={machine.hostId}><Monitor size={11} aria-hidden="true" /><strong>{machine.name}</strong><small>{t('전체')}</small></span>)}
    {summary.folders.map(folder => <span key={`${folder.computer}:${folder.root}`} className={`secret-chip ${covered}`} title={folderTitle(folder)}>
      <FolderChipBody folder={folder} />
    </span>)}
    {nothing && <span className="secret-chip secret-chip-none">{t('공유 안 함')}</span>}
    {summary.legacy && summary.limited && <small className="secret-hint">{t('기존 규칙에 사용 방식·필드·기간 제한이 있습니다.')}</small>}
    {summary.withheld && <p role="status" className="secret-withheld">{t('구버전에서 규칙이 바뀌었습니다. 공유를 다시 저장하세요')}</p>}
  </div>;
}

/**
 * Search and pick canvas folders of every computer. Chosen folders stay as removable chips even when the canvas no
 * longer lists them; folders of a computer this vault does not trust for secrets cannot be chosen.
 */
export function SecretFolderPicker({ view, canvas, keys, onKeys, disabled }: {
  view: Pick<SecretSettingsView, 'device' | 'peers'>; canvas: SecretCanvas; keys: string[]; onKeys: (keys: string[]) => void; disabled: boolean;
}) {
  const { t } = useI18n(); const [query, setQuery] = useState('');
  const selected = keys.map(key => describeKey(view, key, canvas));
  const matching = canvas.folders.map(describeChoice).filter(folder => folderMatches(folder, query));
  const toggle = (key: string, on: boolean) => onKeys(on ? [...keys, key] : keys.filter(item => item !== key));
  return <div className="secret-folder-picker">
    {!!selected.length && <ul className="secret-chip-list" aria-label={t('선택한 폴더')}>{selected.map(({ folder, listed }) => <li key={folder.key} className="secret-chip" title={folderTitle(folder)}>
      <FolderChipBody folder={folder} />{!listed && <small>{t('캔버스에 없음')}</small>}
      <button type="button" disabled={disabled} aria-label={t('{0} 선택 해제', { 0: folder.label })} onClick={() => toggle(folder.key!, false)}><X size={12} /></button>
    </li>)}</ul>}
    <label className="secret-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={t('폴더 검색')} placeholder={t('폴더 이름, 경로, 컴퓨터 검색')} value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} /></label>
    {matching.length ? <ul className="secret-folder-list">{matching.slice(0, SHOWN_FOLDERS).map(folder => {
      const trusted = !!folderIdentity(view, folder.key!);
      return <li key={folder.key}><label className={trusted ? '' : 'disabled'}>
        <input type="checkbox" checked={keys.includes(folder.key!)} disabled={disabled || (!trusted && !keys.includes(folder.key!))} onChange={event => toggle(folder.key!, event.target.checked)} />
        <span><strong>{folder.label}</strong><small>{folder.root}</small><small>{folder.computer}{trusted ? '' : ` · ${t('시크릿 연결을 승인하지 않은 컴퓨터')}`}</small></span>
      </label></li>;
    })}</ul> : <p className="secret-empty">{t(canvas.folders.length ? '검색 결과가 없습니다.' : '캔버스에 폴더가 없습니다.')}</p>}
    {matching.length > SHOWN_FOLDERS && <p className="secret-hint">{t('{0}개 중 {1}개를 보여 줍니다. 검색으로 좁혀 보세요.', { 0: matching.length, 1: SHOWN_FOLDERS })}</p>}
  </div>;
}

/** Computers to share with as a whole: this one and the joined ones trusted for secrets, and any chosen before. */
export function SecretMachinePicker({ choices, machines, onMachines, disabled }: { choices: MachineChoice[]; machines: string[]; onMachines: (machines: string[]) => void; disabled: boolean }) {
  const { t } = useI18n();
  const shown = [...choices, ...machines.filter(id => !choices.some(choice => choice.hostId === id)).map(hostId => ({ hostId, name: hostId, kept: true }))];
  return <ul className="secret-folder-list" aria-label={t('머신 ▸ 전체')}>{shown.map(machine => <li key={machine.hostId}><label>
    <input type="checkbox" checked={machines.includes(machine.hostId)} disabled={disabled || ('kept' in machine && !machines.includes(machine.hostId))}
      onChange={event => onMachines(event.target.checked ? [...machines, machine.hostId] : machines.filter(id => id !== machine.hostId))} />
    <span><strong>{machine.name}</strong><small>{'kept' in machine ? t('시크릿 연결을 승인하지 않은 컴퓨터') : t('이 컴퓨터의 모든 프로젝트')}</small></span>
  </label></li>)}</ul>;
}

/** All machines, whole computers and folders of one secret. Saving replaces its sharing with what is shown here. */
export function SecretSharingEditor({ view, item, canvas, busy, change, onClose }: {
  view: SecretSettingsView; item: SecretSettingsItem; canvas: SecretCanvas; busy: boolean; change: SecretChange; onClose: () => void;
}) {
  const { t } = useI18n();
  const [initial] = useState(() => sharingDraft(view, item, canvas));
  const [allMachines, setAllMachines] = useState(initial.allMachines); const [machines, setMachines] = useState(initial.machines);
  const [keys, setKeys] = useState(initial.keys); const [kept, setKept] = useState(initial.kept);
  const legacy = !item.sharing && item.legacy;
  // A share push of a following computer: one tap shares the secret with that computer, as saved now.
  const asked = pendingShare(item.id); const askedName = asked && (computerName(view, asked, canvas.hosts) || asked);
  const shareAsked = async () => { if (await change('sharing', sharingPayload(view, item, { ...initial, machines: [...initial.machines, asked!] }))) { clearShare(); onClose(); } };
  return <form className="secret-form secret-sharing-editor" onSubmit={async event => {
    event.preventDefault(); event.stopPropagation();
    if (await change('sharing', sharingPayload(view, item, { allMachines, machines, keys, kept }))) { clearShare(); onClose(); }
  }}>
    <h3>{t('공유 편집')} · {item.name}</h3>
    {asked && !initial.machines.includes(asked) && <div className="secret-notice" role="status"><p>{t('{0} 작업이 이 시크릿을 쓰려 합니다.', { 0: askedName! })}</p>
      <div className="secret-actions"><button type="button" className="secret-save" disabled={busy} onClick={() => void shareAsked()}>{t('이 머신에 공유')}</button></div></div>}
    {legacy && <div className="secret-notice"><span className="secret-badge secret-legacy">{t('기존 규칙')}</span>
      <p>{t('이 시크릿은 아직 기존 규칙으로 공유됩니다. 규칙이 공유하던 범위로 채워 두었습니다. 저장하면 보이는 그대로가 새 공유가 됩니다.')}</p>
      {legacy.limited && <p>{t('기존 규칙의 사용 방식·필드·기간 제한은 저장하면 사라집니다.')}</p>}
      {!!legacy.global.length && <p>{t('모든 내 머신으로 저장하면 이 보관함이 시크릿을 제공하는 모든 컴퓨터에 적용됩니다.')}</p>}
    </div>}
    {item.withheld && <p role="status" className="secret-withheld">{t('구버전에서 규칙이 바뀌었습니다. 공유를 다시 저장하세요')}</p>}
    <label className="secret-check secret-global-check"><input type="checkbox" checked={allMachines} disabled={busy} onChange={event => setAllMachines(event.target.checked)} />
      <span><strong>{t('모든 내 머신')}</strong><small>{t('이 컴퓨터와 연결한 모든 컴퓨터, 나중에 합류하는 컴퓨터까지 모든 폴더에서 자동으로 사용합니다.')}</small></span></label>
    {allMachines && <p className="secret-hint">{t('모든 내 머신이 켜져 있으면 아래에서 고른 머신과 폴더는 끄면 적용됩니다.')}</p>}
    <fieldset><legend>{t('머신 ▸ 전체')}</legend>
      <SecretMachinePicker choices={machineChoices(view, canvas.hosts)} machines={machines} onMachines={setMachines} disabled={busy} />
    </fieldset>
    <fieldset><legend>{t('머신 ▸ 특정 프로젝트')}</legend>
      <SecretFolderPicker view={view} canvas={canvas} keys={keys} onKeys={setKeys} disabled={busy} />
      {!!kept.length && <div className="secret-unresolved"><p>{t('승인을 해제한 컴퓨터의 폴더입니다. 그대로 두면 다시 승인했을 때 적용되고, 빼면 공유에서 지워집니다.')}</p>
        <ul className="secret-chip-list">{kept.map(folder => { const shown = describeFolder(view, folder, canvas); return <li key={`${folder.hostId}:${folder.root}`} className="secret-chip secret-chip-muted" title={folderTitle(shown)}><FolderChipBody folder={shown} />
          <button type="button" disabled={busy} aria-label={t('{0} 선택 해제', { 0: shown.label })} onClick={() => setKept(kept.filter(item => item !== folder))}><X size={12} /></button></li>; })}</ul></div>}
      {!!initial.dropped.length && <div className="secret-unresolved"><p>{t('승인이 해제된 컴퓨터의 폴더는 저장하면 빠집니다.')}</p>
        <ul className="secret-chip-list">{initial.dropped.map(folder => <li key={`${folder.computer}:${folder.root}`} className="secret-chip secret-chip-muted" title={folderTitle(folder)}><FolderChipBody folder={folder} /></li>)}</ul></div>}
    </fieldset>
    {!allMachines && !machines.length && !keys.length && !kept.length && <p className="secret-hint">{t('아무것도 고르지 않으면 공유하지 않습니다. 채팅의 ‘기존 시크릿 연결’로 세션마다 연결할 수 있습니다.')}</p>}
    <div className="secret-actions"><button type="button" onClick={onClose}>{t('취소')}</button><button type="submit" className="secret-save" disabled={busy}>{t('저장')}</button></div>
  </form>;
}

