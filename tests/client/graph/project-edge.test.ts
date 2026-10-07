import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, type EdgeProps } from '@xyflow/react';
import { ProjectEdge } from '../../../client/src/graph/ProjectEdge.js';

const props: EdgeProps = {
  id: 'project', source: 'host', target: 'folder', sourceX: 100, sourceY: 80, targetX: 100, targetY: 120,
  sourcePosition: Position.Bottom, targetPosition: Position.Top, animated: true,
  style: { stroke: '#2e3e52', strokeWidth: 1.2 }, pathOptions: { borderRadius: 14 },
};
const render = (patch: Partial<EdgeProps> = {}) => renderToStaticMarkup(createElement('svg', null, createElement(ProjectEdge, { ...props, ...patch })));

test('straight and bent project connections keep their route when activity changes', () => {
  for (const coordinates of [{}, { targetX: 200, targetY: 80 }, { targetX: 260, targetY: 150 }]) {
    const active = render(coordinates);
    const idle = render({ ...coordinates, animated: false });
    assert.equal(active.match(/ d="([^"]+)"/)?.[1], idle.match(/ d="([^"]+)"/)?.[1]);
    assert.match(active, /gradientUnits="userSpaceOnUse"/);
    assert.doesNotMatch(idle, /linearGradient|url\(/);
    assert.match(idle, /stroke:#2e3e52;stroke-width:1.2/);
  }
});

test('simultaneous active connections reference their own gradient regardless of project id', () => {
  const markup = renderToStaticMarkup(createElement('svg', null,
    createElement(ProjectEdge, { ...props, id: 'folder:%2Fone' }),
    createElement(ProjectEdge, { ...props, id: 'folder:%2Ftwo' })));
  const ids = [...markup.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.ok(markup.includes(`stroke:url(#${id})`));
});
