import type { SlackWorkflow } from '../../../shared/slack';

export function slackCoordinatorSessionIds(events: SlackWorkflow[]) {
  return new Set(events.filter(event => event.mode === 'conversation' && event.sessionId).map(event => event.sessionId!));
}

export function slackChatSelection(events: SlackWorkflow[], requestedMentionId: string | null | undefined, sessionId: string | null) {
  const directMention = requestedMentionId === undefined && sessionId
    ? events.find(event => event.mode === 'conversation' && event.sessionId === sessionId)
    : undefined;
  const mentionId = directMention?.id ?? requestedMentionId;
  const mention = events.find(event => event.id === mentionId);
  return {
    mentionId,
    chatId: mentionId === undefined ? sessionId : mention?.mode === 'conversation' ? mention.sessionId || null : null,
  };
}
