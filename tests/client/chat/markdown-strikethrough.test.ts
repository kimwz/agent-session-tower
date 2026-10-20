import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../../../client/src/chat/Markdown.js';
import { TodoMarkdown } from '../../../client/src/todo/TodoMarkdown.js';

// Every Markdown in Tower: a chat message (with and without the master's line breaks), and a todo description or comment.
const renderers: [string, (text: string) => string][] = [
  ['chat', text => renderToStaticMarkup(createElement(Markdown, null, text))],
  ['chat with line breaks', text => renderToStaticMarkup(createElement(Markdown, { lineBreaks: true }, text))],
  ['todo', text => renderToStaticMarkup(createElement(TodoMarkdown, null, text))],
];

test('a single ~ is a character, as in Korean ranges, never a strikethrough', () => {
  const answer = '방문→가입 전환율은 18~20%, 가입→결제 전환율은 6~7% 정도입니다';
  for (const [name, render] of renderers) {
    const html = render(answer);
    assert.doesNotMatch(html, /<del>/, name);
    assert.match(html, /18~20%, 가입→결제 전환율은 6~7% 정도입니다/, `${name}: the text as written`);
  }
});

test('~~text~~ still strikes text through', () => {
  for (const [name, render] of renderers) {
    assert.match(render('이건 ~~취소~~ 되었습니다'), /이건 <del>취소<\/del> 되었습니다/, name);
    assert.match(render('1~3일, ~~취소~~, 5~6일'), /1~3일, <del>취소<\/del>, 5~6일/, `${name}: beside single ones`);
  }
});
