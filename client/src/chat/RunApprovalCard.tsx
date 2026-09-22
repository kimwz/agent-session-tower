import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { Check, ExternalLink, GitBranch, LoaderCircle, ShieldQuestion, X } from 'lucide-react';
import type { RunApproval, RunApprovalResponse } from '../../../shared/types';
import { mcpFormUnsupportedReason, validateApprovalResponse } from '../../../shared/approval-interactions';
import { translate as t, translateMessage, useI18n } from '../i18n/i18n';
import { approvalDecisionState, formApprovalContent, safeApprovalUrl, submitApprovalDecision, subscribeApprovalDecisions } from './chat-approvals';

type FieldSchema = Record<string, unknown>;
function choices(schema: FieldSchema): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) return schema.enum.map((value, index) => ({ value: String(value), label: String(Array.isArray(schema.enumNames) ? schema.enumNames[index] ?? value : value) }));
  const options = schema.oneOf ?? schema.anyOf;
  return Array.isArray(options) ? options.map(option => ({ value: String(option.const), label: String(option.title ?? option.const) })) : [];
}

function FormField({ name, schema, required, value, update, disabled }: { name: string; schema: FieldSchema; required: boolean; value: unknown; update: (value: unknown) => void; disabled: boolean }) {
  const title = typeof schema.title === 'string' ? schema.title : name;
  const options = choices(schema.type === 'array' ? schema.items as FieldSchema : schema);
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  const label = <>{title}{required && <span className="run-approval-required">{t('필수')}</span>}</>;
  if (schema.type === 'array') return <fieldset className="run-approval-field" disabled={disabled}>
    <legend>{label}</legend>{description && <p>{description}</p>}
    {options.map(option => <label className="run-approval-option" key={option.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={event => update(event.target.checked ? [...(Array.isArray(value) ? value : []), option.value] : (Array.isArray(value) ? value : []).filter(item => item !== option.value))} /><span>{option.label}</span></label>)}
    {(typeof schema.minItems === 'number' || typeof schema.maxItems === 'number') && <small>{t('선택 수: {0}–{1}', { 0: typeof schema.minItems === 'number' ? schema.minItems : 0, 1: typeof schema.maxItems === 'number' ? schema.maxItems : options.length })}</small>}
  </fieldset>;
  const select = options.length > 0 || schema.type === 'boolean';
  const numeric = schema.type === 'number' || schema.type === 'integer';
  return <label className="run-approval-field"><span>{label}</span>{description && <small>{description}</small>}
    {select ? <select disabled={disabled} required={required} value={value === undefined ? '' : schema.type === 'boolean' ? String(value) : String(options.findIndex(option => option.value === value))} onChange={event => update(event.target.value === '' ? undefined : schema.type === 'boolean' ? event.target.value === 'true' : options[Number(event.target.value)]?.value)}>
      <option value="">{t('선택하세요')}</option>
      {schema.type === 'boolean' ? <><option value="true">{t('예')}</option><option value="false">{t('아니요')}</option></> : options.map((option, index) => <option value={String(index)} key={option.value}>{option.label || t('빈 값')}</option>)}
    </select> : <input disabled={disabled} required={required && (numeric || typeof schema.format === 'string' || (typeof schema.minLength === 'number' && schema.minLength > 0))} type={numeric ? 'number' : schema.format === 'email' ? 'email' : schema.format === 'date' ? 'date' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''} autoComplete="off"
      min={typeof schema.minimum === 'number' ? schema.minimum : undefined} max={typeof schema.maximum === 'number' ? schema.maximum : undefined} step={numeric ? schema.type === 'integer' ? 1 : 'any' : undefined}
      minLength={typeof schema.minLength === 'number' ? schema.minLength : undefined} maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined}
      placeholder={schema.format === 'date-time' ? '2026-09-17T12:00:00Z' : schema.format === 'uri' ? 'https://…' : undefined}
      onChange={event => update(numeric ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value)} />}
  </label>;
}

