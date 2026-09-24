import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { afterUpdating } from '../updates/tools.js';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Provider } from '../../shared/types.js';
import { MAX_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from '../../shared/attachments.js';
import { rasterMime } from '../stores/attachments.js';
import { findExecutable, providerDirectories } from '../providers/discovery.js';
import { defaultStateDir } from '../state-dir.js';

export interface AutoPromptModelRequest {
  provider: Provider;
  model: string;
  systemPrompt: string;
  prompt: string;
  schema: Record<string, unknown>;
  imagePaths?: readonly string[];
  signal: AbortSignal;
}

export interface AutoPromptNativeDependencies {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  findExecutable?: typeof findExecutable;
  spawnProcess?: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  killGraceMs?: number;
}

const MAX_OUTPUT = 1_000_000;
const MAX_ERROR_OUTPUT = 64_000;
const MAX_PROMPT = 512_000;
const CODE_MODE_DISABLED_WARNING = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const failure = (message: string) => new Error(`Auto Prompt: ${message}`);
const cancelled = () => Object.assign(failure('routing was cancelled.'), { name: 'AbortError' });
const eventName = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : 'unknown';
const CLAUDE_RETRY_ERRORS = new Set([
  'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
  'rate_limit', 'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'unknown', 'max_output_tokens',
]);

// Progress and status lines Claude Code's SDK schema (2.1.263 to 2.1.281) documents for any turn. They neither run
// tools nor complete a decision; the final result is still required.
function isClaudeRoutingProgress(frame: Record<string, any>): boolean {
  // A liveness heartbeat with no payload, which receivers must ignore.
  if (frame.type === 'keep_alive') return true;
  if (frame.type !== 'system' || typeof frame.uuid !== 'string' || typeof frame.session_id !== 'string') return false;
  if (frame.subtype === 'thinking') return typeof frame.content === 'string';
  if (frame.subtype === 'thinking_tokens') return Number.isSafeInteger(frame.estimated_tokens)
    && Number.isSafeInteger(frame.estimated_tokens_delta)
    && (frame.user_message_uuid === undefined || typeof frame.user_message_uuid === 'string');
  // Status lines newer Claude Code sends around any turn. None runs anything or adds to what the model reads: the
  // current slash commands (commands_changed, from 2.1.281), whether it is requesting, whether the turn is idle or
  // running (not waiting for an answer), and a short notice. Compacting would replace the routing prompt with a
  // summary, so it stops routing like the compact_boundary that follows it.
  if (frame.subtype === 'commands_changed') return Array.isArray(frame.commands)
    && frame.commands.every((command: unknown) => record(command) && typeof command.name === 'string');
  if (frame.subtype === 'status') return (frame.status === 'requesting' || frame.status === null)
    && frame.compact_result === undefined && frame.compact_error === undefined;
  if (frame.subtype === 'session_state_changed') return frame.state === 'idle' || frame.state === 'running';
  if (frame.subtype === 'notification') return typeof frame.key === 'string' && typeof frame.text === 'string';
  if (frame.subtype === 'api_retry') return Number.isSafeInteger(frame.attempt)
    && Number.isSafeInteger(frame.max_retries) && Number.isSafeInteger(frame.retry_delay_ms)
    && (frame.error_status === null || Number.isSafeInteger(frame.error_status))
    && CLAUDE_RETRY_ERRORS.has(frame.error)
    && (frame.no_response === undefined || record(frame.no_response)
      && Number.isSafeInteger(frame.no_response.waited_ms) && Number.isSafeInteger(frame.no_response.retry_wait_ms));
  return false;
}

// Installed Codex 0.153.4 exposes these config controls. Its own temporary
// structured-thread path disables the same execution and utility features.
// Unknown/unsupported settings must fail; never retry with weaker isolation.
const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'hooks', 'plugins', 'apps',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'in_app_browser', 'image_generation', 'view_image', 'sleep_tool', 'multi_agent',
  'multi_agent_v2', 'memories', 'goals', 'code_mode', 'code_mode_host', 'code_mode_only',
  'context_management', 'current_time_reminder', 'deferred_executor',
  'request_permissions_tool', 'standalone_web_search', 'token_budget', 'tool_suggest',
  'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies', 'remote_plugin',
] as const;

function codexArgs(options: AutoPromptModelRequest, directory: string, images: string[]): string[] {
  const settings: Record<string, unknown> = {
    approval_policy: 'never', web_search: 'disabled', project_doc_max_bytes: 0,
    suppress_unstable_features_warning: true,
    model_instructions_file: join(directory, 'instructions.txt'),
    developer_instructions: '', notify: [], allow_login_shell: false,
    'shell_environment_policy.inherit': 'none',
    'orchestrator.mcp.enabled': false, 'orchestrator.skills.enabled': false,
    'skills.include_instructions': false,
    'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false,
    'include_environment_context': false, 'include_apps_instructions': false,
    'include_collaboration_mode_instructions': false,
    ...Object.fromEntries(CODEX_DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
    'features.skip_host_skill_discovery': true,
  };
  return ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
    '--skip-git-repo-check', '-C', directory, '--sandbox', 'read-only', '--model', options.model,
    '--output-schema', join(directory, 'schema.json'), '--json', '--color', 'never',
    ...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    ...images.flatMap(path => ['--image', path]), '-'];
}

