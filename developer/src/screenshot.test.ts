/**
 * The screenshot's pure half: what counts as a path, and the viewport caps.
 * The browser and the port check are in `screenshot.db.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  CHROMIUM_INSTALL_COMMAND,
  SCREENSHOT_MAX_HEIGHT,
  SCREENSHOT_MAX_WIDTH,
  screenshotPath,
  screenshotViewport,
} from './screenshot.js';

describe('screenshotPath', () => {
  it('takes a path on the server, with a query and a fragment', () => {
    expect(screenshotPath(undefined)).toEqual({ path: '/' });
    expect(screenshotPath('/settings?tab=2#top')).toEqual({ path: '/settings?tab=2#top' });
    expect(screenshotPath('/a/../b')).toEqual({ path: '/b' });
  });

  it('refuses anything shaped like a URL or a host', () => {
    for (const raw of [
      'http://example.com/',
      'https://127.0.0.1:5432/',
      '//example.com/x',
      '/\\example.com',
      'example.com/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      ' /x',
      '/x\n',
      '',
    ]) {
      const result = screenshotPath(raw);
      expect(result, raw).toHaveProperty('refusal');
      expect((result as { refusal: string }).refusal).toMatch(/takes no URL and no host/);
    }
  });
});

describe('screenshotViewport', () => {
  it('defaults to 1280×800 and holds the caps', () => {
    expect(screenshotViewport()).toEqual({ width: 1280, height: 800 });
    expect(screenshotViewport(99_999, 99_999)).toEqual({
      width: SCREENSHOT_MAX_WIDTH,
      height: SCREENSHOT_MAX_HEIGHT,
    });
    expect(screenshotViewport(10, 10)).toEqual({ width: 320, height: 240 });
  });

  it('names the exact install command, pinned to the Playwright buddi uses', () => {
    expect(CHROMIUM_INSTALL_COMMAND).toMatch(/^npx playwright@\d+\.\d+\.\d+ install chromium$/);
  });
});