export const RunApprovalCard = memo(function RunApprovalCard({ runId, approval, token, disabled = false, onSnapshotRefresh }: {
  runId: string; approval: RunApproval; token: string; disabled?: boolean; onSnapshotRefresh: () => void;
}) {
  useI18n();
  const state = useSyncExternalStore(subscribeApprovalDecisions, () => approvalDecisionState(runId, approval.id), () => approvalDecisionState(runId, approval.id));
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, { selection?: string; selections?: string[]; text?: string }>>({});
  const [content, setContent] = useState<Record<string, unknown>>({});
  const interaction = approval.interaction;
  const fields = Object.entries(approval.input);
  const inactive = disabled || !token || state !== 'idle';
  const unsupported = interaction?.type === 'mcp-form' ? mcpFormUnsupportedReason(interaction.schema) : undefined;
  const url = interaction?.type === 'mcp-url' ? safeApprovalUrl(interaction.url) : undefined;
  const cannotAccept = !!unsupported || (interaction?.type === 'mcp-url' && !url);

  useEffect(() => {
    if (state === 'settled') { setAnswers({}); setContent({}); onSnapshotRefresh(); }
  }, [state, onSnapshotRefresh]);

  async function decide(response: RunApprovalResponse) {
    if (inactive) return;
    setError('');
    try {
      validateApprovalResponse(approval, response);
      await submitApprovalDecision(runId, approval.id, response, token);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('승인 결정을 보내지 못했습니다. 다시 시도하세요.'));
    }
  }

  function accept() {
    if (cannotAccept) return;
    if (interaction?.type === 'questions') {
      const response = Object.fromEntries(interaction.questions.map(question => {
        const answer = answers[question.id];
        const option = question.options?.[Number(answer?.selection)];
        const value = answer?.selection !== undefined && answer.selection !== 'other' ? option?.label : answer?.text;
        const values = question.multiSelect ? (answer?.selections || []).flatMap(selection => selection === 'other' ? answer?.text ? [answer.text] : [] : [question.options![Number(selection)].label]) : value === undefined || value === '' ? [] : [value];
        return [question.id, { answers: values }];
      }));
      void decide({ answers: response });
    } else if (interaction) void decide({ action: 'accept', content: interaction.type === 'mcp-form' ? formApprovalContent(interaction.schema, content) : null });
    else void decide('allow');
  }

  return <section className="run-approval" aria-label={interaction ? t('응답 요청') : t('작업 승인 요청')} data-approval-id={approval.id} aria-busy={state === 'submitting'}>
    <form onSubmit={event => { event.preventDefault(); accept(); }} autoComplete="off">
      <div className="run-approval-heading"><ShieldQuestion size={14} aria-hidden="true" /><strong>{approval.toolName}</strong><span>{interaction ? t('응답 필요') : t('승인 필요')}</span></div>
      {approval.origin && <div className="run-approval-origin" title={approval.origin.threadId}><GitBranch size={11} aria-hidden="true" /><span>{t('하위 에이전트')}: {approval.origin.agentName || approval.origin.threadId}</span></div>}
      <div className={`run-approval-details${interaction ? ' run-approval-interaction' : ''}`}>
        {approval.description && <p className="run-approval-description">{approval.description}</p>}
        {interaction?.type === 'questions' ? interaction.questions.map(question => {
          const answer = answers[question.id];
          const options = question.options || [];
          const freeText = !options.length || (question.multiSelect ? answer?.selections?.includes('other') : answer?.selection === 'other');
          const update = (value: { selection?: string; selections?: string[]; text?: string }) => setAnswers(previous => ({ ...previous, [question.id]: { ...previous[question.id], ...value } }));
          const selected = (value: string) => question.multiSelect ? !!answer?.selections?.includes(value) : answer?.selection === value;
          const choose = (value: string) => question.multiSelect
            ? update({ selections: selected(value) ? answer!.selections!.filter(item => item !== value) : [...(answer?.selections || []), value] })
            : update({ selection: value, text: undefined });
          return <fieldset className="run-approval-field" key={question.id} disabled={inactive}>
            <legend>{question.header}</legend><p>{question.question}</p>
            {options.map((option, index) => <label className="run-approval-option" key={index}><input type={question.multiSelect ? "checkbox" : "radio"} name={`${runId}:${approval.id}:${question.id}`} required={!question.multiSelect} checked={selected(String(index))} onChange={() => choose(String(index))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}
            {options.length > 0 && question.isOther && <label className="run-approval-option"><input type={question.multiSelect ? "checkbox" : "radio"} name={`${runId}:${approval.id}:${question.id}`} checked={selected('other')} onChange={() => choose('other')} /><span>{t('직접 입력')}</span></label>}
            {freeText && <label className="run-approval-answer"><span>{question.isSecret ? t('비밀 답변') : t('답변')}</span><input type={question.isSecret ? 'password' : 'text'} required value={answer?.text || ''} autoComplete={question.isSecret ? 'new-password' : 'off'} onChange={event => update({ text: event.target.value })} /></label>}
          </fieldset>;
        }) : interaction?.type === 'mcp-form' ? <>
          <p className="run-approval-server">{t('서버')}: {interaction.serverName}</p>
          {unsupported ? <><p role="alert" className="run-approval-error">{t('이 양식 형식은 지원하지 않습니다. 원래 앱에서 계속하거나 거절하세요.')}</p><details><summary>{t('요청한 양식 보기')}</summary><pre>{JSON.stringify(interaction.schema, null, 2)}</pre></details></> : Object.entries(interaction.schema.properties as Record<string, FieldSchema>).map(([name, schema]) => <FormField key={name} name={name} schema={schema} required={Array.isArray(interaction.schema.required) && interaction.schema.required.includes(name)} value={Object.hasOwn(content, name) ? content[name] : undefined} disabled={inactive} update={value => setContent(previous => {
            const next = { ...previous }; if (value === undefined) delete next[name]; else Object.defineProperty(next, name, { value, enumerable: true, configurable: true, writable: true }); return next;
          })} />)}
        </> : interaction?.type === 'mcp-url' ? <>
          <p className="run-approval-server">{t('서버')}: {interaction.serverName}</p>
          <p>{t('링크에서 작업을 완료한 후 확인하세요.')}</p>
          {url ? <a className="run-approval-link" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><ExternalLink size={12} aria-hidden="true" />{interaction.url}</a> : <p role="alert" className="run-approval-error">{t('안전하게 열 수 없는 링크입니다.')}</p>}
        </> : fields.length ? <dl>{fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></dd></div>)}</dl> : <p className="run-approval-description">{t('추가 입력 없음')}</p>}
      </div>
      {error && <p className="run-approval-error" role="alert">{translateMessage(error)}</p>}
      <div className="run-approval-actions">
        <span role="status">{state !== 'idle' && <LoaderCircle size={11} className="spin" aria-hidden="true" />}{state === 'submitting' ? t('결정 보내는 중…') : state === 'settled' ? t('작업 상태 갱신 중…') : interaction ? t('검토 후 응답을 보내세요.') : approval.scope === 'turn' ? t('요청한 권한은 이번 턴에만 적용됩니다.') : t('이 작업에만 적용됩니다.')}</span>
        {interaction && interaction.type !== 'questions' && <button type="button" disabled={inactive} onClick={() => { void decide({ action: 'cancel', content: null }); }}>{t('취소')}</button>}
        <button type="button" disabled={inactive} onClick={() => { void decide('deny'); }}><X size={12} aria-hidden="true" />{interaction?.type === 'questions' ? t('답변 취소') : t('거절')}</button>
        <button type="submit" className="run-approval-allow" disabled={inactive || cannotAccept}><Check size={12} aria-hidden="true" />{interaction?.type === 'questions' ? t('답변 보내기') : interaction?.type === 'mcp-url' ? t('완료 확인') : interaction?.type === 'mcp-form' ? t('제출') : approval.scope === 'turn' ? t('이번 턴에 허용') : t('한 번 허용')}</button>
      </div>
    </form>
  </section>;
});
