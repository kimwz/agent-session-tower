import type { LucideIcon } from 'lucide-react';
import { CalendarClock, CircleDot, Globe, Globe2, Slack } from 'lucide-react';
import { useI18n } from '../i18n/i18n';
import type { SourceKind } from './trigger-helpers';

export const KIND_ICONS: Record<SourceKind | 'slack' | 'public', LucideIcon> = { schedule: CalendarClock, http: Globe, github: CircleDot, slack: Slack, public: Globe2 };

const KINDS: Array<{ kind: SourceKind | 'slack' | 'public'; title: string; description: string }> = [
  { kind: 'schedule', title: '예약 실행', description: '정한 시간이나 간격마다 지시를 실행합니다.' },
  { kind: 'github', title: 'GitHub 이슈', description: '저장소에 새 이슈가 열리거나 나에게 할당되면 실행합니다.' },
  { kind: 'http', title: 'HTTP 응답', description: 'URL을 주기적으로 확인해 응답이 바뀌거나 조건에 맞으면 실행합니다.' },
  { kind: 'slack', title: 'Slack 멘션', description: 'Slack에서 나를 멘션하면 지침에 따라 처리합니다.' },
  { kind: 'public', title: '공개 에이전트', description: '외부 사용자가 정해 둔 범위 안에서 작업을 요청하고 결과를 받는 공개 페이지를 만듭니다.' },
];

/**
 * The kinds of trigger, as the first choice when adding one. Slack is set up in its own panel. On another computer
 * (`remote`) only the kinds that need nothing checked there are offered: Slack and GitHub sign-ins stay with it, and
 * public agents are published from the computer that serves them.
 */
export function TriggerTypePicker({ onPick, onSlack, onPublic, slackConnected, remote = false }: { onPick: (kind: SourceKind) => void; onSlack?: () => void; onPublic?: () => void; slackConnected: boolean; remote?: boolean }) {
  const { t } = useI18n();
  return <ul className="trigger-picker">{KINDS.filter(({ kind }) => !remote || (kind !== 'slack' && kind !== 'github' && kind !== 'public')).map(({ kind, title, description }) => {
    const Icon = KIND_ICONS[kind];
    return <li key={kind}><button type="button" onClick={() => kind === 'slack' ? onSlack?.() : kind === 'public' ? onPublic?.() : onPick(kind)}>
      <Icon size={20} /><span><strong>{t(title)}</strong><small>{kind === 'slack' && slackConnected ? t('연결됨 · 지침과 설정은 Slack 창에서 바꿉니다.') : t(description)}</small></span>
    </button></li>;
  })}</ul>;
}
