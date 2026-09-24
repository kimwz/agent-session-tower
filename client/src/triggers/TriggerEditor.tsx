import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { ProviderHealth, Session } from '../../../shared/types';
import { GITHUB_API, type CoordinatorRule, type GitHubCheck, type HttpCondition, type HttpTestResult, type Trigger, type TriggerInput, type TriggerSecret } from '../../../shared/triggers';
import { EffortPicker, ModelPicker } from '../chat/ModelPicker';
import { absoluteTime, sessionTitle } from '../common/lib';
import { translateMessage, useI18n } from '../i18n/i18n';
import { SlackRules } from '../slack/SlackPanel';
import { KIND_ICONS } from './TriggerKinds';
import { blankTrigger, browserZone, kindLabel, MEMBERS, switchedWatch, towerOperation, type CoordinatorHandler, type GitHubSource, type HttpSource, type Source, type SourceKind, type TaskHandler } from './trigger-helpers';

interface EditorContext { token: string; providers: ProviderHealth[]; projects: [string, string][]; sessions: Session[] }

/** One step of the editor: a numbered heading, an optional hint, and its fields. */
function Section({ step, title, hint, children }: { step: number; title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="trigger-section"><h4><span>{step}</span>{title}</h4>{hint && <p className="trigger-note">{hint}</p>}{children}</section>;
}

/** Two or three choices shown side by side instead of a dropdown. Choosing the current one again changes nothing. */
function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void; label: string }) {
  return <div className="trigger-choice" role="radiogroup" aria-label={label}>{options.map(([option, text]) =>
    <button key={option} type="button" role="radio" aria-checked={value === option} className={value === option ? 'active' : ''} onClick={() => { if (option !== value) onChange(option); }}>{text}</button>)}</div>;
}

/**
 * Creates or edits one trigger. The kind is chosen before the editor opens and fixed after: the steps are
 * what to watch, how often (for sources that are checked), and what to do, with everything else under
 * advanced settings.
 */