async function imagesForRequest(paths: readonly string[], directory: string): Promise<{ paths: string[]; blocks: object[] }> {
  if (paths.length > MAX_ATTACHMENTS) throw failure('too many routing images.');
  const result: { paths: string[]; blocks: object[] } = { paths: [], blocks: [] };
  let total = 0;
  for (const path of paths) {
    if (!isAbsolute(path)) throw failure('routing image is invalid.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw failure('routing image could not be read.'); });
    let content: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_IMAGE_ATTACHMENT_BYTES) throw failure('routing image is invalid or too large.');
      content = await file.readFile();
      total += content.length;
      if (content.length > MAX_IMAGE_ATTACHMENT_BYTES || total > MAX_TOTAL_ATTACHMENT_BYTES) throw failure('routing images are too large.');
    } finally { await file.close(); }
    const mime = rasterMime(content);
    if (!mime) throw failure('routing image format is unsupported.');
    const copied = join(directory, `image-${result.paths.length}.${mime.split('/')[1]}`);
    await writeFile(copied, content, { mode: 0o600, flag: 'wx' });
    result.paths.push(copied);
    result.blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: content.toString('base64') } });
  }
  return result;
}

/** Reasoning only. The caller validates the returned decision before dispatch. */
export async function runAutoPromptModel(options: AutoPromptModelRequest, dependencies: AutoPromptNativeDependencies = {}): Promise<unknown> {
  if (options.signal.aborted) throw cancelled();
  if (!['claude', 'codex'].includes(options.provider) || options.model !== (options.provider === 'claude' ? 'opus' : 'gpt-5.6-sol')) throw failure('routing model is unsupported.');
  const schema = JSON.stringify(options.schema);
  if (!record(options.schema) || typeof options.prompt !== 'string' || typeof options.systemPrompt !== 'string'
    || Buffer.byteLength(options.prompt) > MAX_PROMPT || Buffer.byteLength(options.systemPrompt) > 64_000 || Buffer.byteLength(schema) > 64_000) throw failure('routing input is invalid or too large.');
  const env = { ...process.env, ...dependencies.env };
  env.PATH = providerDirectories(env).join(delimiter);
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  // Never while the CLI is being updated, its lookup included: a half-replaced install would fail the routing for no
  // reason of its own.
  return afterUpdating(dependencies.stateDir ?? defaultStateDir(), options.provider, options.signal, () => routeWith(options, dependencies, env, schema));
}

