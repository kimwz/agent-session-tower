import type { SlackFollowUp, SlackWorkflow, SlackWorkflowState } from '../../../shared/slack';
import { translate } from '../i18n/i18n';

const active = new Set<SlackWorkflowState>(['received', 'matching', 'dispatching', 'running', 'composing', 'sending']);
const labels: Record<SlackWorkflowState, string> = {
  received: '접수됨', matching: '지침 확인 중', ignored: '해당 없음',
  dispatching: '작업 준비 중', running: '작업 중', composing: '댓글 작성 중',
  sending: '댓글 전송 중', completed: '완료', error: '오류', 'admission-uncertain': '작업 접수 확인 필요', 'reply-uncertain': '댓글 전송 확인 필요',
};
export function slackWorkflowWorking(value: SlackWorkflow | SlackWorkflowState): boolean {
  return active.has(typeof value === 'string' ? value : value.status);
}
export function slackWorkflowLabel(value: SlackWorkflow | SlackWorkflowState): string {
  return translate(labels[typeof value === 'string' ? value : value.status]);
}
export function slackMentionTitle(event: SlackWorkflow): string {
  const text = event.mention.text.replace(/<@[^>]+>/g, '').replace(/<([^>|]+)\|([^>]+)>/g, '$2').replace(/\s+/g, ' ').trim();
  return text.slice(0, 160) || event.rule?.name || translate('Slack 멘션');
}
/** Follow-ups the conversation took up or is taking up; unjudged, skipped and failed ones are not its activity. */
const takenUp = new Set<SlackFollowUp['status']>(['pending', 'delivering', 'delivered', 'uncertain']);
/** When the conversation last had something new: its mention, or the latest later message it took up. */
export function slackActivityAt(event: SlackWorkflow): string {
  return (event.followUps ?? []).reduce((latest, followUp) => takenUp.has(followUp.status) && followUp.receivedAt > latest ? followUp.receivedAt : latest, event.createdAt);
}
/** Most recent activity first; the id settles ties so the order never flickers. */
export function compareSlackActivity(a: SlackWorkflow, b: SlackWorkflow): number {
  return slackActivityAt(b).localeCompare(slackActivityAt(a)) || b.id.localeCompare(a.id);
}
