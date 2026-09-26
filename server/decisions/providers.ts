import type { DecisionProviderId } from '../../shared/decisions.js';
import type { DecisionEngine } from './engine.js';
import { JevEngine } from './jev.js';

export interface DecisionProvider {
  label: string;
  create(apiKey: string, fetcher?: typeof fetch): DecisionEngine;
}

/** Every service that can answer decisions. Replacing Jev means adding an adapter here and choosing it in settings. */
export const DECISION_PROVIDERS: Record<DecisionProviderId, DecisionProvider> = {
  jev: { label: 'Jev', create: (apiKey, fetcher) => new JevEngine(apiKey, fetcher) },
};
