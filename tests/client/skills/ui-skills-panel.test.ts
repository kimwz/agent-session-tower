import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Skill, SkillOverview, SkillTargets } from '../../../shared/skills.js';
import { getLanguage, setLanguage } from '../../../client/src/i18n/i18n.js';
import { ProjectPicker, toggleTargets, TowerSkills } from '../../../client/src/skills/SkillsPanel.js';

const original = getLanguage();
test.beforeEach(() => setLanguage('ko'));
test.afterEach(() => setLanguage(original));

const skill = (name: string, targets: SkillTargets, patch: Partial<Skill> = {}): Skill => ({ dir: `/state/skills/global/${name}`, name, description: `${name} 설명`, scope: 'global',
  providers: ['claude', 'codex'], pinned: true, external: false, managed: true, revision: 'r', targets, ...patch });
const overview = (stored: Skill[]): SkillOverview => ({ skills: [], stored, proposals: [], notes: [], settings: { enabled: true, provider: 'claude' }, advisor: { running: false } });
const noop = () => {};
const list = (stored: Skill[], extra: { cwd?: string; proposals?: number } = {}) => renderToStaticMarkup(createElement(TowerSkills, {
  overview: overview(stored), busy: false, proposals: 0, onNew: noop, onEdit: noop, onToggle: noop, onProposals: noop, onAll: noop, ...extra }));

test('my skills start empty, with a way to make one and a quiet way to the rest of the computer’s skills', () => {
  const markup = list([]);
  assert.match(markup, /타워에 등록한 스킬이 없습니다/);
  assert.match(markup, /새 스킬/);
  assert.match(markup, /이 컴퓨터의 다른 스킬 보기/);
  assert.doesNotMatch(markup, /tower-skill-open/);
});

test('each skill is one row saying where it applies; proposals wait behind one line', () => {
  const markup = list([
    skill('review', { all: true, projects: [] }),
    skill('deploy', { all: false, projects: ['/work/monitor', '/work/shop', '/work/blog'] }),
    skill('shop-only', { all: false, projects: ['/work/shop'] }, { pinned: false }),
    skill('parked', { all: false, projects: [] }),
  ], { proposals: 2 });
  assert.match(markup, /추천 스킬 2개가 기다리고 있습니다/);
  assert.match(markup, /deploy<\/strong>.*monitor 외 2/s);
  assert.match(markup, /review<\/strong>.*모든 프로젝트/s);
  assert.match(markup, /shop-only<\/strong><span class="skill-badge quiet"[^>]*>알림 끔<\/span>.*>shop</s);
  assert.match(markup, /parked<\/strong>.*적용 안 함/s);
  assert.doesNotMatch(markup, /role="switch"/, 'the project switch belongs to a project’s own view');
});

test('opened from a project, each row switches the skill on or off there; one for every project cannot be switched off here', () => {
  const markup = list([skill('review', { all: true, projects: [] }), skill('deploy', { all: false, projects: ['/work/monitor'] }), skill('shop-only', { all: false, projects: ['/work/shop'] })], { cwd: '/work/monitor' });
  const row = (name: string) => markup.split('<li').find(part => part.includes(`${name}</strong>`))!;
  const toggle = (name: string) => row(name).match(/<input[^>]*role="switch"[^>]*>/)![0];
  assert.match(toggle('deploy'), /checked=""/);
  assert.doesNotMatch(toggle('deploy'), /disabled=""/);
  assert.match(toggle('review'), /checked=""/);
  assert.match(toggle('review'), /disabled=""/);
  assert.doesNotMatch(toggle('shop-only'), /checked=""/);
  assert.match(row('shop-only'), /class="tower-skill elsewhere"/);
});

test('the project picker shows chosen projects as chips and lists every project Tower knows, searchable when there are many', () => {
  const projects = ['/work/a', '/work/b', '/work/c', '/work/d', '/work/e', '/work/f'];
  const picker = (value: SkillTargets, list = projects) => renderToStaticMarkup(createElement(ProjectPicker, { value, projects: list, disabled: false, onChange: noop }));
  const chosen = picker({ all: false, projects: ['/work/b', '/elsewhere/g'] });
  assert.match(chosen, /class="skill-target-chips"><li title="\/work\/b">b.*<li title="\/elsewhere\/g">g/s);
  assert.match(chosen, /type="search"[^>]*placeholder="프로젝트 찾기"/);
  assert.equal((chosen.match(/type="checkbox"/g) ?? []).length, 7, 'a chosen project Tower no longer lists stays choosable');
  assert.match(picker({ all: false, projects: [] }, ['/work/a']), /아직 고른 프로젝트가 없습니다/);
  assert.doesNotMatch(picker({ all: false, projects: [] }, ['/work/a']), /type="search"/, 'no search box for a short list');
  const everywhere = picker({ all: true, projects: ['/work/b'] });
  assert.match(everywhere, /role="radio" aria-checked="true" class="active"><svg[^]*?모든 프로젝트/);
  assert.doesNotMatch(everywhere, /skill-target-options/);
});

test('a project’s switch adds or removes exactly that project, and a folder covered from above cannot be switched there', () => {
  assert.deepEqual(toggleTargets({ all: false, projects: ['/work/a'] }, '/work/b', true), { all: false, projects: ['/work/a', '/work/b'] });
  assert.deepEqual(toggleTargets({ all: false, projects: ['/work/a', '/work/b'] }, '/work/b', false), { all: false, projects: ['/work/a'] });
  assert.deepEqual(toggleTargets({ all: false, projects: ['/work/a'] }, '/work/a', true), { all: false, projects: ['/work/a'] });
  const markup = list([skill('deploy', { all: false, projects: ['/work/monitor'] })], { cwd: '/work/monitor/client' });
  const toggle = markup.match(/<input[^>]*role="switch"[^>]*>/)![0];
  assert.match(toggle, /checked=""/);
  assert.match(toggle, /disabled=""/);
  assert.match(markup, /상위 폴더에 적용돼 있습니다/);
});

test('a folder chosen together with a folder above it cannot be switched off on its own', () => {
  const markup = list([skill('deploy', { all: false, projects: ['/work/monitor', '/work/monitor/client'] })], { cwd: '/work/monitor/client' });
  assert.match(markup.match(/<input[^>]*role="switch"[^>]*>/)![0], /disabled=""/);
  const own = list([skill('deploy', { all: false, projects: ['/work/monitor/client'] })], { cwd: '/work/monitor/client' });
  assert.doesNotMatch(own.match(/<input[^>]*role="switch"[^>]*>/)![0], /disabled=""/);
});

test('a skill store that cannot be changed says why', () => {
  const problem = 'Skill state could not be read or moved aside; skills are not changed until Tower restarts.';
  const markup = renderToStaticMarkup(createElement(TowerSkills, { overview: { ...overview([]), problem }, busy: false, proposals: 0, onNew: noop, onEdit: noop, onToggle: noop, onProposals: noop, onAll: noop }));
  assert.match(markup, new RegExp(`role="alert">${problem.replace(/[.;]/g, '\\$&')}<`));
  assert.doesNotMatch(list([]), /role="alert"/);
});
