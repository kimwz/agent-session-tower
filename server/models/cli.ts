import { resolve } from 'node:path';
import { BUILTIN_ROLES, modelArgs, resolveRole } from '../../shared/models.js';
import { defaultStateDir } from '../state-dir.js';
import { readModelSettings } from './settings.js';

const USAGE = `Usage: agent-session-tower models <command> [--state-dir <path>]

  list                 Every role with its provider / model / reasoning effort
  get <role>           One role's provider, model and effort as JSON
  args <role>          Flags that select the role's model, for codex exec or claude -p
                       e.g. codex exec $(agent-session-tower models args review.codex) ...`;

/** `agent-session-tower models …`: the model settings as agents starting codex exec or claude -p read them. */
export async function runModelsCommand(args: string[], output: (line: string) => void = line => console.log(line)): Promise<void> {
  let stateDir = defaultStateDir();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir') { if (!args[i + 1]) throw new Error('--state-dir requires a path.'); stateDir = resolve(args[++i]); }
    else if (args[i] === '--help' || args[i] === '-h') { output(USAGE); return; }
    else positional.push(args[i]);
  }
  const [command, role, ...rest] = positional;
  if (rest.length) throw new Error(USAGE);
  const settings = await readModelSettings(stateDir);
  if (command === 'list' && !role) {
    for (const id of [...BUILTIN_ROLES.map(item => item.id), ...settings.custom.map(item => item.id)]) {
      const resolved = resolveRole(settings, id);
      const follows = BUILTIN_ROLES.find(item => item.id === id) && (settings.roles as Record<string, { provider: string }>)[id]?.provider === 'follow';
      output(`${id} = ${follows ? 'follow' : resolved.provider} / ${resolved.model ?? 'default'} / ${resolved.effort ?? 'default'}`);
    }
    return;
  }
  if ((command === 'get' || command === 'args') && role) {
    const resolved = resolveRole(settings, role);
    output(command === 'get' ? JSON.stringify({ role, ...resolved, args: modelArgs(resolved) }) : modelArgs(resolved).map(quote).join(' '));
    return;
  }
  throw new Error(USAGE);
}

/** Model ids and efforts are argv-safe already; anything else is quoted for the shell. */
const quote = (value: string) => /^[\w.:/=@\[\]-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
