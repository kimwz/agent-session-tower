import { terminalInputChunks } from './terminal-input';

/** What a terminal tab hears from its connection. */
export interface TerminalConnectionHandlers {
  /** Listening: output from here on is the shell's current output, and keys can be sent. */
  ready(): void;
  /** `id` is the output's place in the shell's history, to continue from after a reconnect. */
  output(data: string, id?: string): void;
  exit(exitCode: number): void;
  /** The shell is not there any more (closed, or never known to this computer). */
  gone(): void;
  /** The connection dropped; `opened` says whether it ever reached the server. The tab decides when to try again. */
  lost(opened: boolean): void;
  /** The connection is being re-established by the browser on its own; the tab may say so. */
  interrupted?(): void;
  /** A key or size it sent was refused; the shell may still be there. */
  refused(status: number, message: string): void;
}

export interface TerminalConnection {
  /** Whether a reconnect continues after the last output id it saw, instead of replaying the shell's history. */
  readonly resumes: boolean;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Close codes the server uses (server/http/terminal-socket.ts). */
export const SOCKET_GONE = 4404;
export const SOCKET_REFUSED = 4403;

type ServerMessage = { type: 'ready' } | { type: 'output'; data: string; id?: string } | { type: 'exit'; exitCode: number } | { type: 'error'; status: number; message: string };

/** The page's address for a WebSocket path on this Tower. */
export function socketUrl(path: string, location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

/**
 * One WebSocket for a terminal tab: output, keys and sizes. Unlike an event stream it does not take one of the six
 * connections a browser allows one address, which every Tower page there shares.
 * `refusedHello` is told when the server refused the page's token, so the tab can fetch a fresh one.
 */
export function openTerminalSocket(url: string, token: string, cursor: string | undefined, handlers: TerminalConnectionHandlers,
  options: { refusedHello?: () => void; create?: (url: string) => WebSocket } = {}): TerminalConnection {
  const socket = (options.create ?? (value => new WebSocket(value)))(url);
  let opened = false;
  let ended = false;
  const send = (message: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  socket.addEventListener('open', () => { opened = true; send({ type: 'hello', token, ...(cursor ? { cursor } : {}) }); });
  socket.addEventListener('message', event => {
    let message: ServerMessage;
    try { message = JSON.parse(String(event.data)) as ServerMessage; } catch { return; }
    if (ended) return;
    if (message.type === 'ready') handlers.ready();
    else if (message.type === 'output' && typeof message.data === 'string') handlers.output(message.data, typeof message.id === 'string' ? message.id : undefined);
    else if (message.type === 'exit') { ended = true; handlers.exit(Number(message.exitCode) || 0); }
    else if (message.type === 'error') {
      if ([404, 409, 410].includes(message.status)) { ended = true; handlers.gone(); }
      else handlers.refused(message.status, message.message);
    }
  });
  socket.addEventListener('close', event => {
    if (ended) return;
    ended = true;
    if (event.code === SOCKET_GONE) handlers.gone();
    else { if (event.code === SOCKET_REFUSED) options.refusedHello?.(); handlers.lost(opened); }
  });
  return {
    resumes: true,
    input: data => { for (const chunk of terminalInputChunks(data)) send({ type: 'input', data: chunk }); },
    resize: (cols, rows) => send({ type: 'resize', cols, rows }),
    close: () => { ended = true; socket.close(1000); },
  };
}

/**
 * The connection before WebSockets: an event stream for output and a request for each key and size. Used only where a
 * WebSocket cannot be opened (a proxy in front of Tower that refuses them). Each reconnect replays the shell's output.
 */
export function openTerminalStream(url: string, post: (action: 'input' | 'resize', body: object) => Promise<unknown>, handlers: TerminalConnectionHandlers,
  create: (url: string) => EventSource = value => new EventSource(value)): TerminalConnection {
  const source = create(url);
  let opened = false;
  let ended = false;
  let queue = Promise.resolve();
  const refused = (error: unknown) => {
    if (ended) return;
    const status = (error as { status?: number }).status ?? 0;
    if ([404, 409].includes(status)) { ended = true; source.close(); handlers.gone(); return; }
    handlers.refused(status, error instanceof Error ? error.message : String(error));
  };
  const later = (action: 'input' | 'resize', body: object) => { queue = queue.then(async () => { if (!ended) await post(action, body); }).catch(refused); };
  source.addEventListener('output', event => { if (!ended) handlers.output(JSON.parse((event as MessageEvent).data).data, (event as MessageEvent).lastEventId || undefined); });
  source.addEventListener('exit', event => { if (ended) return; ended = true; source.close(); handlers.exit(Number(JSON.parse((event as MessageEvent).data).exitCode) || 0); });
  source.onopen = () => { if (ended) return; opened = true; handlers.ready(); };
  source.onerror = () => {
    if (ended) return;
    // The browser tries again by itself while the stream is only interrupted; it gives up on an answer that is not one.
    if (source.readyState !== EventSource.CLOSED) { handlers.interrupted?.(); return; }
    ended = true;
    handlers.lost(opened);
  };
  return {
    resumes: false,
    input: data => { for (const chunk of terminalInputChunks(data)) later('input', { data: chunk }); },
    resize: (cols, rows) => later('resize', { cols, rows }),
    close: () => { ended = true; source.close(); },
  };
}