export function TriggerEditor({ trigger, kind, token, providers, projects, sessions, busy, onCancel, onSave }: EditorContext & { trigger?: Trigger; kind: SourceKind; busy: boolean; onCancel: () => void; onSave: (input: TriggerInput) => void }) {
  const { t } = useI18n();
  const [input, setInput] = useState<TriggerInput>(() => trigger ? { name: trigger.name, enabled: trigger.enabled, source: trigger.source, handler: trigger.handler, policy: trigger.policy } : blankTrigger(kind));
  const source = input.source;
  const polled = source.kind !== 'schedule';
  // A coordinator exists only for GitHub; any other source runs a task.
  const task: TaskHandler = input.handler.kind === 'task' ? input.handler : { ...blankTrigger().handler as TaskHandler, approvals: input.handler.approvals };
  const coordinator = input.handler.kind === 'coordinator' ? input.handler : undefined;
  const setSource = (next: Source) => setInput(previous => ({ ...previous, source: next }));
  const setTask = (patch: Partial<TaskHandler>) => setInput({ ...input, handler: { ...task, ...patch } });
  const setMode = (mode: 'task' | 'coordinator') => setInput({ ...input, handler: mode === 'coordinator'
    ? { kind: 'coordinator', rules: coordinator?.rules ?? [newRule()], approvals: input.handler.approvals } : { ...task, approvals: input.handler.approvals } });
  const Icon = KIND_ICONS[source.kind];
  const whatTitle = source.kind === 'schedule' ? t('언제 실행할까요') : source.kind === 'http' ? t('무엇을 확인할까요') : t('어떤 이슈를 볼까요');
  return <form className="trigger-editor" onSubmit={event => { event.preventDefault(); onSave(input); }}><fieldset disabled={busy}>
    <header className="trigger-editor-head">
      <button type="button" className="icon-button" aria-label={t('목록으로')} onClick={onCancel}><ArrowLeft size={16} /></button>
      <Icon size={18} /><h3>{trigger ? t('{0} 트리거 편집', { 0: kindLabel(source.kind, t) }) : t('새 {0} 트리거', { 0: kindLabel(source.kind, t) })}</h3>
    </header>
    <label className="trigger-name">{t('이름')}<input required maxLength={120} placeholder={t(source.kind === 'github' ? '예: 새 버그 이슈 분류' : source.kind === 'http' ? '예: 상태 페이지 감시' : '예: 평일 아침 리포트')} value={input.name} onChange={event => setInput({ ...input, name: event.target.value })} /></label>
    <Section step={1} title={whatTitle}>
      {source.kind === 'schedule' && <ScheduleFields token={token} schedule={source.schedule} onChange={schedule => setSource({ ...source, schedule })} />}
      {source.kind === 'http' && <HttpFields token={token} source={source} onChange={setSource} />}
      {source.kind === 'github' && <GitHubFields token={token} source={source} onChange={setSource}
        onAccount={(login, auth) => setInput(previous => previous.source.kind === 'github' && JSON.stringify(previous.source.auth) === JSON.stringify(auth) ? { ...previous, source: { ...previous.source, account: login } } : previous)} />}
    </Section>
    {polled && <Section step={2} title={t('얼마나 자주 확인할까요')} hint={source.kind === 'github' ? t('확인하지 못한 사이에 생긴 이슈도 다음 확인에서 찾습니다.') : t('잠자기나 종료로 확인을 놓쳤다면 다시 켜진 뒤 한 번만 확인합니다.')}>
      <ScheduleFields polled token={token} schedule={source.schedule} onChange={schedule => setSource({ ...source, schedule })} />
    </Section>}
    <Section step={polled ? 3 : 2} title={t('무엇을 할까요')}>
      {source.kind === 'github' && <Choice label={t('처리 방식')} value={coordinator ? 'coordinator' : 'task'} onChange={setMode}
        options={[['task', t('이슈마다 작업 실행')], ['coordinator', t('코디네이터 (댓글은 승인 후 게시)')]]} />}
      {coordinator ? <CoordinatorFields handler={coordinator} providers={providers} onChange={next => setInput({ ...input, handler: next })} />
        : <TaskFields task={task} kind={source.kind} providers={providers} projects={projects} sessions={sessions} onChange={setTask} />}
    </Section>
    <AdvancedSettings input={input} onChange={setInput} />
    <footer className="trigger-editor-foot"><button type="button" className="secondary-button" onClick={onCancel}>{t('취소')}</button><button className="primary-button">{trigger ? t('저장') : t('만들기')}</button></footer>
  </fieldset></form>;
}

