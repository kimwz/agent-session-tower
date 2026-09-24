import type { LucideIcon } from 'lucide-react';
import { CalendarClock, CircleDot, Globe, Slack } from 'lucide-react';
import { useI18n } from '../i18n/i18n';
import type { SourceKind } from './trigger-helpers';

export const KIND_ICONS: Record<SourceKind | 'slack', LucideIcon> = { schedule: CalendarClock, http: Globe, github: CircleDot, slack: Slack };

const KINDS: Array<{ kind: SourceKind | 'slack'; title: string; description: string }> = [
  { kind: 'schedule', title: '예약 실행', description: '정한 시간이나 간격마다 지시를 실행합니다.' },
  { kind: 'github', title: 'GitHub 이슈', description: '저장소에 새 이슈가 열리거나 나에게 할당되면 실행합니다.' },
  { kind: 'http', title: 'HTTP 응답', description: 'URL을 주기적으로 확인해 응답이 바뀌거나 조건에 맞으면 실행합니다.' },
  { kind: 'slack', title: 'Slack 멘션', description: 'Slack에서 나를 멘션하면 지침에 따라 처리합니다.' },
];

/**
 * The kinds of trigger, as the first choice when adding one. Slack is set up in its own panel. On another computer
 * (`remote`) only the kinds that need nothing checked there are offered: Slack and GitHub sign-ins stay with it.
 */
export function TriggerTypePicker({ onPick, onSlack, slackConnected, remote = false }: { onPick: (kind: SourceKind) => void; onSlack?: () => void; slackConnected: boolean; remote?: boolean }) {
  const { t } = useI18n();
  return <ul className="trigger-picker">{KINDS.filter(({ kind }) => !remote || (kind !== 'slack' && kind !== 'github')).map(({ kind, title, description }) => {
    const Icon = KIND_ICONS[kind];
    return <li key={kind}><button type="button" onClick={() => kind === 'slack' ? onSlack?.() : onPick(kind)}>
      <Icon size={20} /><span><strong>{t(title)}</strong><small>{kind === 'slack' && slackConnected ? t('연결됨 · 지침과 설정은 Slack 창에서 바꿉니다.') : t(description)}</small></span>
    </button></li>;
  })}</ul>;
}
