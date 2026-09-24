import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, File, Folder, LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from '../common/lib';
import { workspacePath } from '../remote/scope';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';

export type WorkspaceEntry = { name: string; path: string; type: 'file' | 'directory' };
type TreeSelection = {
  expanded: ReadonlySet<string>;
  folder: string;
  selectedFile?: string;
  disabled: boolean;
  onFolder: (path: string) => void;
  onFile: (path: string) => void;
};

/** Nested lists preserve sibling context while each folder controls its own children. */
export function WorkspaceTreeEntries({ entries, childrenFor, ...selection }: TreeSelection & { entries: WorkspaceEntry[]; childrenFor: (path: string) => ReactNode }) {
  return <ul className="workspace-tree-entries">{entries.map(entry => {
    const directory = entry.type === 'directory';
    const expanded = directory && selection.expanded.has(entry.path);
    const selected = directory ? selection.folder === entry.path : selection.selectedFile === entry.path;
    return <li key={entry.path}>
      <button type="button" disabled={selection.disabled} className={selected ? 'selected' : ''} title={entry.path} aria-expanded={directory ? expanded : undefined} aria-current={selected ? 'true' : undefined} onClick={() => directory ? selection.onFolder(entry.path) : selection.onFile(entry.path)}>
        {directory ? <ChevronRight size={12} className={`workspace-tree-chevron ${expanded ? 'expanded' : ''}`} /> : <span className="workspace-tree-spacer" />}
        {directory ? <Folder size={15} /> : <File size={15} />}<span>{entry.name}</span>
      </button>
      {expanded && childrenFor(entry.path)}
    </li>;
  })}</ul>;
}

type DirectoryProps = TreeSelection & { cwd: string; path: string; refresh: number };
function DirectoryListing({ cwd, path, refresh, ...selection }: DirectoryProps) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError('');
    void api<{ entries: WorkspaceEntry[] }>(workspacePath(cwd, '/api/workspace/tree', { path }), { signal: abort.signal }).then(result => {
      if (!abort.signal.aborted) setEntries(result.entries);
    }).catch(error => {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [cwd, path, refresh, retry]);
  return <div className="workspace-tree-branch" aria-busy={loading}>
    {loading && <div className="workspace-tree-status" role="status"><LoaderCircle size={12} className="spin" /><span>{t('불러오는 중…')}</span></div>}
    {error && <div className="workspace-tree-error" role="alert"><span>{translateMessage(error)}</span><button type="button" disabled={selection.disabled} onClick={() => setRetry(value => value + 1)} title={t('다시 시도')} aria-label={t('다시 시도')}><RefreshCw size={13} /></button></div>}
    <WorkspaceTreeEntries {...selection} entries={entries} childrenFor={child => <DirectoryListing key={child} {...selection} cwd={cwd} path={child} refresh={refresh} />} />
    {!loading && !error && !entries.length && <p className="workspace-tree-status">{t('비어 있는 폴더')}</p>}
  </div>;
}

export function WorkspaceFileTree({ cwd, refresh, onSelectFolder, ...selection }: Omit<TreeSelection, 'expanded' | 'onFolder'> & { cwd: string; refresh: number; onSelectFolder: (path: string) => void }) {
  useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const onFolder = (path: string) => {
    onSelectFolder(path);
    setExpanded(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  };
  return <div className="workspace-file-list"><DirectoryListing {...selection} cwd={cwd} path="" refresh={refresh} expanded={expanded} onFolder={onFolder} /></div>;
}