/** A schedule: at set times (cron) or every so many minutes. Sources that are checked start from the interval. */
function ScheduleFields({ token, schedule, onChange, polled = false }: { token: string; schedule: Source['schedule']; onChange: (schedule: Source['schedule']) => void; polled?: boolean }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<string[] | string>('');
  const showPreview = async () => {
    try { setPreview((await towerOperation<{ runs: string[] }>(token, 'triggers.preview', { schedule })).runs); }
    catch (cause) { setPreview(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <>
    <Choice label={t('방식')} value={schedule.type} onChange={type => { setPreview(''); onChange(type === 'interval' ? { type: 'interval', everySeconds: polled ? 300 : 3600 } : { type: 'cron', expression: polled ? '*/15 9-18 * * 1-5' : '0 9 * * 1-5', timezone: browserZone() }); }}
      options={polled ? [['interval', t('일정 간격')], ['cron', t('정한 시각 (크론)')]] : [['cron', t('정한 시각 (크론)')], ['interval', t('일정 간격')]]} />
    {schedule.type === 'cron' ? <div className="trigger-grid">
      <label>{t('크론 표현식')}<input required value={schedule.expression} onChange={event => { setPreview(''); onChange({ ...schedule, expression: event.target.value }); }} /><small>{t('분 시 일 월 요일 (예: 0 9 * * 1-5 = 평일 9시)')}</small></label>
      <label>{t('시간대')}<input required value={schedule.timezone} onChange={event => { setPreview(''); onChange({ ...schedule, timezone: event.target.value }); }} /></label>
    </div> : <label className="trigger-inline">{t('간격')}<span><input type="number" required min={1} max={44640} value={Math.round(schedule.everySeconds / 60)} onChange={event => { setPreview(''); onChange({ type: 'interval', everySeconds: Math.max(1, Number(event.target.value) || 1) * 60 }); }} />{t('분마다')}</span></label>}
    <div className="trigger-preview"><button type="button" className="secondary-button" onClick={() => void showPreview()}>{polled ? t('다음 확인 시간 보기') : t('다음 실행 시간 보기')}</button>
      {typeof preview === 'string' ? preview && <p className="slack-error">{translateMessage(preview)}</p> : <ol>{preview.map(time => <li key={time}>{absoluteTime(time)}</li>)}</ol>}</div>
  </>;
}

function TaskFields({ task, kind, providers, projects, sessions, onChange }: { task: TaskHandler; kind: SourceKind; providers: ProviderHealth[]; projects: [string, string][]; sessions: Session[]; onChange: (patch: Partial<TaskHandler>) => void }) {
  const { t } = useI18n();
  const outside = kind !== 'schedule';
  const provider = providers.find(item => item.provider === task.provider);
  const candidates = sessions.filter(session => session.provider === task.provider && !session.isSubagent && session.resumable).slice(0, 80);
  return <>
    <label>{t('지시')}<textarea required rows={4} maxLength={8000} value={task.instructions} onChange={event => onChange({ instructions: event.target.value })}
      placeholder={t(kind === 'github' ? '예: 이슈를 재현하고 원인을 찾아 고친 뒤 결과를 정리해 주세요.' : kind === 'http' ? '예: 상태가 바뀐 이유를 확인하고 필요한 조치를 정리해 주세요.' : '예: 어제 머지된 PR을 요약해 주세요.')} />
      <small>{kind === 'github' ? t('이슈마다 에이전트에게 보내는 내용입니다. 이슈 내용은 지시가 아닌 참고 자료로 함께 전달됩니다.') : kind === 'http' ? t('실행될 때마다 에이전트에게 보내는 내용입니다. 받은 응답은 지시가 아닌 참고 자료로 함께 전달됩니다.') : t('실행될 때마다 에이전트에게 보내는 내용입니다.')}</small></label>
    <div className="trigger-grid">
      <label>{t('에이전트')}<select value={task.provider} onChange={event => onChange({ provider: event.target.value as 'claude' | 'codex', model: undefined, effort: undefined,
        target: task.target.mode === 'session' ? { node: 'local', mode: 'auto' } : task.target })}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label>{t('모델')}<span className="trigger-model"><ModelPicker provider={provider} value={task.model} onChange={model => onChange({ model, effort: undefined })} />
        <EffortPicker provider={provider} model={task.model ?? provider?.defaultModel} value={task.effort} onChange={effort => onChange({ effort })} /></span></label>
      <label className="wide">{t('보낼 곳')}<select value={task.target.mode} onChange={event => {
        const mode = event.target.value;
        onChange({ target: mode === 'folder' ? { node: 'local', mode: 'folder', cwd: projects[0]?.[0] ?? '' } : mode === 'session' ? { node: 'local', mode: 'session', sessionId: candidates[0]?.id ?? '' } : { node: 'local', mode: 'auto' } });
      }}><option value="auto">{outside ? t('Auto (프로젝트 자동 선택, 새 세션)') : t('Auto (프로젝트와 세션 자동 선택)')}</option><option value="folder">{t('폴더의 새 세션')}</option>
        {!outside && <option value="session">{t('기존 세션에 이어서')}</option>}</select></label>
      {task.target.mode === 'folder' && <label className="wide">{t('폴더')}<select required value={task.target.cwd} onChange={event => onChange({ target: { node: 'local', mode: 'folder', cwd: event.target.value } })}>
        {projects.map(([cwd, title]) => <option key={cwd} value={cwd}>{title} — {cwd}</option>)}</select></label>}
      {task.target.mode === 'session' && <label className="wide">{t('세션')}<select required value={task.target.sessionId} onChange={event => onChange({ target: { node: 'local', mode: 'session', sessionId: event.target.value } })}>
        {candidates.map(session => <option key={session.id} value={session.id}>{sessionTitle(session)} — {session.project}</option>)}</select>
        {task.provider === 'codex' && <small>{t('기존 Codex 세션은 자체 승인 설정을 유지합니다.')}</small>}</label>}
    </div>
  </>;
}

const newRule = (): CoordinatorRule => ({ id: crypto.randomUUID(), name: '', enabled: true, condition: '', instructions: '', replyInstructions: '', provider: 'codex' });

/** Rules a GitHub coordinator follows, in the same editor Slack uses. */
function CoordinatorFields({ handler, providers, onChange }: { handler: CoordinatorHandler; providers: ProviderHealth[]; onChange: (handler: CoordinatorHandler) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<string | null>(handler.rules.length === 1 ? handler.rules[0].id : null);
  return <>
    <p className="trigger-note">{t('이슈마다 대화를 하나 엽니다. 코디네이터는 첫 번째로 맞는 지침 하나만 따르고, 작업은 프로젝트 에이전트에게 맡기며, 댓글은 Tower에서 승인해야 게시됩니다.')}</p>
    <SlackRules channel="github" autoReview={handler.approvals === 'auto'} rules={handler.rules} providers={providers} expanded={expanded} onExpand={setExpanded} onChange={rules => onChange({ ...handler, rules: rules as CoordinatorRule[] })} />
    {handler.rules.length < 20 && <button type="button" className="secondary-button trigger-add" onClick={() => { const rule = newRule(); onChange({ ...handler, rules: [...handler.rules, rule] }); setExpanded(rule.id); }}><Plus size={13} />{t('지침 추가')}</button>}
  </>;
}

const CONDITIONS: Array<[HttpCondition['type'], string]> = [['changed', '값이 바뀌면'], ['match', '조건을 만족하게 되면'], ['every-success', '응답이 올 때마다']];
const OPERATORS: Array<[Extract<HttpCondition, { type: 'match' }>['operator'], string]> = [['equals', '같음'], ['not-equals', '다름'], ['contains', '포함'], ['exists', '값이 있음'], ['gt', '보다 큼'], ['lt', '보다 작음']];

function HttpFields({ token, source, onChange }: { token: string; source: HttpSource; onChange: (source: HttpSource) => void }) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<TriggerSecret[]>([]);
  const [result, setResult] = useState<HttpTestResult | string>('');
  const [testing, setTesting] = useState(false);
  useEffect(() => { void towerOperation<{ secrets: TriggerSecret[] }>(token, 'secrets.list').then(value => setSecrets(value.secrets), () => setSecrets([])); }, [token]);
  const request = source.request;
  const condition = source.condition;
  const setRequest = (patch: Partial<HttpSource['request']>) => onChange({ ...source, request: { ...request, ...patch } });
  const setCondition = (next: HttpCondition) => onChange({ ...source, condition: next });
  const setHeader = (index: number, header: HttpSource['request']['headers'][number]) => setRequest({ headers: request.headers.map((item, position) => position === index ? header : item) });
  let origin = '';
  try { origin = new URL(request.url).origin; } catch { /* not a URL yet */ }
  const usable = secrets.filter(secret => secret.origin === origin);
  const test = async () => {
    setTesting(true); setResult('');
    try { setResult((await towerOperation<{ result: HttpTestResult }>(token, 'triggers.testHttp', { request, condition })).result); }
    catch (cause) { setResult(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTesting(false); }
  };
  return <>
    <div className="trigger-url">
      <select aria-label={t('메서드')} value={request.method} onChange={event => setRequest({ method: event.target.value as 'GET' | 'POST', ...(event.target.value === 'GET' ? { body: undefined } : {}) })}>
        <option value="GET">GET</option><option value="POST">POST</option></select>
      <input aria-label="URL" required type="url" maxLength={4000} placeholder="https://api.example.com/status" value={request.url} onChange={event => setRequest({ url: event.target.value })} />
    </div>
    <p className="trigger-note">{t('이 컴퓨터나 사설 네트워크 주소는 연결 탭에서 허용한 곳만 부를 수 있습니다.')}</p>
    {request.method === 'POST' && <label>{t('본문')}<textarea rows={3} maxLength={64000} value={request.body ?? ''} onChange={event => setRequest({ body: event.target.value || undefined })} /></label>}
    <div className="trigger-headers">
      {request.headers.map((header, index) => <div key={index} className="trigger-header-row">
        <input aria-label={t('헤더 이름')} placeholder={t('헤더 이름')} required maxLength={100} value={header.name} onChange={event => setHeader(index, { ...header, name: event.target.value })} />
        {'secretId' in header
          ? <select aria-label={t('비밀 값')} required value={header.secretId} onChange={event => setHeader(index, { name: header.name, secretId: event.target.value })}>
            <option value="">{t('비밀 값 선택')}</option>
            {secrets.filter(secret => secret.origin === origin || secret.id === header.secretId).map(secret => <option key={secret.id} value={secret.id}>{secret.name} — {secret.origin}</option>)}</select>
          : <input aria-label={t('헤더 값')} placeholder={t('값')} maxLength={4000} value={header.value} onChange={event => setHeader(index, { name: header.name, value: event.target.value })} />}
        <button type="button" className="secondary-button" title={t('값과 저장된 비밀 사이 전환')} onClick={() => setHeader(index, 'secretId' in header ? { name: header.name, value: '' } : { name: header.name, secretId: usable[0]?.id ?? '' })}>
          <KeyRound size={13} />{'secretId' in header ? t('값 직접 입력') : t('비밀 사용')}</button>
        <button type="button" className="icon-button" aria-label={t('헤더 삭제')} onClick={() => setRequest({ headers: request.headers.filter((_item, position) => position !== index) })}><Trash2 size={14} /></button>
      </div>)}
      {request.headers.length < 20 && <button type="button" className="secondary-button trigger-add" onClick={() => setRequest({ headers: [...request.headers, { name: '', value: '' }] })}><Plus size={13} />{t('헤더 추가')}</button>}
      {request.headers.some(header => 'secretId' in header) && !usable.length && <small>{t('이 주소에 쓸 수 있는 비밀이 없습니다. 연결 탭에서 이 주소용 비밀을 먼저 저장하세요.')}</small>}
    </div>
    <div className="trigger-field"><span>{t('실행 조건')}</span><Choice label={t('실행 조건')} value={condition.type} options={CONDITIONS.map(([value, label]) => [value, t(label)])}
      onChange={type => setCondition(type === 'match' ? { type: 'match', pointer: '', operator: 'equals', value: '' } : type === 'changed' ? { type: 'changed' } : { type: 'every-success' })} />
      {condition.type !== 'every-success' && <small>{t('처음 받은 응답은 기준으로만 쓰고 실행하지 않습니다.')}</small>}</div>
    {condition.type !== 'every-success' && <div className="trigger-grid">
      <label className={condition.type === 'match' ? '' : 'wide'}>{t('볼 값 (JSON Pointer)')}<input maxLength={500} placeholder={t('/status, 비우면 응답 전체')} value={condition.pointer ?? ''} onChange={event => setCondition({ ...condition, pointer: event.target.value || undefined })} /></label>
      {condition.type === 'match' && <label>{t('비교')}<span className="trigger-model">
        <select aria-label={t('비교')} value={condition.operator} onChange={event => setCondition({ ...condition, operator: event.target.value as typeof condition.operator })}>
          {OPERATORS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
        {condition.operator !== 'exists' && <input aria-label={t('값')} placeholder={t('값')} maxLength={1000} value={condition.value ?? ''} onChange={event => setCondition({ ...condition, value: event.target.value })} />}</span></label>}
    </div>}
    <div className="trigger-preview">
      <button type="button" className="secondary-button" disabled={testing || !request.url} onClick={() => void test()}>{testing ? t('보내는 중') : t('요청 테스트')}</button>
      {request.method === 'POST' && <small>{t('POST 요청은 테스트에서도 실제로 전송됩니다.')}</small>}
      {typeof result === 'string' ? result && <p className="slack-error">{translateMessage(result)}</p>
        : <div className="trigger-test-result">
          {result.status !== undefined && <strong>HTTP {result.status}{result.contentType ? ` · ${result.contentType}` : ''}</strong>}
          {result.error && <p className="slack-error">{translateMessage(result.error)}</p>}
          {result.selected !== undefined && <p>{t('선택한 값')}: <code>{typeof result.selected === 'string' ? result.selected : JSON.stringify(result.selected)}</code></p>}
          {result.matched !== undefined && <p>{result.matched ? t('지금 조건을 만족합니다.') : t('지금은 조건을 만족하지 않습니다.')}</p>}
          {result.body && <pre>{result.body}{result.truncated ? '\n…' : ''}</pre>}
        </div>}
    </div>
  </>;
}

const list = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);

function GitHubFields({ token, source, onChange, onAccount }: { token: string; source: GitHubSource; onChange: (source: GitHubSource) => void;
  /** Sets the checked account, only if the sign-in it was checked with is still the one chosen. */
  onAccount: (login: string, auth: GitHubSource['auth']) => void }) {
  const { t } = useI18n();
  const [secrets, setSecrets] = useState<TriggerSecret[]>([]);
  const [check, setCheck] = useState<GitHubCheck | string>('');
  const [checking, setChecking] = useState(false);
  const checks = useRef(0);
  const reset = () => { checks.current++; setCheck(''); setChecking(false); };
  // Typed text is kept as written, so a trailing line does not vanish while typing.
  const [repos, setRepos] = useState(source.watch.repos?.join('\n') ?? '');
  useEffect(() => { void towerOperation<{ secrets: TriggerSecret[] }>(token, 'secrets.list').then(value => setSecrets(value.secrets.filter(secret => secret.origin === GITHUB_API)), () => setSecrets([])); }, [token]);
  const watch = source.watch;
  const setWatch = (next: GitHubSource['watch']) => onChange({ ...source, watch: next });
  // Each kind of watch keeps its own filters, so switching away and back loses none of them.
  const kept = useRef<Partial<Record<GitHubSource['watch']['type'], GitHubSource['watch']>>>({ [watch.type]: watch });
  const switchWatch = (type: GitHubSource['watch']['type']) => { kept.current[watch.type] = watch; setWatch(switchedWatch(kept.current, type, list(repos))); };
  const verify = async () => {
    setChecking(true); setCheck('');
    const auth = source.auth;
    const asked = ++checks.current;
    try {
      const result = (await towerOperation<{ result: GitHubCheck }>(token, 'triggers.checkGitHub', { auth })).result;
      // A reply to a check started before the sign-in changed is not shown.
      if (asked !== checks.current) return;
      setCheck(result);
      if (result.ok && result.login) onAccount(result.login, auth);
    } catch (cause) { if (asked === checks.current) setCheck(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (asked === checks.current) setChecking(false); }
  };
  return <>
    <Choice label={t('무엇을 볼까요')} value={watch.type} onChange={switchWatch}
      options={[['issue-opened', t('저장소에 새로 열린 이슈')], ['assigned-to-me', t('나에게 새로 할당된 이슈')]]} />
    <label>{t('저장소')}<textarea rows={2} required={watch.type === 'issue-opened'} placeholder="owner/name" value={repos} onChange={event => { setRepos(event.target.value); const names = list(event.target.value);
      setWatch(watch.type === 'issue-opened' ? { ...watch, repos: names } : { ...watch, ...(names.length ? { repos: names } : { repos: undefined }) }); }} />
      <small>{watch.type === 'issue-opened' ? t('한 줄에 하나씩 owner/name. 처음 확인할 때 이미 있던 이슈로는 실행하지 않습니다.') : t('비우면 모든 저장소. 한 줄에 하나씩 owner/name.')}</small></label>
    <div className="trigger-account">
      <label>{t('GitHub 계정')}<select value={source.auth.type} onChange={event => { reset(); onChange({ ...source, account: '', auth: event.target.value === 'token' ? { type: 'token', secretId: secrets[0]?.id ?? '' } : { type: 'gh' } }); }}>
        <option value="gh">{t('이 컴퓨터의 gh 로그인')}</option><option value="token">{t('저장한 토큰')}</option></select></label>
      {source.auth.type === 'token' && <label>{t('토큰')}<select required value={source.auth.secretId} onChange={event => { reset(); onChange({ ...source, account: '', auth: { type: 'token', secretId: event.target.value } }); }}>
        <option value="">{t('비밀 값 선택')}</option>{secrets.map(secret => <option key={secret.id} value={secret.id}>{secret.name}</option>)}</select></label>}
      <button type="button" className="secondary-button" disabled={checking} onClick={() => void verify()}>{checking ? t('확인 중') : t('연결 확인')}</button>
    </div>
    {typeof check === 'string' ? check ? <p className="slack-error">{translateMessage(check)}</p>
      : <p className={source.account ? 'trigger-note' : 'trigger-note trigger-warn'}>{source.account ? t('{0} 계정으로 확인합니다.', { 0: source.account }) : t('저장하기 전에 연결을 확인해 계정을 정하세요.')}</p>
      : check.ok ? <p className="trigger-note">{t('{0} 계정으로 확인합니다.', { 0: check.login ?? '' })}</p> : <p className="slack-error">{translateMessage(check.error ?? '')}</p>}
    {source.auth.type === 'token' && !secrets.length && <p className="trigger-note">{t('연결 탭에서 https://api.github.com 용 비밀로 토큰을 먼저 저장하세요.')}</p>}
  </>;
}

/** Settings most triggers keep as they are, with what is chosen shown on the closed summary. */
function AdvancedSettings({ input, onChange }: { input: TriggerInput; onChange: (input: TriggerInput) => void }) {
  const { t } = useI18n();
  const source = input.source;
  const approvals = input.handler.approvals;
  const setApprovals = (value: 'auto' | 'owner') => onChange({ ...input, handler: { ...input.handler, approvals: value } as TriggerInput['handler'] });
  const overlapLabels: Record<TriggerInput['policy']['overlap'], string> = { skip: '겹치면 건너뛰기', queue: '겹치면 하나만 대기', parallel: '겹쳐도 동시에 실행' };
  const summary = [approvals === 'auto' ? t('자동 승인') : t('직접 승인'), t(overlapLabels[input.policy.overlap]), t('시간당 {0}회', { 0: input.policy.maxEventsPerHour })];
  const watch = source.kind === 'github' ? source.watch : undefined;
  const setWatch = (next: GitHubSource['watch']) => { if (source.kind === 'github') onChange({ ...input, source: { ...source, watch: next } }); };
  return <details className="trigger-advanced"><summary><strong>{t('고급 설정')}</strong><span>{summary.join(' · ')}</span></summary>
    <div className="trigger-grid">
      <label className="wide">{t('승인')}<select value={approvals} onChange={event => setApprovals(event.target.value as 'auto' | 'owner')}>
        <option value="auto">{input.handler.kind === 'coordinator' ? t('맡긴 작업은 자동 승인 (사람 개입 최소)') : t('자동 승인 (사람 개입 최소)')}</option>
        <option value="owner">{input.handler.kind === 'coordinator' ? t('맡긴 작업도 직접 승인 (Tower에서 대기)') : t('직접 승인 (Tower에서 대기)')}</option></select></label>
      <label>{t('이전 실행이 끝나지 않았을 때')}<select value={input.policy.overlap} onChange={event => onChange({ ...input, policy: { ...input.policy, overlap: event.target.value as 'skip' | 'queue' | 'parallel' } })}>
        <option value="skip">{t('건너뛰기')}</option><option value="queue">{t('하나만 대기')}</option><option value="parallel">{t('동시에 실행')}</option></select></label>
      <label>{t('시간당 최대 실행')}<input type="number" min={1} max={60} value={input.policy.maxEventsPerHour} onChange={event => onChange({ ...input, policy: { ...input.policy, maxEventsPerHour: Math.min(60, Math.max(1, Number(event.target.value) || 1)) } })} />
        <small>{t('넘으면 자동으로 일시 정지합니다.')}</small></label>
      {source.kind === 'schedule' && <label className="wide">{t('놓친 실행')}<select value={source.catchUp} onChange={event => onChange({ ...input, source: { ...source, catchUp: event.target.value as 'latest' | 'skip' } })}>
        <option value="latest">{t('하루 안에 놓친 가장 최근 시간을 한 번 실행')}</option><option value="skip">{t('건너뛰기')}</option></select>
        <small>{t('컴퓨터가 잠자기 상태였거나 Tower가 꺼져 있던 동안의 실행')}</small></label>}
      {source.kind === 'http' && <label>{t('제한 시간 (초)')}<input type="number" min={1} max={45} value={source.request.timeoutSeconds} onChange={event => onChange({ ...input, source: { ...source, request: { ...source.request, timeoutSeconds: Math.min(45, Math.max(1, Number(event.target.value) || 1)) } } })} /></label>}
      {/* Keyed by the kind of watch, so what the fields show always matches what is saved. */}
      {watch?.type === 'issue-opened' && <IssueFilters key={watch.type} watch={watch} onChange={setWatch} />}
      {watch?.type === 'assigned-to-me' && <label className="trigger-checkbox wide"><input type="checkbox" checked={watch.includePullRequests} onChange={event => setWatch({ ...watch, includePullRequests: event.target.checked })} />{t('풀 리퀘스트도 포함')}</label>}
    </div>
  </details>;
}

type IssueWatch = Extract<GitHubSource['watch'], { type: 'issue-opened' }>;
/** Which new issues count: labels, authors, and how the author relates to the repository. */
function IssueFilters({ watch, onChange }: { watch: IssueWatch; onChange: (watch: IssueWatch) => void }) {
  const { t } = useI18n();
  // Typed text is kept as written, so a trailing comma does not vanish while typing.
  const [labels, setLabels] = useState(watch.labels?.join(', ') ?? '');
  const [authors, setAuthors] = useState(watch.authors?.join(', ') ?? '');
  const association = watch.authorAssociation === 'any' ? 'any' : [...watch.authorAssociation].sort().join() === [...MEMBERS].sort().join() ? 'members' : 'custom';
  return <>
    <label>{t('라벨')}<input value={labels} onChange={event => { setLabels(event.target.value); const names = list(event.target.value); onChange({ ...watch, labels: names.length ? names : undefined }); }} /><small>{t('쉼표로 구분, 하나라도 있으면')}</small></label>
    <label>{t('작성자')}<input value={authors} onChange={event => { setAuthors(event.target.value); const names = list(event.target.value); onChange({ ...watch, authors: names.length ? names : undefined }); }} /><small>{t('쉼표로 구분, 비우면 누구나')}</small></label>
    <label className="wide">{t('작성자 범위')}<select value={association} onChange={event => { if (event.target.value !== 'custom') onChange({ ...watch, authorAssociation: event.target.value === 'any' ? 'any' : [...MEMBERS] }); }}>
      <option value="members">{t('저장소 소유자·멤버·협업자 (권장)')}</option><option value="any">{t('누구나 (공개 저장소라면 외부인도)')}</option>
      {association === 'custom' && watch.authorAssociation !== 'any' && <option value="custom">{watch.authorAssociation.join(', ')}</option>}</select></label>
  </>;
}

