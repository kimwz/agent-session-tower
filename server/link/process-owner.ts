/** Signal-zero presence only; callers own process identity and the policy for unknown observations. */
export type ProcessObservation =
  | { state: 'present'; code?: 'EPERM' }
  | { state: 'gone' }
  | { state: 'out-of-range' }
  | { state: 'unobserved'; error: unknown };

export function observeProcess(pid: number): ProcessObservation {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2 ** 31 - 1) return { state: 'out-of-range' };
  try { process.kill(pid, 0); return { state: 'present' }; } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EPERM') return { state: 'present', code };
    if (code === 'ESRCH') return { state: 'gone' };
    return { state: 'unobserved', error };
  }
}
