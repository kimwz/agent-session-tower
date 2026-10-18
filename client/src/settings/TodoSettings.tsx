import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { GripVertical, LoaderCircle, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { MAX_CHAT_PRESET_LENGTH, MAX_CHAT_PRESETS } from '../../../shared/todo/chat-presets';
import { api } from '../common/lib';
import { useI18n, translateMessage } from '../i18n/i18n';
import { movePreset, presetsDirty, presetsToSave, shownChatPresets } from '../todo/chat-presets';
import { useTodoSensors } from '../todo/todo-dnd';
import { SettingsPane, useSettingsGuard } from './SettingsPane';

const PRESETS_PATH = '/api/todos/chat-presets';
interface Row { id: number; text: string }

/**
 * The Todo page's settings: the buttons a todo's empty issue chat offers as its first message. They are kept on the
 * server (todos.sqlite), so every page of this Tower shows the same ones; until a list is saved the defaults show.
 */
export function TodoSettings({ token }: { token: string }) {
  const { t } = useI18n();
  // undefined while reading; null when nothing is saved (the defaults show).
  const [saved, setSaved] = useState<string[] | null>();
  const [rows, setRows] = useState<Row[]>([]);
  const [baseline, setBaseline] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const next = useRef(0);
  const sensors = useTodoSensors();
  const toRows = (presets: readonly string[]) => presets.map(text => ({ id: next.current++, text }));
  const take = (presets: string[] | null) => { const shown = shownChatPresets(presets); setSaved(presets); setBaseline(shown); setRows(toRows(shown)); };
  const load = () => {
    setError('');
    api<{ presets: string[] | null }>(PRESETS_PATH).then(answer => take(answer.presets), cause => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  useEffect(load, []);
  const dirty = saved !== undefined && presetsDirty(rows.map(row => row.text), baseline);
  useSettingsGuard({ leave: () => !dirty || window.confirm(t('저장하지 않은 프리셋을 버릴까요?')) });

  const store = async (presets: string[] | null, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const answer = await api<{ presets: string[] | null }>(PRESETS_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify({ presets }) });
      take(answer.presets); setNotice(done);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const edit = (id: number, text: string) => setRows(list => list.map(row => row.id === id ? { ...row, text } : row));
  const remove = (id: number) => setRows(list => list.filter(row => row.id !== id));
  const onEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    setRows(list => movePreset(list, list.findIndex(row => row.id === active.id), list.findIndex(row => row.id === over.id)));
  };

  return <SettingsPane title={t('할 일')} description={t('할 일 화면에서 쓰는 설정입니다.')}>
    <h3 className="settings-group-title">{t('채팅 프리셋')}</h3>
    {saved === undefined
      ? (error ? <p role="alert" className="slack-error">{translateMessage(error)} <button type="button" className="secondary-button" onClick={load}>{t('다시 시도')}</button></p> : <LoaderCircle className="spin" aria-label={t('연결 중')} />)
      : <>
        <div className="settings-group">
          {rows.length ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
            <SortableContext items={rows.map(row => row.id)} strategy={verticalListSortingStrategy}>
              <ul className="settings-presets">{rows.map((row, index) => <PresetRow key={row.id} row={row} index={index} disabled={busy} onEdit={edit} onRemove={remove} />)}</ul>
            </SortableContext>
          </DndContext> : <p className="settings-preset-empty">{t('프리셋이 없습니다. 빈 채팅에 버튼이 보이지 않습니다.')}</p>}
        </div>
        <p className="settings-presets-note">{t('할 일의 빈 채팅에 버튼으로 보이고, 누르면 그 문구로 바로 채팅을 시작합니다. 손잡이를 끌어 순서를 바꿉니다.')}</p>
        {error && <p role="alert" className="slack-error">{translateMessage(error)}</p>}
        {notice && <p role="status" className="notification-notice">{notice}</p>}
        <div className="settings-presets-actions">
          <button type="button" className="secondary-button" disabled={busy || rows.length >= MAX_CHAT_PRESETS} onClick={() => setRows(list => [...list, ...toRows([''])])}><Plus size={14} />{t('프리셋 추가')}</button>
          <button type="button" className="secondary-button" disabled={busy || saved === null} onClick={() => void store(null, t('기본 프리셋으로 되돌렸습니다.'))}><RotateCcw size={14} />{t('기본값으로')}</button>
          <span className="settings-spacer" />
          <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => take(saved)}>{t('되돌리기')}</button>
          <button type="button" className="primary-button" disabled={busy || !dirty} onClick={() => void store(presetsToSave(rows.map(row => row.text)), t('프리셋을 저장했습니다.'))}>{busy && <LoaderCircle className="spin" size={14} />}{t('저장')}</button>
        </div>
      </>}
  </SettingsPane>;
}

function PresetRow({ row, index, disabled, onEdit, onRemove }: { row: Row; index: number; disabled: boolean; onEdit: (id: number, text: string) => void; onRemove: (id: number) => void }) {
  const { t } = useI18n();
  const sortable = useSortable({ id: row.id, disabled });
  const style: CSSProperties = { transform: sortable.transform ? `translate3d(0, ${Math.round(sortable.transform.y)}px, 0)` : undefined, transition: sortable.transition, opacity: sortable.isDragging ? 0.5 : undefined };
  const label = t('프리셋 {0}', { 0: index + 1 });
  return <li ref={sortable.setNodeRef} className="settings-preset" style={style}>
    <button type="button" className="settings-preset-grip icon-button" aria-label={t('{0} 순서 바꾸기', { 0: label })} {...sortable.attributes} {...sortable.listeners}><GripVertical size={14} /></button>
    <input value={row.text} maxLength={MAX_CHAT_PRESET_LENGTH} disabled={disabled} aria-label={label} placeholder={t('보낼 첫 메시지')} autoFocus={!row.text} onChange={event => onEdit(row.id, event.target.value)} />
    <button type="button" className="icon-button" disabled={disabled} aria-label={t('{0} 삭제', { 0: label })} title={t('삭제')} onClick={() => onRemove(row.id)}><Trash2 size={14} /></button>
  </li>;
}
