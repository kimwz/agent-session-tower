import { Folder, X } from 'lucide-react';
import { useI18n } from '../i18n/i18n';

const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;

/** The folder a section was narrowed to from that folder's menu; clearing it shows everything again. */
export function FolderChip({ cwd, onClear }: { cwd: string; onClear: () => void }) {
  const { t } = useI18n();
  return <span className="settings-folder-chip" title={cwd}><Folder size={12} />{folderName(cwd)}
    <button type="button" aria-label={t('모든 프로젝트 보기')} title={t('모든 프로젝트 보기')} onClick={onClear}><X size={12} /></button></span>;
}
