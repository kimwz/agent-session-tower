import { useState } from 'react';
import { Check, Terminal } from 'lucide-react';
import type { Session } from '../../../shared/types';
import { copyText } from '../common/lib';
import { translate as t, useI18n } from '../i18n/i18n';
import { resumeCommand } from './resume-command';

export function ResumeCommandButton({ session, size = 16 }: { session: Session; size?: number }) {
  useI18n();
  const [copied, setCopied] = useState(false);
  const command = resumeCommand(session);
  if (!command) return null;
  return <button type="button" className="icon-button resume-command-button" aria-label={t("터미널에서 이어가는 명령 복사")} title={copied ? t("복사됨") : `${t("터미널에서 이어가는 명령 복사")}\n${command}`}
    onClick={() => { void copyText(command).then(success => { setCopied(success); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={size} /> : <Terminal size={size} />}</button>;
}
