/**
 * Waits for asynchronous state instead of sleeping a guessed duration: resolves with the first
 * value that is neither undefined nor false.
 */
export async function until<T>(read: () => T | undefined | false, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for: ${read}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
