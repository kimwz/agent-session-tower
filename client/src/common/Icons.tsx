import type { Provider } from '../../../shared/types';

export function ProviderIcon({ provider, size = 18 }: { provider: Provider; size?: number }) {
  return provider === 'claude' ? <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2v6m0 8v6M2 12h6m8 0h6M4.93 4.93l4.24 4.24m5.66 5.66 4.24 4.24M4.93 19.07l4.24-4.24m5.66-5.66 4.24-4.24M8.17 2.76l2.3 5.55m3.06 7.38 2.3 5.55M2.76 15.83l5.55-2.3m7.38-3.06 5.55-2.3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
    : <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
export function BrandMark() {
  return <img src="/icon-192.png?v=rainbow-2" width={32} height={32} alt="" aria-hidden="true" />;
}
