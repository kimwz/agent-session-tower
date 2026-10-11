import { useCallback, useEffect, useRef, useState } from 'react';

// Storage keys keep the project's first name so saved user state survives the rename (shared/app-identity.ts LEGACY_APP_NAME).
const SEEN_PROBLEMS = 'agent-monitor.seen-trigger-problems';

/** The trigger problems (trigger-helpers.ts triggerProblems) this browser has shown the owner. */
export function readSeenProblems(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; } // best-effort: an unreadable record counts as nothing seen, so the problems show again.
}

/**
 * What stays seen once the triggers show `current`: problems that went away are forgotten, so the same problem
 * coming back (an error with the same text) asks again. Returns `seen` itself when nothing went away.
 */
export function keepCurrent(seen: string[], current: readonly string[]): string[] {
  const kept = seen.filter(problem => current.includes(problem));
  return kept.length === seen.length ? seen : kept;
}

/**
 * The problems a page newly sees: those it never wrote before. A page whose overview is behind would otherwise write
 * back a problem another tab already saw go away, and the same problem coming back would not ask again.
 */
export function unwritten(problems: readonly string[], written: ReadonlySet<string>): string[] {
  return problems.filter(problem => !written.has(problem));
}

/** Seeing `problems` adds them to what this browser has seen, so another tab's own seen problems are kept. */
export function withSeen(seen: readonly string[], problems: readonly string[]): string[] {
  return [...new Set([...seen, ...problems])];
}

// best-effort: a browser that refuses storage shows the problems again on the next page.
const storedProblems = () => { try { return readSeenProblems(localStorage.getItem(SEEN_PROBLEMS)); } catch { return []; } };

/**
 * The trigger problems already seen in any tab of this browser. Seeing the triggers remembers the problems shown
 * now; `forgetGone` drops the ones this page's overview no longer has.
 */
export function useSeenTriggerProblems() {
  const [seen, setSeen] = useState(storedProblems);
  useEffect(() => {
    const follow = (event: StorageEvent) => { if (event.key === SEEN_PROBLEMS) setSeen(readSeenProblems(event.newValue)); };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);
  const store = useCallback((next: string[]) => {
    // best-effort: a browser that refuses storage keeps the problems seen only on this page.
    try { localStorage.setItem(SEEN_PROBLEMS, JSON.stringify(next)); } catch { /* Shown again next time. */ }
    setSeen(next);
  }, []);
  const written = useRef(new Set<string>());
  const acknowledge = useCallback((problems: string[]) => {
    const fresh = unwritten(problems, written.current);
    if (!fresh.length) return;
    for (const problem of fresh) written.current.add(problem);
    store(withSeen(storedProblems(), fresh));
  }, [store]);
  const forgetGone = useCallback((current: string[]) => {
    // Gone from this page's own overview, a problem can come back and be seen again here.
    written.current = new Set(keepCurrent([...written.current], current));
    const stored = storedProblems();
    const kept = keepCurrent(stored, current);
    if (kept !== stored) store(kept);
  }, [store]);
  return { seen, acknowledge, forgetGone };
}
