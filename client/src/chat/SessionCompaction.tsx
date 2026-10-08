import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle, Shrink, Square, TriangleAlert, X } from 'lucide-react';
import type { ContinuationSource, Run, Session, SessionCompaction } from '../../../shared/types';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { api } from '../common/lib';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { nodeHeaders, nodeOf, pathFor, scopedId, settleRequest } from '../remote/scope';

const POLL_MS = 1_500;
const ACTIVE: ReadonlySet<SessionCompaction['state']> = new Set(['reading', 'summarizing', 'creating']);
export const compactionActive = (job: SessionCompaction | null | undefined) => !!job && ACTIVE.has(job.state);

/**
 * Why compacting cannot start now, or undefined. The worker decides; this only lets the button say why it is off
 * (the same conditions as SessionCompactions' refusals).
 */
export function compactBlock(session: Session | undefined, runs: readonly Run[], options: { reachable: boolean; token: string; supported: boolean }): string | undefined {
  if (!options.supported) return t('이 컴퓨터의 Tower를 업데이트하면 세션을 압축할 수 있습니다.');
  if (!options.reachable || !options.token) return t('Tower에 연결되면 압축할 수 있습니다.');
  if (!session) return t('대화를 불러오는 중입니다.');
  if (session.isSubagent || session.launchedByAgent || session.master) return t('하위 세션은 압축할 수 없습니다.');
  if (!session.resumable || session.creationPending) return t('이어서 작업할 수 없는 세션은 압축할 수 없습니다.');
  if (!session.messageCount) return t('압축할 대화가 없습니다.');
  if (session.status === 'working' || runs.some(run => run.status === 'running' || run.status === 'queued')) return t('작업 중이거나 대기·예약된 요청이 있는 세션은 끝난 뒤 압축할 수 있습니다.');
  return undefined;
}

/**
 * The conversation's compaction as the page follows it: read when the conversation opens and while one runs. Only a
 * compaction this page started (or saw running) moves the page to the new session when it is made.
 */
export function useSessionCompaction(sessionId: string, token: string, connected: boolean, onNavigate: (id: string) => void) {
  const [job, setJob] = useState<SessionCompaction | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'start' | 'cancel'>('');
  const [watch, setWatch] = useState(0);
  const followed = useRef<string | undefined>(undefined);
  const current = useRef(sessionId);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;

  useEffect(() => { current.current = sessionId; setJob(null); setError(''); setBusy(''); followed.current = undefined; }, [sessionId]);

  useEffect(() => {
    if (!connected) return;
    let timer: number | undefined;
    let stopped = false;
    const read = async () => {
      try {
        const { compaction } = await api<{ compaction: SessionCompaction | null }>(pathFor(sessionId, id => `/api/sessions/${encodeURIComponent(id)}/compaction`));
        if (stopped) return;
        setJob(compaction);
        if (compaction && ACTIVE.has(compaction.state)) { followed.current = compaction.id; timer = window.setTimeout(() => { void read(); }, POLL_MS); }
      } catch (cause) {
        if (stopped) return;
        // A compaction being followed is asked about again; otherwise nothing is known, and a click reports any error.
        if (followed.current) { setError(cause instanceof Error ? cause.message : String(cause)); timer = window.setTimeout(() => { void read(); }, POLL_MS * 2); }
      }
    };
    void read();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [sessionId, connected, watch]);

  useEffect(() => {
    if (job?.state !== 'done' || !job.newSessionId || followed.current !== job.id) return;
    followed.current = undefined;
    navigate.current(scopedId(nodeOf(sessionId), job.newSessionId));
  }, [job, sessionId]);

  const start = useCallback(async () => {
    const id = sessionId;
    if (!token || busy) return;
    setBusy('start'); setError('');
    const body = '{}';
    try {
      const { compaction } = await api<{ compaction: SessionCompaction }>(pathFor(id, local => `/api/sessions/${encodeURIComponent(local)}/compaction`), {
        method: 'POST', headers: nodeHeaders(nodeOf(id), { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, `compaction:${id}`, body), body,
      }).catch(cause => { settleRequest(nodeOf(id), `compaction:${id}`, cause); throw cause; });
      settleRequest(nodeOf(id), `compaction:${id}`);
      if (current.current !== id) return;
      followed.current = compaction.id;
      setJob(compaction);
      setWatch(value => value + 1);
    } catch (cause) { if (current.current === id) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current.current === id) setBusy(''); }
  }, [busy, sessionId, token]);

  const cancel = useCallback(async () => {
    const id = sessionId;
    if (!token || busy) return;
    setBusy('cancel'); setError('');
    try {
      const { compaction } = await api<{ compaction: SessionCompaction }>(pathFor(id, local => `/api/sessions/${encodeURIComponent(local)}/compaction/cancel`), {
        method: 'POST', headers: nodeHeaders(nodeOf(id), { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }), body: '{}',
      });
      if (current.current === id) setJob(compaction);
    } catch (cause) { if (current.current === id) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current.current === id) setBusy(''); }
  }, [busy, sessionId, token]);

  return { job, error, busy, start, cancel, followed: job ? followed.current === job.id : false, dismiss: () => { setError(''); followed.current = undefined; setJob(value => value && !ACTIVE.has(value.state) && value.state !== 'done' ? null : value); } };
}

