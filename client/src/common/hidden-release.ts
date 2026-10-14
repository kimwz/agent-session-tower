/**
 * How long a page stays hidden before it lets go of its live streams. A browser opens at most six HTTP/1.1
 * connections to one address and shares them between every page there; each Tower page holds two streams, so a few
 * Tower tabs in the background would leave none for the page in use, and its requests would wait without end.
 */
export const HIDDEN_RELEASE_MS = 15_000;

/**
 * Calls `sleep` once the page has been hidden for `delayMs`, and `wake` as soon as it is shown again (only after a
 * sleep). Returns what stops watching.
 */
export function releaseWhileHidden(sleep: () => void, wake: () => void, delayMs = HIDDEN_RELEASE_MS, doc: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asleep = false;
  const changed = () => {
    clearTimeout(timer); timer = undefined;
    if (doc.hidden) timer = setTimeout(() => { timer = undefined; if (doc.hidden && !asleep) { asleep = true; sleep(); } }, delayMs);
    else if (asleep) { asleep = false; wake(); }
  };
  doc.addEventListener('visibilitychange', changed);
  if (doc.hidden) changed();
  return () => { clearTimeout(timer); doc.removeEventListener('visibilitychange', changed); };
}
