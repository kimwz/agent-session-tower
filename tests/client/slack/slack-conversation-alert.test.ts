import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackConversationAlert } from '../../../client/src/slack/SlackConversationAlert.js';
import type { SlackWorkflow } from '../../../shared/slack.js';

test('conversation errors remain visible as escaped alerts in the native chat header', () => {
  const workflow = { mode: 'conversation', error: 'Slack notification failed <script>' } as SlackWorkflow;
  const markup = renderToStaticMarkup(createElement(SlackConversationAlert, { workflow }));
  assert.match(markup, /role="alert"/);
  assert.match(markup, /Slack notification failed &lt;script&gt;/);
  for (const value of [undefined, { ...workflow, error: undefined }, { ...workflow, mode: undefined }]) {
    assert.equal(renderToStaticMarkup(createElement(SlackConversationAlert, { workflow: value })), '');
  }
});
