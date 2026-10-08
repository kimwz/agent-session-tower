import type { Provider, SessionContextUsage } from '../../../shared/types';
import { ProviderIcon } from '../common/Icons';
import { useI18n } from '../i18n/i18n';
import { contextUsageLabel, contextUsageMeter } from './session-context-usage';

/**
 * The provider's orb with the conversation's context usage as a ring around it, on the canvas and (`compact`) in the
 * chat header. `label` names it for assistive technology where nothing else does; the usage is its description.
 */
export function SessionContextIcon({ provider, usage, descriptionId, compact = false, label }: { provider: Provider; usage?: SessionContextUsage; descriptionId: string; compact?: boolean; label?: string }) {
  useI18n();
  const meter = contextUsageMeter(usage);
  const usageLabel = contextUsageLabel(usage);
  return <span className={`agent-orb-wrap ${provider}${compact ? ' compact' : ''}`} title={label ? `${label} · ${usageLabel}` : usageLabel}
    {...(label ? { role: 'img', 'aria-label': label, 'aria-describedby': descriptionId } : {})}>
    <span className={`agent-orb ${provider}`}><ProviderIcon provider={provider} size={compact ? 13 : 28} /></span>
    <svg className={`session-context-ring ${meter.tone}`} viewBox="0 0 65 65" aria-hidden="true">
      <circle className="session-context-track" cx="32.5" cy="32.5" r="31" />
      {meter.percent !== undefined && meter.arc > 0 && <circle className="session-context-fill" cx="32.5" cy="32.5" r="31" pathLength="100" strokeDasharray={`${meter.arc} 100`} />}
    </svg>
    <span id={descriptionId} className="sr-only">{usageLabel}</span>
  </span>;
}
