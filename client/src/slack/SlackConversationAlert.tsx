import { TriangleAlert } from 'lucide-react';
import type { SlackWorkflow } from '../../../shared/slack';
import { translateMessage } from '../i18n/i18n';

export function SlackConversationAlert({ workflow }: { workflow?: SlackWorkflow }) {
  if (workflow?.mode !== 'conversation' || !workflow.error) return null;
  return <div className="inline-error" role="alert"><TriangleAlert size={15} /><span>{translateMessage(workflow.error)}</span></div>;
}
