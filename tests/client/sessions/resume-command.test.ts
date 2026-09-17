import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resumeCommand } from '../../../client/src/sessions/resume-command.ts';
import { ResumeCommandButton } from '../../../client/src/sessions/ResumeCommandButton.tsx';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.ts';
import type { Session } from '../../../shared/types.ts';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'claude:289c8292-7340-4061-9fad-675fc9377547', nativeId: '289c8292-7340-4061-9fad-675fc9377547', provider: 'claude', title: 'Fixture',
  cwd: '/Users/me/ideation', project: 'ideation', status: 'idle', statusReason: '', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
  lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...overrides,
});

test('a web-created Claude session continues in a terminal by ID, inside its project folder', () => {
  assert.equal(resumeCommand(session()), "cd '/Users/me/ideation' && claude --resume 289c8292-7340-4061-9fad-675fc9377547");
});

test('a Codex session uses the native resume subcommand with its thread ID, not the Tower ID', () => {
  const codex = session({ id: 'codex:monitor-6232e0f7', nativeId: '01a0afaa-8f46-7980-a1bd-5231d3653100', provider: 'codex' });
  assert.equal(resumeCommand(codex), "cd '/Users/me/ideation' && codex resume 01a0afaa-8f46-7980-a1bd-5231d3653100");
});

test('folder names with spaces or quotes stay one shell argument', () => {
  assert.equal(resumeCommand(session({ cwd: "/Users/me/it's a project" })), "cd '/Users/me/it'\\''s a project' && claude --resume 289c8292-7340-4061-9fad-675fc9377547");
});

test('a session without a known absolute folder still gets the resume command', () => {
  assert.equal(resumeCommand(session({ cwd: '' })), 'claude --resume 289c8292-7340-4061-9fad-675fc9377547');
  assert.equal(resumeCommand(session({ cwd: 'relative/folder' })), 'claude --resume 289c8292-7340-4061-9fad-675fc9377547');
});

test('sessions that cannot be resumed, or whose ID is not a plain token, offer no command', () => {
  assert.equal(resumeCommand(session({ resumable: false, isSubagent: true })), undefined);
  assert.equal(resumeCommand(session({ nativeId: 'abc; rm -rf ~' })), undefined);
  assert.equal(resumeCommand(session({ nativeId: '--dangerously-skip-permissions' })), undefined);
});

test('the copy button names its action and previews the command; subagent sessions render nothing', t => {
  const original = getLanguage();
  setLanguage('en');
  t.after(() => setLanguage(original));
  const html = renderToStaticMarkup(createElement(ResumeCommandButton, { session: session() }));
  assert.match(html, /aria-label="Copy the command to continue in your terminal"/);
  assert.match(html, /claude --resume 289c8292-7340-4061-9fad-675fc9377547/);
  assert.equal(renderToStaticMarkup(createElement(ResumeCommandButton, { session: session({ resumable: false }) })), '');
});
