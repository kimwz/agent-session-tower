/**
 * The only code that knows the Anthropic Messages API. The master's turn is written in the OpenAI Responses shape
 * (`model-openai.ts`); this reads that shape into Claude messages and gives Claude's answer back in it, so the turn
 * runs the same with either. Claude's own answer (thinking included) is kept whole in the turn and sent back
 * unchanged on the next step, as the API requires.
 */

import Anthropic from '@anthropic-ai/sdk';
import { masterProvider } from '../../shared/master.js';
import { ModelError, type ModelCall, type ModelItem, type ModelRequest } from './model-openai.js';

/** Claude's answer in a turn: its content blocks as they came, sent back as they are. */
export const CLAUDE_ANSWER = 'claude_answer';
const MAX_TOKENS = 64_000;
/** The master's reasoning levels as Claude's effort; Claude always thinks as much as it needs, "none" is its least. */
const EFFORT: Record<string, 'low' | 'medium' | 'high'> = { none: 'low', low: 'low', medium: 'medium', high: 'high' };

/** Sends each request to the API its model belongs to. */
export function routedModel(openai: ModelCall, anthropic: ModelCall): ModelCall {
  return (request, onText, signal) => (masterProvider(request.model) === 'anthropic' ? anthropic : openai)(request, onText, signal);
}

export function anthropicMessages(apiKey: () => string | undefined, options: { fetch?: typeof fetch; baseURL?: string } = {}): ModelCall {
  let client: { key: string; api: Anthropic } | undefined;
  return async (request, onText, signal) => {
    const key = apiKey();
    if (!key) throw new ModelError('Anthropic API 키가 설정되지 않았습니다. 마스터 설정에서 넣어 주세요.');
    if (client?.key !== key) client = { key, api: new Anthropic({ apiKey: key, maxRetries: 1, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.baseURL ? { baseURL: options.baseURL } : {}) }) };
    const { system, messages } = claudeInput(request);
    let message: Anthropic.Message;
    try {
      const stream = client.api.messages.stream({
        model: request.model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Tool.InputSchema })),
        tool_choice: { type: 'auto' },
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT[request.effort] ?? 'low' },
      }, { signal });
      stream.on('text', delta => onText(delta));
      message = await stream.finalMessage();
    } catch (error) {
      if (signal.aborted) throw error;
      throw modelError(error);
    }
    if (message.stop_reason === 'refusal') throw new ModelError('Claude가 이 요청에 답하지 않았습니다. 다른 모델로 다시 보내 보세요.');
    // An answer cut off by its length ends here with what it wrote; a tool call it could not finish is not run.
    const content = message.stop_reason === 'max_tokens' ? message.content.filter(block => block.type !== 'tool_use') : message.content;
    const calls: ModelItem[] = content.filter(block => block.type === 'tool_use')
      .map(block => ({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}), claude: true }));
    const text = content.filter(block => block.type === 'text').map(block => block.text).join('');
    return { output: [{ type: CLAUDE_ANSWER, content }, ...calls], text };
  };
}

function modelError(error: unknown): ModelError {
  if (error instanceof Anthropic.AuthenticationError) return new ModelError('Anthropic이 API 키를 거부했습니다. 설정에서 키를 확인하세요.', 401);
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message ?? error.message;
    if (error.status === 429) return new ModelError(`Anthropic 요청 한도에 걸렸습니다. ${detail}`.trim(), 429);
    return new ModelError(`Anthropic 오류 (${error.status}): ${detail.slice(0, 500)}`, error.status);
  }
  return new ModelError(`Anthropic에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * The turn as Claude reads it. The standing instructions (the same every turn, so cached) and what Tower says for
 * this turn are the system prompt; the conversation keeps its roles; tool results go back in one message per step.
 */
export function claudeInput(request: ModelRequest): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: request.instructions, cache_control: { type: 'ephemeral' } }];
  const messages: Anthropic.MessageParam[] = [];
  const add = (role: 'user' | 'assistant', blocks: Anthropic.ContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    // Tool results must directly follow their calls, so a step's results share one message.
    if (last && last.role === role && role === 'user' && Array.isArray(last.content) && last.content.every(block => block.type === 'tool_result') && blocks.every(block => block.type === 'tool_result')) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const item of request.input) {
    if (item.type === 'message') {
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'developer' || item.role === 'system' ? 'system' : 'user';
      const blocks = contentBlocks(item.content);
      if (role === 'system') { for (const block of blocks) if (block.type === 'text') system.push({ type: 'text', text: block.text }); continue; }
      add(role, role === 'assistant' ? blocks.filter(block => block.type === 'text') : blocks);
    } else if (item.type === CLAUDE_ANSWER) messages.push({ role: 'assistant', content: item.content as Anthropic.ContentBlockParam[] });
    else if (item.type === 'function_call') {
      // A call Claude made is already in its answer; only one from elsewhere is written out.
      if (!item.claude) add('assistant', [{ type: 'tool_use', id: String(item.call_id), name: String(item.name), input: parseArguments(item.arguments) }]);
    } else if (item.type === 'function_call_output') add('user', [{ type: 'tool_result', tool_use_id: String(item.call_id), content: String(item.output ?? '') || '(empty)' }]);
    // Anything else (an OpenAI reasoning item) means nothing to Claude.
  }
  // Claude's conversation starts with the owner.
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: '(The conversation so far:)' });
  return { system, messages };
}

function parseArguments(value: unknown): Record<string, unknown> {
  try { const parsed = JSON.parse(String(value ?? '{}')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** A message's content (text, or OpenAI input parts) as Claude blocks; empty text is left out, as Claude refuses it. */
function contentBlocks(content: unknown): Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    const text = part.type === 'input_text' || part.type === 'output_text' || part.type === 'text' ? String(part.text ?? '') : undefined;
    if (text !== undefined) { if (text.trim()) blocks.push({ type: 'text', text }); continue; }
    const data = DATA_URL.exec(String(part.type === 'input_image' ? part.image_url : part.type === 'input_file' ? part.file_data : ''));
    if (!data) continue;
    if (part.type === 'input_image' && IMAGE_TYPES.has(data[1])) blocks.push({ type: 'image', source: { type: 'base64', media_type: data[1] as 'image/png', data: data[2] } });
    else if (part.type === 'input_file' && data[1] === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data[2] }, ...(typeof part.filename === 'string' ? { title: part.filename } : {}) });
  }
  return blocks;
}
