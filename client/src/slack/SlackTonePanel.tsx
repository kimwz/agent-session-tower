import { useEffect, useState } from 'react';
import type { SlackPublicStatus } from '../../../shared/slack';
import { useI18n } from '../i18n/i18n';
import { authPost } from '../auth/AuthGate';
import { SLACK_CHANGED_EVENT } from './use-slack-monitor';

export function SlackTonePanel({ slack, token }: { slack: SlackPublicStatus; token: string }) {
  const { language } = useI18n();
  const ko = language === 'ko';
  const tone = slack.tone;
  const [guide, setGuide] = useState(tone?.guide ?? '');
  const [enabled, setEnabled] = useState(tone?.enabled ?? false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!dirty) { setGuide(tone?.guide ?? ''); setEnabled(tone?.enabled ?? false); } }, [tone?.guide, tone?.enabled]);
  async function act(action: string, body: unknown) {
    setBusy(true); setError('');
    try { await authPost(`/api/slack/tone/${action}`, token, body); setDirty(false); window.dispatchEvent(new Event(SLACK_CHANGED_EVENT)); }
    catch { setError(ko ? '설정을 저장하지 못했습니다.' : 'Could not update tone settings.'); }
    finally { setBusy(false); }
  }
  return <details className="slack-tone-panel"><summary>{ko ? '말투 수집' : 'Writing style'}</summary>
    <p>{ko ? '최근 90일 내 내 메시지 최대 200개를 모델로 분석합니다. 원문은 Tower에 저장하지 않으며 생성된 가이드를 검토한 뒤 사용을 켜세요.' : 'Analyze up to 200 of your messages from the last 90 days with the model. Tower does not store the samples. Review the generated guide before enabling it.'}</p>
    <p>{ko ? '사용자 토큰에 search:read 권한이 필요합니다. 권한 추가 후 Slack 앱을 재설치하고 토큰을 다시 연결하세요.' : 'Requires search:read on your user token. After adding it, reinstall the Slack app and reconnect the token.'}</p>
    <button className="secondary-button" disabled={busy || dirty || !token || !slack.connected || tone?.status === 'collecting'} onClick={() => void act('collect', {})}>{tone?.status === 'collecting' ? ko ? '말투 수집 중…' : 'Collecting…' : ko ? '내 메시지에서 수집' : 'Collect my messages'}</button>
    {tone?.sampleCount !== undefined && <p role="status">{ko ? `분석한 메시지 ${tone.sampleCount}개 · 검토 후 사용 설정` : `${tone.sampleCount} messages analyzed · Review before enabling`}</p>}
    {tone?.error && <p role="alert">{ko ? tone.error : tone.error.startsWith('search:read') ? 'Add search:read, reinstall the Slack app and reconnect your user token.' : 'Collection failed. Check the connection and model, or write a guide manually.'}</p>}{error && <p role="alert">{error}</p>}
    <label style={{ display: 'grid', gap: 6, marginTop: 10 }}>{ko ? '말투 가이드' : 'Style guide'}<textarea disabled={busy} rows={6} maxLength={4000} value={guide} onChange={event => { setGuide(event.target.value); setDirty(true); }} /></label>
    <label className="slack-check"><input type="checkbox" disabled={busy} checked={enabled} onChange={event => { setEnabled(event.target.checked); setDirty(true); }} />{ko ? '답변 제안 작성에 사용' : 'Use for reply proposals'}</label>
    <div className="slack-actions"><button className="secondary-button" disabled={busy || !dirty || !token} onClick={() => void act('save', { guide, enabled })}>{ko ? '저장' : 'Save'}</button><button className="secondary-button" disabled={busy || !token} onClick={() => { setGuide(''); setEnabled(false); void act('save', { guide: '', enabled: false }); }}>{ko ? '초기화' : 'Reset'}</button></div>
  </details>;
}
