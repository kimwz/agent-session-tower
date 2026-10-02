import { isAbsolute, resolve } from 'node:path';
import { callWorkerTools } from '../mcp/stdio.js';
import { validateSecretRunInput } from './broker.js';
import type { SecretRunInput } from '../../shared/secrets.js';

export type SecretCliRequest = { kind: 'list' } | { kind: 'run'; input: SecretRunInput } | { kind: 'compare'; left: string; right: string } | { kind: 'fingerprint'; reference: string; domain: string };
export const SECRET_CLI_HELP = `agent-session-tower secrets
  list [--json]
  run [--env NAME=REF] [--env-bundle REF] [--file NAME=REF] [--stdin REF] --operation-id ID -- PROGRAM [ARGS]
  pipe --secret REF --operation-id ID -- PROGRAM [ARGS]
  compare LEFT_REF RIGHT_REF
  fingerprint REF [--domain NAME]

Tower의 secrets_cli 도구에서 같은 인자로 사용할 수 있습니다.
직접 CLI 실행에는 Tower가 발급한 현재 실행의 secret capability가 필요합니다.
run/pipe의 --operation-id는 같은 작업의 재시도에서 그대로 사용하세요.
값을 출력하는 read/export 명령은 제공하지 않습니다.`;

/** Shared by the authenticated MCP frontend and the console CLI; arguments contain references only. */
export function parseSecretCli(argv: string[]): SecretCliRequest {
  if (!Array.isArray(argv) || argv.length > 300 || argv.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 32768 || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(argv)) > 1024 * 1024) throw new Error('시크릿 명령 인자가 올바르지 않습니다.');
  const [command, ...args] = argv;
  if (command === 'list' && args.every(arg => arg === '--json')) return { kind: 'list' };
  if (command === 'compare' && args.length === 2) return { kind: 'compare', left: args[0], right: args[1] };
  if (command === 'fingerprint' && (args.length === 1 || (args.length === 3 && args[1] === '--domain'))) return { kind: 'fingerprint', reference: args[0], domain: args[2] ?? 'object' };
  if (command !== 'run' && command !== 'pipe') throw new Error(SECRET_CLI_HELP);
  const separator = args.indexOf('--');
  if (separator < 0 || !args[separator + 1]) throw new Error('시크릿 명령 뒤에 -- PROGRAM [ARGS]가 필요합니다.');
  const input: SecretRunInput = { operationId: '', command: args[separator + 1], args: args.slice(separator + 2), env: Object.create(null), files: Object.create(null) };
  const seen = new Set<string>();
  for (let index = 0; index < separator; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (value === undefined || index + 1 >= separator) throw new Error('옵션 값이 필요합니다.');
    if (flag === '--env' || flag === '--file') {
      const equal = value.indexOf('=');
      if (equal < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, equal))) throw new Error('NAME=REF 형식이 필요합니다.');
      const binding = `${flag}:${value.slice(0, equal)}`; if (seen.has(binding)) throw new Error('같은 옵션을 반복할 수 없습니다.'); seen.add(binding);
      (flag === '--env' ? input.env! : input.files!)[value.slice(0, equal)] = value.slice(equal + 1);
    } else {
      const option = flag === '--secret' ? '--stdin' : flag; if (seen.has(option)) throw new Error('같은 옵션을 반복할 수 없습니다.'); seen.add(option);
      if (flag === '--env-bundle') input.envBundle = value;
      else if (flag === '--stdin' || (flag === '--secret' && command === 'pipe')) input.stdin = value;
      else if (flag === '--operation-id') input.operationId = value;
      else if (flag === '--cwd') input.cwd = value;
      else if (flag === '--timeout-ms') input.timeoutMs = Number(value);
      else throw new Error('지원하지 않는 시크릿 옵션입니다.');
    }
  }
  if (!input.operationId) throw new Error('run/pipe에는 재시도에도 유지할 --operation-id ID가 필요합니다.');
  if (command === 'pipe' && !input.stdin) throw new Error('pipe에는 --secret REF가 필요합니다.');
  return { kind: 'run', input: validateSecretRunInput(input) };
}

export async function runSecretsCommand(argv: string[]): Promise<void> {
  if (!argv.length || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) { console.log(SECRET_CLI_HELP); return; }
  const parsed = parseSecretCli(argv);
  // Read no runner master credential and never infer a subject from cwd or a native thread ID.
  const capability = process.env.TOWER_SECRET_CAPABILITY;
  if (!capability || !/^[a-f0-9]{64}$/.test(capability)) throw new Error('현재 실행의 시크릿 권한이 없습니다. 에이전트에서는 Tower의 secrets_cli 도구를 사용하세요.');
  const configured = process.env.TOWER_SECRET_STATE_DIR;
  if (!configured || !isAbsolute(configured) || configured.includes('\0') || Buffer.byteLength(configured) > 8192) throw new Error('현재 실행의 시크릿 transport 경로가 없습니다. Tower의 secrets_cli 도구를 사용하세요.');
  const directory = resolve(configured);
  const value = await callWorkerTools(directory, capability, { method: 'tools/call', name: 'secrets_cli', arguments: { argv, operationId: parsed.kind === 'run' ? parsed.input.operationId : undefined } });
  if (parsed.kind === 'run') {
    const result = value as { stdout?: string; stderr?: string; exitCode?: number | null };
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exitCode = result.exitCode ?? 1;
  } else console.log(JSON.stringify(value, null, 2));
}
