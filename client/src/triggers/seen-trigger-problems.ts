import { useCallback, useEffect, useState } from 'react';

// Storage keys keep the project's first name so saved user state survives the rename (shared/app-identity.ts LEGACY_APP_NAME).
const SEEN_PROBLEMS = 'agent-monitor.seen-trigger-problems';

/** The trigger problems (trigger-helpers.ts triggerProblems) this browser has shown the owner. */
export function readSeenProblems(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

const storedProblems = () => { try { return readSeenProblems(localStorage.getItem(SEEN_PROBLEMS)); } catch { return []; } };

/**
 * The trigger problems already seen in any tab of this browser. Seeing the triggers remembers the problems shown
 * now, which also forgets the ones that went away.
 */
export function useSeenTriggerProblems() {
  const [seen, setSeen] = useState(storedProblems);
  useEffect(() => {
    const follow = (event: StorageEvent) => { if (event.key === SEEN_PROBLEMS) setSeen(readSeenProblems(event.newValue)); };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);
  const acknowledge = useCallback((problems: string[]) => { try { localStorage.setItem(SEEN_PROBLEMS, JSON.stringify(problems)); } catch { /* Shown again next time. */ } setSeen(problems); }, []);
  return { seen, acknowledge };
}
