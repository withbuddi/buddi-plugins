/**
 * The developer's view descriptors, as the canvas will read them.
 *
 * Through core's own schema, and against the shape of the results the tools
 * return: a descriptor path that misses its field is a panel that draws
 * nothing, and no type checker sees it.
 */
import { describe, expect, it } from 'vitest';
import { parseViewDescriptors } from '@buddi/core/testing';
import { developerViews } from './views.js';
import { manifest } from './index.js';

const named = (tool: string) => developerViews.find((view) => view.tool === tool);

describe('the developer views', () => {
  it('all parse, for tools this plugin contributes', () => {
    expect(() =>
      parseViewDescriptors(developerViews, { plugin: 'developer', tools: manifest.tools.map((tool) => tool.name) }),
    ).not.toThrow();
  });

  it('draws run as a terminal: the command on top, exit code and time beside it, the plain output', () => {
    expect(named('developer.run')).toMatchObject({
      renderer: 'terminal',
      map: {
        command: { path: 'command' },
        output: 'plain',
        exitCode: 'exitCode',
        elapsedMs: 'elapsedMs',
        omittedBytes: 'omittedBytes',
      },
    });
  });

  it('draws a process output as the same terminal, headed by its command', () => {
    expect(named('developer.output')).toMatchObject({
      renderer: 'terminal',
      map: { command: { path: 'command' }, output: 'plain', omittedBytes: 'omittedBytes' },
    });
  });

  it('hands both previews the ports their process listens on', () => {
    expect(named('developer.preview')?.map).toMatchObject({ ports: 'ports', port: 'port', output: 'plain' });
    expect(named('developer.start')?.map).toMatchObject({ ports: 'ports', port: 'port' });
  });

  it('draws a screenshot as an image named by its library id, the one result that names a picture', () => {
    expect(developerViews.filter((view) => view.renderer === 'image').map((view) => view.tool)).toEqual([
      'developer.screenshot',
    ]);
    expect(named('developer.screenshot')).toMatchObject({
      renderer: 'image',
      map: { src: 'id', title: { path: 'filename' }, caption: { path: 'note' } },
    });
  });
});