async function routeWith(options: AutoPromptModelRequest, dependencies: AutoPromptNativeDependencies, env: NodeJS.ProcessEnv, schema: string): Promise<unknown> {
  const executable = await (dependencies.findExecutable ?? findExecutable)(options.provider, env);
  if (!executable) throw failure(`${options.provider === 'claude' ? 'Claude Code' : 'Codex'} CLI was not found. Install and sign in to the native CLI first.`);
  const tempRoot = join(dependencies.stateDir ?? defaultStateDir(), 'tmp');
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const root = await lstat(tempRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw failure('private routing directory is invalid.');
  const directory = await mkdtemp(join(tempRoot, 'auto-prompt-'));
  try {
    await writeFile(join(directory, 'schema.json'), schema, { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'instructions.txt'), options.systemPrompt, { mode: 0o600, flag: 'wx' });
    const images = await imagesForRequest(options.imagePaths ?? [], directory);
    if (options.signal.aborted) throw cancelled();
    const args = options.provider === 'codex' ? codexArgs(options, directory, images.paths) : [
      '-p', '--safe-mode', '--tools', '', '--disable-slash-commands', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--no-chrome',
      '--permission-prompts', 'none', '--system-prompt', options.systemPrompt,
      '--model', options.model, '--json-schema', schema, '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    ];
    const stdin = options.provider === 'codex' ? options.prompt : JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: options.prompt }, ...images.blocks] },
    }) + '\n';
    return await collect(options, dependencies, executable, args, directory, env, stdin);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function collect(options: AutoPromptModelRequest, dependencies: AutoPromptNativeDependencies, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = (dependencies.spawnProcess ?? spawn)(executable, args, { cwd, env, shell: false, detached: true, stdio: 'pipe' }); }
    catch { reject(failure('native CLI could not be started.')); return; }
    let error: Error | undefined;
    let stdout = '';
    let bytes = 0;
    let stderrBytes = 0;
    let finalText: string | undefined;
    let structuredOutput: Record<string, unknown> | undefined;
    let completed = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const stop = (reason: Error) => {
      if (error) return;
      error = reason;
      if (closed) return;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), dependencies.killGraceMs ?? 500);
    };
    const abort = () => stop(cancelled());
    const timeout = setTimeout(() => stop(failure('native routing timed out. No task was dispatched.')), dependencies.timeoutMs ?? 180_000);
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_ERROR_OUTPUT) stop(failure('native CLI emitted excessive diagnostic output.'));
    });
    const readLine = (line: string) => {
      if (!line.trim() || error) return;
      let frame: any;
      try { frame = JSON.parse(line); } catch { stop(failure('native CLI returned malformed protocol output.')); return; }
      if (!record(frame) || typeof frame.type !== 'string') { stop(failure('native CLI returned an invalid protocol event.')); return; }
      if (options.provider === 'claude') {
        if (frame.type === 'result') {
          if (completed || frame.subtype !== 'success' || frame.is_error !== false
            || (Array.isArray(frame.permission_denials) && frame.permission_denials.length > 0) || !record(frame.structured_output)) {
            stop(failure('Claude Code did not return a successful structured decision. Check native sign-in and model access.')); return;
          }
          structuredOutput = frame.structured_output; completed = true;
        } else if (frame.type === 'system' && frame.subtype === 'init') {
          // StructuredOutput is the schema-response mechanism, not an execution tool.
          if (!Array.isArray(frame.tools) || frame.tools.some((tool: unknown) => tool !== 'StructuredOutput')
            || (Array.isArray(frame.mcp_servers) && frame.mcp_servers.length)) stop(failure('Claude Code exposed tools during routing.'));
        } else if (frame.type === 'assistant') {
          if (!record(frame.message) || !Array.isArray(frame.message.content)
            || frame.message.content.some((block: any) => !record(block) || !['text', 'thinking', 'redacted_thinking'].includes(block.type)
              && !(block.type === 'tool_use' && block.name === 'StructuredOutput'))) stop(failure('Claude Code attempted a tool operation during routing.'));
        } else if (!['user', 'rate_limit_event'].includes(frame.type) && !isClaudeRoutingProgress(frame)) {
          const name = eventName(frame.type) + (frame.subtype === undefined ? '' : `/${eventName(frame.subtype)}`);
          stop(failure(`Claude Code returned an unsupported routing event (${name}).`));
        }
        return;
      }
      if (['item.started', 'item.updated', 'item.completed'].includes(frame.type)) {
        // Codex 0.153.4 represents this expected fail-closed startup warning as
        // an error item. All other native errors still stop routing.
        if (frame.type === 'item.completed' && record(frame.item) && frame.item.type === 'error') {
          if (frame.item.message !== CODE_MODE_DISABLED_WARNING) stop(failure('Codex reported an unsupported routing configuration. Check CLI compatibility.'));
          return;
        }
        if (!record(frame.item) || !['reasoning', 'agent_message'].includes(frame.item.type)) { stop(failure('Codex attempted a tool operation during routing.')); return; }
        if (frame.type === 'item.completed' && frame.item.type === 'agent_message' && typeof frame.item.text === 'string') finalText = frame.item.text;
      } else if (frame.type === 'turn.completed') completed = true;
      else if (!['thread.started', 'turn.started'].includes(frame.type)) stop(failure('Codex routing failed or returned an unsupported event. Check native sign-in and CLI compatibility.'));
    };
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) { stop(failure('native routing output exceeded its limit.')); return; }
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) { readLine(stdout.slice(0, newline)); stdout = stdout.slice(newline + 1); }
    });
    child.stdin.on('error', () => stop(failure('native CLI stopped accepting routing input.')));
    child.on('error', () => stop(failure('native CLI could not be started.')));
    child.on('exit', () => {
      // A descendant retaining stdout must not keep the router or its temp files alive.
      exitTimer = setTimeout(() => stop(failure('native CLI left an unfinished routing process.')), 100);
    });
    child.on('close', code => {
      closed = true;
      clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(exitTimer);
      options.signal.removeEventListener('abort', abort);
      // Reap any surviving descendants of this dedicated process, even on success.
      signalGroup('SIGKILL');
      if (error) { reject(error); return; }
      if (code !== 0) { reject(failure(`native ${options.provider} routing exited unsuccessfully. Check native sign-in, model access, and CLI compatibility.`)); return; }
      readLine(stdout);
      if (error) { reject(error); return; }
      if (options.provider === 'claude') {
        if (!completed || !structuredOutput) reject(failure('Claude Code did not complete a structured decision.'));
        else resolve(structuredOutput);
        return;
      }
      if (!completed || !finalText) { reject(failure('Codex did not complete a structured decision.')); return; }
      try { const value: unknown = JSON.parse(finalText); if (!record(value)) throw new Error(); resolve(value); }
      catch { reject(failure('Codex returned malformed structured output.')); }
    });
    if (options.signal.aborted) abort();
    if (!error) child.stdin.end(stdin);
  });
}
