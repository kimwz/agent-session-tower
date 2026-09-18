import test from 'node:test';
import assert from 'node:assert/strict';
import { codexApprovalsKey, codexApprovalsRequest, parseCodexApprovalsChoice } from '../../../client/src/sessions/codex-approvals-preference.js';

test('a new session sends no approval reviewer until one is chosen', () => {
  assert.equal(parseCodexApprovalsChoice(null), 'default');
  assert.deepEqual(codexApprovalsRequest('codex', 'default'), {});
  assert.deepEqual(codexApprovalsRequest('codex', 'auto_review'), { codexApprovalsReviewer: 'auto_review' });
  assert.deepEqual(codexApprovalsRequest('codex', 'user'), { codexApprovalsReviewer: 'user' });
  assert.deepEqual(codexApprovalsRequest('claude', 'auto_review'), {});
});

test('an unreadable saved approval review choice falls back to the Codex default', () => {
  for (const saved of ['', 'auto', 'AUTO_REVIEW', '{"codexApprovalsReviewer":"auto_review"}', 'null']) {
    assert.equal(parseCodexApprovalsChoice(saved), 'default');
    assert.deepEqual(codexApprovalsRequest('codex', parseCodexApprovalsChoice(saved)), {});
  }
});

test('the remembered approval review choice round trips through browser storage', () => {
  const storage = new Map<string, string>();
  for (const choice of ['auto_review', 'user', 'default'] as const) {
    storage.set(codexApprovalsKey, choice);
    assert.equal(parseCodexApprovalsChoice(storage.get(codexApprovalsKey) ?? null), choice === 'default' ? 'default' : choice);
  }
  assert.equal(codexApprovalsKey.startsWith('agent-monitor.'), true, 'saved user state survives the project rename');
});

test('the approval review control offers the three choices, marks the current one, and explains what auto review changes', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CodexApprovalsSelect } = await import('../../../client/src/sessions/CodexApprovalsSelect.tsx');
  const { getLanguage, setLanguage } = await import('../../../client/src/i18n/i18n.ts');
  const original = getLanguage();
  setLanguage('en');
  try {
    const html = renderToStaticMarkup(createElement(CodexApprovalsSelect, { value: 'auto_review', onChange: () => {} }));
    assert.match(html, /aria-label="Approval review"/);
    assert.match(html, /<option value="default">Codex default<\/option>/);
    assert.match(html, /<option value="auto_review" selected="">Auto review \(Approve for me\)<\/option>/);
    assert.match(html, /<option value="user">Ask me \(Ask\)<\/option>/);
    assert.match(html, /title="[^"]*sandbox itself is unchanged/i);
  } finally { setLanguage(original); }
});
