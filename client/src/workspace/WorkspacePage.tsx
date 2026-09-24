import { useCallback, useEffect, useRef, useState } from 'react';
import { File, Folder, FolderPlus, FilePlus, PanelLeft, RefreshCw, Save, Terminal, X } from 'lucide-react';
import { api } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { WorkspaceEditor } from './WorkspaceEditor';
import { WorkspaceTerminal } from './WorkspaceTerminal';
import { WorkspaceFileTree } from './WorkspaceFileTree';
import { nodePath, splitScopedId, workspacePath } from '../remote/scope';
import { hostNames } from '../remote/hosts';

type Document = { path: string; content: string; revision: string | null; saved: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function WorkspacePage({ cwd, initialTool, toolRequest, onClose, registerGuard }: { cwd: string; initialTool: string; toolRequest?: number; onClose?: () => void; registerGuard?: (guard: () => boolean) => void }) {
  const { language, setLanguage } = useI18n();
  const [token, setToken] = useState('');
  const [explorerVisible, setExplorerVisible] = useState(() => !window.matchMedia('(max-width: 680px)').matches);
  const closeMobileExplorer = () => { if (window.matchMedia('(max-width: 680px)').matches) setExplorerVisible(false); };
  const [error, setError] = useState('');
  const [folder, setFolder] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [document, setDocument] = useState<Document | null>(null);
  const documentRef = useRef(document); documentRef.current = document;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [terminalVisible, setTerminalVisible] = useState(initialTool === 'terminal');
  const [terminalMaximized, setTerminalMaximized] = useState(initialTool === 'terminal');
  const [terminalStarted, setTerminalStarted] = useState(initialTool === 'terminal');
  const [creation, setCreation] = useState<'file' | 'directory' | null>(null);
  const [newName, setNewName] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  const dirty = !!document && document.content !== document.saved;
  useEffect(() => { let active = true; void api<{ token: string }>('/api/bootstrap').then(result => { if (active) setToken(result.token); }).catch(error => { if (active) setError(message(error)); }); return () => { active = false; }; }, [refresh]);
  useEffect(() => { const beforeUnload = (event: BeforeUnloadEvent) => { if (documentRef.current && documentRef.current.content !== documentRef.current.saved) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload); }, []);
  const canLeave = () => !savingRef.current && (!documentRef.current || documentRef.current.content === documentRef.current.saved || window.confirm(t('저장하지 않은 변경사항을 버리시겠습니까?')));
  useEffect(() => { registerGuard?.(canLeave); return () => registerGuard?.(() => true); }, [registerGuard]);
  useEffect(() => { setTerminalVisible(initialTool === 'terminal'); setTerminalMaximized(initialTool === 'terminal'); if (initialTool === 'terminal') setTerminalStarted(true); }, [initialTool, toolRequest]);
  const openFile = async (path: string, reload = false) => {
    if (savingRef.current) return;
    if (!reload && path === documentRef.current?.path) { setFolder(path.split('/').slice(0, -1).join('/')); setCreation(null); closeMobileExplorer(); return; }
    if (!canLeave()) return;
    const revision = ++request.current; setFileLoading(true); setError('');
    try { const result = await api<{ path: string; content: string; revision: string }>(workspacePath(cwd, '/api/workspace/file', { path })); if (request.current === revision) { setDocument({ ...result, saved: result.content }); setEditorVersion(value => value + 1); setFolder(path.split('/').slice(0, -1).join('/')); closeMobileExplorer(); } }
    catch (error) { if (request.current === revision) setError(message(error)); }
    finally { if (request.current === revision) setFileLoading(false); }
  };
  // Paths and bodies name the folder as its own computer knows it.
  const { node, id: folderPath } = splitScopedId(cwd);
  const machine = node ? hostNames.get(node) ?? t('연결된 컴퓨터') : undefined;
  const post = (path: string, body: object) => api(nodePath(node, path), { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify({ ...body, cwd: folderPath }) });
  const save = useCallback(async () => {
    const current = documentRef.current;
    if (!current || !token || savingRef.current || fileLoading) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const result = await api<{ revision: string }>(nodePath(node, '/api/workspace/file'), { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify({ cwd: folderPath, path: current.path, content: current.content, revision: current.revision }) });
      setDocument(previous => previous?.path === current.path ? { ...previous, saved: current.content, revision: result.revision } : previous); setRefresh(value => value + 1);
    } catch (error) { setError(message(error)); }
    finally { savingRef.current = false; setSaving(false); }
  }, [cwd, token, fileLoading]);
  const create = async () => {
    if (!newName.trim() || !creation || !token || savingRef.current || fileLoading) return;
    if (creation === 'file' && !canLeave()) return;
    savingRef.current = true; setSaving(true); setError('');
    const path = [folder, newName.trim()].filter(Boolean).join('/');
    try {
      if (creation === 'directory') await post('/api/workspace/directory', { cwd, path });
      else { const result = await post('/api/workspace/file', { cwd, path, content: '', revision: null }) as { revision: string }; ++request.current; setDocument({ path, content: '', saved: '', revision: result.revision }); closeMobileExplorer(); }
      setCreation(null); setNewName(''); setRefresh(value => value + 1);
    } catch (error) { setError(message(error)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <main className={`workspace-page${terminalMaximized ? ' terminal-maximized' : ''}`}>
    <header className="workspace-page-header">{!terminalMaximized && <button aria-label={t('파일 탐색기')} title={t('파일 탐색기')} aria-expanded={explorerVisible} aria-controls="workspace-explorer" onClick={() => setExplorerVisible(value => !value)}><PanelLeft size={17} /></button>}{!onClose && <a href="/" className="workspace-home" onClick={event => { if (!canLeave()) event.preventDefault(); }}>Tower</a>}<div className="workspace-page-title"><strong>{machine ? t('{0}의 작업 공간', { 0: machine }) : t('브라우저 작업 공간')}</strong><span title={folderPath}>{folderPath}</span></div><button onClick={() => setLanguage(language === 'ko' ? 'en' : 'ko')}>{language === 'ko' ? 'EN' : '한국어'}</button><button className={terminalVisible ? 'selected' : ''} aria-pressed={terminalVisible} onClick={() => { setTerminalStarted(true); setTerminalMaximized(false); setTerminalVisible(value => !value); }}><Terminal size={16} />{t('터미널')}</button>{onClose && <button aria-label={t('작업 공간 닫기')} onClick={onClose}><X size={18} /></button>}</header>
    {error && <div className="workspace-page-error" role="alert"><span>{translateMessage(error)}</span><button onClick={() => { setError(''); setRefresh(value => value + 1); }}>{t('다시 시도')}</button><button aria-label={t('닫기')} onClick={() => setError('')}><X size={16} /></button></div>}
    <div className="workspace-page-body"><aside id="workspace-explorer" hidden={!explorerVisible || terminalMaximized} className="workspace-explorer" aria-label={t('파일 탐색기')}><div className="workspace-explorer-toolbar"><strong>{t('파일')}</strong><button aria-label={t('새 파일')} title={t('새 파일')} disabled={!token || saving || fileLoading} onClick={() => { setCreation('file'); setNewName(''); }}><FilePlus size={16} /></button><button aria-label={t('새 폴더')} title={t('새 폴더')} disabled={!token || saving || fileLoading} onClick={() => { setCreation('directory'); setNewName(''); }}><FolderPlus size={16} /></button><button aria-label={t('새로고침')} title={t('새로고침')} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button></div>
      <div className="workspace-folder-path"><button disabled={saving || fileLoading} aria-pressed={!folder} aria-label={`${t('작업 폴더')}: ${folderPath}`} title={folderPath} onClick={() => { setFolder(''); setCreation(null); }}><Folder size={13} />/</button><span title={`${t('작업 폴더')}: ${folder || folderPath}`}>{t('작업 폴더')}: {folder ? `/${folder}` : '/'}</span></div>
      {creation && <form className="workspace-create" onSubmit={event => { event.preventDefault(); void create(); }}><label>{creation === 'file' ? t('새 파일 이름') : t('새 폴더 이름')}<input autoFocus value={newName} onChange={event => setNewName(event.target.value)} required disabled={saving} /></label><div><button type="submit" disabled={saving || !newName.trim()}>{t('만들기')}</button><button type="button" disabled={saving} onClick={() => setCreation(null)}>{t('취소')}</button></div></form>}
      <WorkspaceFileTree key={cwd} cwd={cwd} refresh={refresh} folder={folder} selectedFile={document?.path} disabled={saving || fileLoading} onSelectFolder={path => { setFolder(path); setCreation(null); }} onFile={path => { void openFile(path); }} /></aside>
      <section className={`workspace-content ${terminalVisible ? 'with-terminal' : ''}`}><div className="workspace-document" hidden={terminalMaximized}><div className="workspace-document-toolbar"><span title={document?.path}>{document ? `${document.path}${dirty ? ' •' : ''}` : t('파일을 선택하세요')}</span>{document && <><button disabled={saving || fileLoading} aria-label={t("파일 다시 불러오기")} title={t("파일 다시 불러오기")} onClick={() => { void openFile(document.path, true); }}><RefreshCw size={15} /></button><button disabled={fileLoading || !dirty || saving || !token} onClick={() => { void save(); }}><Save size={15} />{saving ? t('저장 중…') : t('저장')}</button><button disabled={saving || fileLoading} aria-label={t('파일 닫기')} onClick={() => { if (canLeave()) { ++request.current; setDocument(null); } }}><X size={16} /></button></>}</div>{document ? <div className="workspace-editor-frame" inert={fileLoading || (saving && creation === 'file')} aria-busy={fileLoading || (saving && creation === 'file')}><WorkspaceEditor key={`${document.path}:${editorVersion}`} path={document.path} content={document.content} onChange={content => setDocument(previous => previous ? { ...previous, content } : previous)} onSave={() => { void save(); }} /></div> : <div className="workspace-editor-empty"><File size={32} /><p>{t('왼쪽에서 파일을 선택하거나 새 파일을 만드세요.')}</p><span>{t('파일은 Tower 서버에 저장됩니다. 저장: Ctrl / ⌘ + S')}</span></div>}</div>
      {terminalStarted && token && <div className="workspace-terminal-pane" hidden={!terminalVisible}><WorkspaceTerminal cwd={cwd} machine={machine} token={token} maximized={terminalMaximized} onToggleMaximized={() => setTerminalMaximized(value => !value)} /></div>}</section></div>
  </main>;
}
