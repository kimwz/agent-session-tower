import type { SlackWorkflow, SlackWorkflowState } from '../../../shared/slack';
import { translate } from '../i18n/i18n';

const active = new Set<SlackWorkflowState>(['received', 'matching', 'dispatching', 'running', 'composing', 'sending']);
const labels: Record<SlackWorkflowState, string> = {
  received: '접수됨', matching: '지침 확인 중', ignored: '해당 없음',
  dispatching: '작업 준비 중', running: '작업 중', composing: '댓글 작성 중',
  sending: '댓글 전송 중', completed: '완료', error: '오류', 'reply-uncertain': '댓글 전송 확인 필요',
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
