import { ListChecks, Workflow } from 'lucide-react';
import { translate as t } from '../i18n/i18n';

export type TowerPage = 'canvas' | 'todo';

/** The header's choice between the agent canvas and the Todo page, icon and word; only a crowded header drops the words (todo.css). */
export function PageSwitch({ page, onChange }: { page: TowerPage; onChange: (page: TowerPage) => void }) {
  return <div className="page-switch" role="group" aria-label={t('화면 전환')}>
    <button type="button" aria-pressed={page === 'canvas'} title={`${t('캔버스')} (1)`} aria-keyshortcuts="1" onClick={() => onChange('canvas')}><Workflow size={13} /><span>{t('캔버스')}</span></button>
    <button type="button" aria-pressed={page === 'todo'} title={`${t('할 일')} (2)`} aria-keyshortcuts="2" onClick={() => onChange('todo')}><ListChecks size={13} /><span>{t('할 일')}</span></button>
  </div>;
}
