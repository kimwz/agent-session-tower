import type { SlackWorkflow } from '../../../shared/slack';
/** Where the Slack monitor was left before it became the trigger monitor; read once to carry it over. */
export const SLACK_POSITION_KEY = 'tower.slack-monitor.position.v1';
export const SLACK_PAGE_SIZE = 5;
export function slackMentionLayout(count: number, hasMore: boolean) {
  return {
    width: 344,
    height: 116 + Math.max(1, count) * 78 + (hasMore ? 42 : 12),
    positions: Array.from({ length: count }, (_, index) => ({ x: 16, y: 116 + index * 78 })),
  };
}
export function parseSlackPosition(value: string | null): { x: number; y: number } | null {
  try { const p = JSON.parse(value || 'null'); return p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null; } catch { return null; }
}
export function visibleSlackMentions(events: SlackWorkflow[], limit: number, selected?: string | null) {
  const sorted = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const result = sorted.slice(0, limit);
  const selectedEvent = sorted.find(event => event.id === selected);
  if (selectedEvent && !result.some(event => event.id === selected)) result.push(selectedEvent);
  return result;
}
