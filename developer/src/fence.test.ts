import { describe, expect, it } from 'vitest';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, fenced, stripAnsi } from './fence.js';

describe('the fence', () => {
  it('gives the model the markers and the owner the plain text, colours gone from both', () => {
    const vite = '\x1b[32m\u2192\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m4173\x1b[22m/\x1b[39m';
    const out = fenced(vite);
    expect(out.plain).toBe('\u2192  Local:   http://localhost:4173/');
    expect(out.text).toBe(`${UNTRUSTED_OPEN}${out.plain}${UNTRUSTED_CLOSE}`);
    expect(out.plain).not.toContain(UNTRUSTED_OPEN);
  });

  it('strips cursor moves and titles too, and leaves ordinary text alone', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Gbuilding\x1b]0;title\x07 done')).toBe('building done');
    expect(stripAnsi('plain [32m brackets')).toBe('plain [32m brackets');
  });
});
