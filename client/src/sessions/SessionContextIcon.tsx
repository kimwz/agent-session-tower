import type { Provider, SessionContextUsage } from '../../../shared/types';
import { ProviderIcon } from '../common/Icons';
import { useI18n } from '../i18n/i18n';
import { contextUsageLabel, contextUsageMeter } from './session-context-usage';

export function SessionContextIcon({ provider, usage, descriptionId }: { provider: Provider; usage?: SessionContextUsage; descriptionId: string }) {
  useI18n();
  const meter = contextUsageMeter(usage);
  const label = contextUsageLabel(usage);
  return <span className={`agent-orb-wrap ${provider}`} title={label}>
    <span className={`agent-orb ${provider}`}><ProviderIcon provider={provider} size={28} /></span>
    <svg className={`session-context-ring ${meter.tone}`} viewBox="0 0 65 65" aria-hidden="true">
      <circle className="session-context-track" cx="32.5" cy="32.5" r="31" />
      {meter.percent !== undefined && meter.arc > 0 && <circle className="session-context-fill" cx="32.5" cy="32.5" r="31" pathLength="100" strokeDasharray={`${meter.arc} 100`} />}
    </svg>
    <span id={descriptionId} className="sr-only">{label}</span>
  </span>;
}