/** The compact button, immediately left of archive. */
export function CompactButton({ job, busy, blocked, onStart }: { job: SessionCompaction | null; busy: boolean; blocked?: string; onStart: () => void }) {
  useI18n();
  const running = busy || compactionActive(job);
  return <button className="icon-button session-compact-button" aria-label={t('세션 압축')} disabled={running || !!blocked}
    title={running ? t('세션을 압축하고 있습니다') : blocked ?? t('세션 압축 · 대화를 요약해 같은 모델·추론 강도의 새 세션에서 이어갑니다. 원래 세션은 그대로 둡니다')}
    onClick={onStart}>{running ? <LoaderCircle className="spin" size={15} /> : <Shrink size={16} />}</button>;
}

const SOURCES: Record<ContinuationSource, string> = { observed: '원래 세션 기록', lastRun: '마지막 요청', default: 'CLI 기본값' };
const STAGES: Record<'reading' | 'summarizing' | 'creating', string> = { reading: '대화를 읽는 중', summarizing: '요약하는 중', creating: '새 세션을 만드는 중' };

/** What the conversation's compaction is doing, under the header. Nothing when there is nothing to say. */
export function CompactionStatus({ job, error, followed, busy, lastRequestAt, onCancel, onOpen, onDismiss }: { job: SessionCompaction | null; error: string; followed: boolean; busy: boolean;
  /** The conversation's last request: a compaction older than it no longer describes the conversation. */
  lastRequestAt?: string; onCancel: () => void; onOpen: (id: string) => void; onDismiss: () => void }) {
  useI18n();
  if (error) return <div className="compaction-status failed" role="alert"><TriangleAlert size={13} /><span>{translateMessage(error)}</span><button className="icon-button" aria-label={t('닫기')} onClick={onDismiss}><X size={12} /></button></div>;
  if (!job) return null;
  if (job.state === 'reading' || job.state === 'summarizing' || job.state === 'creating') {
    const progress = job.state === 'summarizing' && job.progress && job.progress.total > 1 ? ` (${job.progress.done}/${job.progress.total})` : '';
    return <div className="compaction-status active" role="status"><LoaderCircle className="spin" size={13} /><span>{t('세션 압축')} · {t(STAGES[job.state])}{progress}{job.compactor?.model && <small> · {job.compactor.model}</small>}</span>
      {job.state !== 'creating' && <button className="secondary-button" disabled={busy} onClick={onCancel}><Square size={10} />{t('취소')}</button>}</div>;
  }
  if (job.state === 'done' && job.newSessionId) {
    if (!followed && lastRequestAt && lastRequestAt > job.updatedAt) return null;
    const run = job.continuation;
    const detail = run ? `${run.model ?? t('CLI 기본 모델')} · ${run.effort ?? t('기본 추론 강도')} (${t(SOURCES[run.modelSource])}${run.effortSource !== run.modelSource ? ` / ${t(SOURCES[run.effortSource])}` : ''})` : '';
    return <div className="compaction-status done" role="status"><Shrink size={13} /><span>{t('압축한 새 세션에서 이어집니다.')}{detail && <small> {detail}</small>}</span>
      <button className="secondary-button" onClick={() => onOpen(job.newSessionId!)}>{t('새 세션 열기')}<ArrowRight size={11} /></button></div>;
  }
  if (!followed) return null;
  return <div className={`compaction-status ${job.state}`} role="alert"><TriangleAlert size={13} />
    <span>{job.state === 'cancelled' ? t('압축을 취소했습니다. 새 세션은 만들지 않았습니다.') : translateMessage(job.error ?? t('압축하지 못했습니다.'))}</span>
    <button className="icon-button" aria-label={t('닫기')} onClick={onDismiss}><X size={12} /></button></div>;
}
