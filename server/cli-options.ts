import { resolve } from 'node:path';

export interface RunOptions { command: 'run' | 'doctor'; port: number; host: string; open: boolean; stateDir: string; publicUrls: string[] }

/**
 * The options of `agent-session-tower [run|doctor]`, after the subcommands and internal entry points are taken out.
 * Any other option is refused as `Unknown option: <option>`: an update helper from 1.125–1.137.x probes a target with
 * `--storage-contract` and goes on only when it exits at once with a numeric non-zero code, that text on stderr, and
 * `--version` answering the release's version. Keep that answer for options this build does not know.
 */
export function parseRunOptions(args: readonly string[], defaultStateDir: string): { kind: 'help' } | { kind: 'version' } | ({ kind: 'run' } & RunOptions) {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--version')) return { kind: 'version' };
  const options: RunOptions = { command: 'run', port: 8000, host: '127.0.0.1', open: true, stateDir: defaultStateDir, publicUrls: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'run' || arg === 'doctor') options.command = arg;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--port') { if (!args[i + 1]) throw new Error('--port requires a number.'); options.port = Number(args[++i]); }
    else if (arg === '--host') { if (!args[i + 1]) throw new Error('--host requires an IPv4 address.'); options.host = args[++i]; }
    else if (arg === '--public-url') { if (!args[i + 1]) throw new Error('--public-url requires a URL.'); options.publicUrls.push(args[++i]); }
    else if (arg === '--state-dir') { if (!args[i + 1]) throw new Error('--state-dir requires a path.'); options.stateDir = resolve(args[++i]); }
    else throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Port must be between 1 and 65535.');
  return { kind: 'run', ...options };
}
