/**
 * The visitor page: one static HTML shell, script and stylesheet with no dependency on Tower's own web app, so nothing
 * of the owner's interface is ever served on the public port.
 */

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Agent</title>
<link rel="stylesheet" href="/_pa/app.css">
<script src="/_pa/app.js" defer></script>
</head>
<body>
<main id="app" aria-live="polite"><p class="pa-loading">…</p></main>
</body>
</html>
`;

export const PAGE_CSS = `
:root { color-scheme: light dark; --bg: #f7f7f8; --panel: #fff; --text: #1d1d1f; --muted: #6b6b73; --line: #e3e3e8; --accent: #5b4bdb; --visitor: #eceafd; --warn: #b3261e; --ok: #1f7a3f; }
@media (prefers-color-scheme: dark) { :root { --bg: #141416; --panel: #1d1d20; --text: #ececf0; --muted: #9a9aa3; --line: #2e2e33; --accent: #9d92ff; --visitor: #2a2745; --warn: #ff8a80; --ok: #7fd49a; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
#app { max-width: 820px; margin: 0 auto; min-height: 100%; display: flex; flex-direction: column; padding: 0 16px; }
header { padding: 22px 0 12px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: flex-start; }
header div { flex: 1; min-width: 0; }
h1 { font-size: 20px; margin: 0 0 4px; }
header p { margin: 0; color: var(--muted); white-space: pre-wrap; }
button { font: inherit; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 7px 14px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .55; cursor: default; }
.pa-log { flex: 1; padding: 16px 0; display: flex; flex-direction: column; gap: 12px; }
.pa-msg { max-width: 88%; padding: 10px 14px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
.pa-msg.visitor { align-self: flex-end; background: var(--visitor); border-color: transparent; }
.pa-msg small { display: block; color: var(--muted); font-size: 12px; margin-bottom: 2px; }
.pa-msg a, .pa-card a { color: var(--accent); }
.pa-card { border: 1px solid var(--line); border-left: 4px solid var(--accent); background: var(--panel); border-radius: 10px; padding: 10px 14px; }
.pa-card.rejected, .pa-card.failed { border-left-color: var(--warn); }
.pa-card.completed { border-left-color: var(--ok); }
.pa-card strong { font-size: 13px; }
.pa-card p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.pa-card .pa-request { color: var(--muted); font-size: 13px; max-height: 8em; overflow: auto; }
.pa-typing { color: var(--muted); font-size: 13px; }
.pa-error { color: var(--warn); font-size: 13px; margin: 6px 0; }
form.pa-compose { position: sticky; bottom: 0; background: var(--bg); padding: 10px 0 18px; display: flex; gap: 8px; align-items: flex-end; border-top: 1px solid var(--line); }
textarea { flex: 1; font: inherit; resize: none; min-height: 46px; max-height: 40vh; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 11px 12px; }
form.pa-login { margin: 48px auto; max-width: 340px; display: flex; flex-direction: column; gap: 10px; }
input { font: inherit; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 9px 12px; }
.pa-meter { font-size: 12px; color: var(--muted); }
.pa-empty { color: var(--muted); text-align: center; margin-top: 40px; }
`;

export const PAGE_JS = `(() => {
  'use strict';
  const ko = /^ko\\b/i.test(navigator.language || '');
  const T = ko ? {
    send: '보내기', placeholder: '메시지를 입력하세요', password: '비밀번호', enter: '입장', typing: '답변을 작성하고 있습니다…', reset: '새 대화', resetConfirm: '이 대화를 지우고 새로 시작할까요?',
    empty: '무엇을 도와드릴까요?', request: '요청', you: '나', agent: '에이전트',
    status: { reviewing: '검토 중', rejected: '접수되지 않음', queued: '대기 중', dispatching: '시작하는 중', running: '진행 중', summarizing: '결과 정리 중', completed: '완료', failed: '실패' },
    errors: { not_found: '이 페이지를 찾을 수 없습니다.', wrong_password: '비밀번호가 올바르지 않습니다.', login_blocked: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.', rate_limited: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', password_required: '비밀번호를 입력하세요.', invalid_message: '메시지는 1자 이상 4000자 이하로 입력하세요.', unavailable: '지금은 사용할 수 없습니다. 잠시 후 다시 시도하세요.' },
    context: '대화 기억 사용량',
  } : {
    send: 'Send', placeholder: 'Type a message', password: 'Password', enter: 'Enter', typing: 'Writing a reply…', reset: 'New conversation', resetConfirm: 'Clear this conversation and start over?',
    empty: 'How can I help?', request: 'Request', you: 'You', agent: 'Agent',
    status: { reviewing: 'Under review', rejected: 'Not accepted', queued: 'Waiting', dispatching: 'Starting', running: 'In progress', summarizing: 'Preparing result', completed: 'Done', failed: 'Failed' },
    errors: { not_found: 'This page was not found.', wrong_password: 'The password is not correct.', login_blocked: 'Too many sign-in attempts. Try again later.', rate_limited: 'Too many requests. Try again in a moment.', password_required: 'Enter the password.', invalid_message: 'Messages must be 1 to 4000 characters.', unavailable: 'Not available right now. Try again in a moment.' },
    context: 'Conversation memory',
  };
  const base = location.pathname.replace(/\\/+$/, '');
  const app = document.getElementById('app');
  let state; let error = ''; let sending = false; let timer; let draft = ''; let lastKey = '';
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') node.className = value; else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  };
  // Links become anchors; everything else stays text, never HTML.
  const rich = text => {
    const parts = [];
    const pattern = /https?:\\/\\/[^\\s<>"')\\]]+/g;
    let at = 0; let match;
    while ((match = pattern.exec(text))) {
      if (match.index > at) parts.push(text.slice(at, match.index));
      parts.push(el('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer nofollow' }, match[0]));
      at = match.index + match[0].length;
    }
    if (at < text.length) parts.push(text.slice(at));
    return parts;
  };
  const message = code => T.errors[code] || T.errors.unavailable;
  async function call(path, body) {
    const response = await fetch(base + '/api/' + path, body === undefined ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-public-agent': '1' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'unavailable');
    return data;
  }
  async function refresh() {
    clearTimeout(timer);
    try { state = await call('state'); if (error === 'unavailable' || error === 'rate_limited') error = ''; }
    catch (cause) { error = cause.message; if (error === 'not_found') { state = undefined; render(); return; } }
    render();
    timer = setTimeout(refresh, state && state.conversation && (state.conversation.busy || state.conversation.requests.some(item => !['completed', 'failed', 'rejected'].includes(item.status))) ? 1500 : 4000);
  }
  async function act(path, body) {
    sending = true; error = ''; render();
    try { state = await call(path, body); return true; }
    catch (cause) { error = cause.message; return false; }
    finally { sending = false; render(); clearTimeout(timer); timer = setTimeout(refresh, 1200); }
  }
  function render() {
    if (!state) {
      app.replaceChildren(error ? el('p', { class: 'pa-empty' }, message(error)) : el('p', { class: 'pa-empty' }, '…'));
      return;
    }
    document.title = state.agent.name;
    const head = el('header', {}, el('div', {}, el('h1', {}, state.agent.name), state.agent.description ? el('p', {}, state.agent.description) : null),
      state.canReset && state.conversation && state.conversation.messages.length ? el('button', { type: 'button', disabled: sending, onclick: async () => { if (confirm(T.resetConfirm)) await act('reset', {}); } }, T.reset) : null);
    if (state.access === 'password') {
      const input = el('input', { type: 'password', autocomplete: 'current-password', placeholder: T.password, required: true, maxlength: '256' });
      const form = el('form', { class: 'pa-login', onsubmit: async event => { event.preventDefault(); await act('login', { password: input.value }); } },
        input, error ? el('p', { class: 'pa-error' }, message(error)) : null, el('button', { class: 'primary', type: 'submit', disabled: sending }, T.enter));
      app.replaceChildren(head, form);
      input.focus();
      return;
    }
    const conversation = state.conversation;
    // Messages and request cards are shown in the order they happened.
    const items = [
      ...conversation.messages.map(item => ({ at: item.at, node: el('div', { class: 'pa-msg ' + item.role }, item.role === 'visitor' && item.visitor ? el('small', {}, '#' + item.visitor) : null, rich(item.text)) })),
      ...conversation.requests.map(item => ({ at: item.createdAt, node: el('div', { class: 'pa-card ' + item.status }, el('strong', {}, T.request + ' · ' + (T.status[item.status] || item.status)),
        el('p', { class: 'pa-request' }, item.request), item.reason ? el('p', {}, rich(item.reason)) : null, item.result ? el('p', {}, rich(item.result)) : null) })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const log = el('section', { class: 'pa-log' }, items.length ? items.map(item => item.node) : el('p', { class: 'pa-empty' }, T.empty),
      conversation.busy ? el('p', { class: 'pa-typing' }, T.typing) : null);
    const box = el('textarea', { rows: '2', maxlength: '4000', placeholder: T.placeholder, 'aria-label': T.placeholder });
    box.value = draft;
    box.addEventListener('input', () => { draft = box.value; });
    const submit = async event => {
      event.preventDefault();
      const text = box.value.trim();
      if (!text || sending) return;
      if (await act('message', { text })) draft = '';
    };
    box.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) submit(event); });
    const compose = el('form', { class: 'pa-compose', onsubmit: submit }, box, el('button', { class: 'primary', type: 'submit', disabled: sending }, T.send));
    const footer = el('div', {}, error ? el('p', { class: 'pa-error' }, message(error)) : null,
      conversation.contextPercent ? el('p', { class: 'pa-meter' }, T.context + ' ' + conversation.contextPercent + '%') : null);
    const key = conversation.messages.length + ':' + conversation.requests.map(item => item.status).join(',') + ':' + conversation.busy;
    const focused = document.activeElement && document.activeElement.tagName === 'TEXTAREA';
    app.replaceChildren(head, log, footer, compose);
    if (focused) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    if (key !== lastKey) { lastKey = key; window.scrollTo(0, document.body.scrollHeight); }
  }
  refresh();
})();
`;
