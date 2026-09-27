/**
 * The only code that knows the OpenAI Responses API. It streams one model response: text as it arrives, and the
 * complete output (messages, reasoning and function calls) when it ends. Conversations are not stored at OpenAI;
 * the master sends what the model needs every time.
 */

export interface ModelTool { type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }
export type ModelItem = Record<string, unknown> & { type: string };
export interface ModelRequest {
  model: string;
  effort: string;
  instructions: string;
  input: ModelItem[];
  tools: ModelTool[];
}
export interface ModelResult { output: ModelItem[]; text: string }
export type ModelCall = (request: ModelRequest, onText: (delta: string) => void, signal: AbortSignal) => Promise<ModelResult>;

export class ModelError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'ModelError'; }
}

const ENDPOINT = 'https://api.openai.com/v1/responses';

export function openAiResponses(apiKey: () => string | undefined, fetcher: typeof fetch = fetch, endpoint = ENDPOINT): ModelCall {
  return async (request, onText, signal) => {
    const key = apiKey();
    if (!key) throw new ModelError('OpenAI API 키가 설정되지 않았습니다.');
    const body = {
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      tools: request.tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
      stream: true,
      ...(request.effort === 'none' ? {} : { reasoning: { effort: request.effort }, include: ['reasoning.encrypted_content'] }),
    };
    let response: Response;
    try {
      response = await fetcher(endpoint, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ModelError(`OpenAI에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      let message = detail;
      try { message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* plain text */ }
      if (response.status === 401) throw new ModelError('OpenAI가 API 키를 거부했습니다. 설정에서 키를 확인하세요.', 401);
      if (response.status === 429) throw new ModelError(`OpenAI 요청 한도에 걸렸습니다. ${message}`.trim(), 429);
      throw new ModelError(`OpenAI 오류 (${response.status}): ${message.slice(0, 500)}`, response.status);
    }
    let text = '';
    let output: ModelItem[] | undefined;
    for await (const event of serverEvents(response.body)) {
      const type = event.type;
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') { text += event.delta; onText(event.delta); }
      else if (type === 'response.completed') output = ((event.response as { output?: ModelItem[] })?.output) ?? [];
      else if (type === 'response.incomplete') output = ((event.response as { output?: ModelItem[] })?.output) ?? [];
      else if (type === 'response.failed') throw new ModelError(`OpenAI 응답 실패: ${(event.response as { error?: { message?: string } })?.error?.message ?? '알 수 없음'}`);
      else if (type === 'error') throw new ModelError(`OpenAI 오류: ${(event as { message?: string }).message ?? (event as { error?: { message?: string } }).error?.message ?? '알 수 없음'}`);
    }
    if (!output) throw new ModelError('OpenAI 응답이 중간에 끊겼습니다.');
    const finalText = output.filter(item => item.type === 'message').flatMap(item => (item.content as Array<{ type: string; text?: string }> | undefined) ?? [])
      .filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
    return { output, text: finalText || text };
  };
}

/** Parses a server-sent event stream into its JSON payloads. */
export async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown> & { type?: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data) as Record<string, unknown>; } catch { /* ignore a malformed event */ }
      }
    }
  } finally { reader.releaseLock(); }
}
