import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLanguage } from '../../../client/src/i18n/i18n.js';
import { entryMark, initialSection, noAttention, requestAllowed, sectionMark, settingsSections } from '../../../client/src/settings/settings-sections.js';
import { onOpenSettings, openSettings, type SettingsRequest } from '../../../client/src/settings/settings-open.js';
import { openSkills } from '../../../client/src/skills/skills-open.js';
import { openPermissions } from '../../../client/src/permissions/permissions-open.js';
import { SettingsFrameContext, SettingsPane } from '../../../client/src/settings/SettingsPane.js';

test('the settings list every section in one order, account management only where signing in is set up', () => {
  assert.deepEqual(settingsSections(true), ['general', 'models', 'triggers', 'skills', 'permissions', 'decisions', 'remote', 'notifications', 'backup', 'secrets', 'account']);
  assert.deepEqual(settingsSections(false), ['general', 'models', 'triggers', 'skills', 'permissions', 'decisions', 'remote', 'notifications', 'backup', 'secrets']);
});

test('the settings button shows a waiting permission request first, then proposals, then only a dot', () => {
  assert.equal(entryMark(noAttention), undefined);
  assert.deepEqual(entryMark({ ...noAttention, permissions: 2, skills: 5, triggers: true }), { count: 2, urgent: true });
  assert.deepEqual(entryMark({ ...noAttention, skills: 5, triggers: true }), { count: 5 });
  assert.deepEqual(entryMark({ ...noAttention, triggers: true }), { dot: true });
  assert.deepEqual(entryMark({ ...noAttention, remote: true }), { dot: true });
});

test('each section in the menu carries only its own mark', () => {
  const attention = { permissions: 3, skills: 1, triggers: true, remote: false };
  assert.deepEqual(sectionMark('permissions', attention), { count: 3, urgent: true });
  assert.deepEqual(sectionMark('skills', attention), { count: 1 });
  assert.deepEqual(sectionMark('triggers', attention), { dot: true });
  assert.equal(sectionMark('remote', attention), undefined);
  assert.equal(sectionMark('general', attention), undefined);
});

test('the settings open where asked, else on a waiting permission request, else where the owner last was', () => {
  const sections = settingsSections(false);
  assert.equal(initialSection('remote', { ...noAttention, permissions: 1 }, 'skills', sections), 'remote');
  assert.equal(initialSection(undefined, { ...noAttention, permissions: 1 }, 'skills', sections), 'permissions');
  assert.equal(initialSection(undefined, noAttention, 'skills', sections), 'skills');
  assert.equal(initialSection(undefined, noAttention, undefined, sections), 'general');
  assert.equal(initialSection('account', noAttention, undefined, sections), 'general', 'a section this page lacks is not opened');
});

test('a request the page cannot show is refused: no token yet, a missing section, or account management away from this computer', () => {
  const page = { token: 't', sections: settingsSections(true), local: true };
  assert.equal(requestAllowed(page, 'triggers'), true);
  assert.equal(requestAllowed(page, undefined), true);
  assert.equal(requestAllowed({ ...page, token: '' }, 'triggers'), false);
  assert.equal(requestAllowed({ ...page, local: false }, 'account'), false);
  assert.equal(requestAllowed({ ...page, sections: settingsSections(false) }, 'account'), false);
});

test('a folder menu opens skills and permissions in the settings, narrowed to that folder', t => {
  const asked: SettingsRequest[] = [];
  t.after(onOpenSettings(request => { asked.push(request); return true; }));
  assert.equal(openSkills('/work/app'), true);
  assert.equal(openPermissions('/work/app'), true);
  assert.equal(openSettings(), true);
  assert.deepEqual(asked, [{ section: 'skills', cwd: '/work/app' }, { section: 'permissions', cwd: '/work/app' }, {}]);
});

test('nothing reports as opened when no settings button is on the page', () => {
  assert.equal(openSettings({ section: 'triggers' }), false);
});

test('every section shares one frame: title, one line, tabs with their marks, a close and on a phone a way back', () => {
  setLanguage('en');
  const tabs = [{ id: 'requests', label: 'Requests', count: 12, urgent: true }, { id: 'rules', label: 'Rules 4' }] as const;
  const pane = (back?: () => void) => renderToStaticMarkup(createElement(SettingsFrameContext.Provider, { value: { active: true, close() {}, guard() {}, ...(back ? { back } : {}) } },
    createElement(SettingsPane<'requests' | 'rules'>, { title: 'Permissions', description: 'What agents may do', tabs, tab: 'requests', onTab() {}, children: 'body' })));
  const markup = pane();
  assert.match(markup, /<h2 id="[^"]+">Permissions<\/h2><p>What agents may do<\/p>/);
  assert.match(markup, /role="tab" aria-selected="true" tabindex="0" class="active">Requests<span class="settings-mark urgent">9\+<\/span>/);
  assert.match(markup, /role="tab" aria-selected="false" tabindex="-1" class="">Rules 4<\/button>/);
  assert.match(markup, /role="tabpanel"[^>]*>body<\/div>/);
  assert.match(markup, /aria-label="Close"/);
  assert.doesNotMatch(markup, /settings-back/);
  assert.match(pane(() => {}), /class="settings-back"[^>]*>.*Settings<\/button>/);
});

test('the settings menu keeps row styles off its close button and never shrinks a group into the scrolling list', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../../client/src/styles/settings.css', import.meta.url), 'utf8');
  // A row style on every nav button stretched the phone's close button across the head, squeezing the title to one letter per line.
  assert.doesNotMatch(css, /\.settings-nav button/);
  // The nav scrolls; a group that shrank instead was cut off by its rounded clip on a phone.
  for (const selector of ['.settings-nav-head', '.settings-nav-group']) {
    const rule = css.match(new RegExp(`^${selector.replace(/[.-]/g, '\\$&')} \\{([^}]*)\\}`, 'm'));
    assert.ok(rule, selector);
    assert.match(rule[1], /flex:none/, selector);
  }
});
