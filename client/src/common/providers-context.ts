import { createContext, useContext } from 'react';
import type { ProviderHealth } from '../../../shared/types';

/** This computer's providers as the page's snapshot reports them, for views far below the page that only need these. */
export const ProvidersContext = createContext<ProviderHealth[]>([]);

export function useProviders(): ProviderHealth[] { return useContext(ProvidersContext); }
