/**
 * Port detection: the three sources §12 allows, in the order it allows them.
 */
import { describe, expect, it } from 'vitest';
import { detectPort, isPort, portFromCommand, portFromOutput, reloadsItself } from './ports.js';

describe('portFromCommand', () => {
  it.each([
    ['PORT=3000 npm run dev', 3000],
    ['npm run dev -- --port 5173', 5173],
    ['vite --port=4321', 4321],
    ['python -m http.server -p 8080', 8080],
    ['VITE_PORT=1234 pnpm dev', 1234],
  ])('%s', (command, port) => {
    expect(portFromCommand(command)).toBe(port);
  });

  it('says nothing when the command says nothing', () => {
    expect(portFromCommand('pnpm test')).toBeUndefined();
  });

  it('refuses a number that is not a port', () => {
    expect(portFromCommand('serve --port 99999')).toBeUndefined();
    expect(isPort(0)).toBe(false);
    expect(isPort(65_535)).toBe(true);
  });
});

describe('portFromOutput', () => {
  it('reads the line a dev server prints', () => {
    expect(portFromOutput('  ➜  Local:   http://localhost:5173/\n')).toBe(5173);
    expect(portFromOutput('Server running at http://127.0.0.1:8000')).toBe(8000);
  });

  it('reads a sentence with no URL in it', () => {
    expect(portFromOutput('listening on port 4000')).toBe(4000);
    expect(portFromOutput('Ready — started server on port 3001')).toBe(3001);
  });

  it('says nothing about a build log', () => {
    expect(portFromOutput('built in 1234 ms\n42 modules transformed')).toBeUndefined();
  });
});

describe('detectPort', () => {
  it('prefers what the agent said, then the command, then the output', () => {
    expect(detectPort({ explicit: 9999, command: '--port 1', output: 'http://localhost:2' })).toBe(9999);
    expect(detectPort({ command: 'serve --port 1234', output: 'http://localhost:2' })).toBe(1234);
    expect(detectPort({ command: 'pnpm dev', output: 'http://localhost:5173/' })).toBe(5173);
    expect(detectPort({ command: 'pnpm test' })).toBeUndefined();
  });
});

describe('reloadsItself', () => {
  it.each([
    ['vite', {}],
    ['npx vite --port 5173', {}],
    ['node_modules/.bin/next dev', {}],
    ['npm run dev', { dev: 'vite' }],
    ['pnpm dev', { dev: 'astro dev --port 4321' }],
    ['npm start', { start: 'react-scripts start' }],
  ])('%s is a hot-reloading server', (command, scripts) => {
    expect(reloadsItself(command, scripts as Record<string, string>)).toBe(true);
  });

  it.each([
    ['python3 -m http.server 8000', {}],
    ['npx serve .', {}],
    ['npm run dev', { dev: 'node server.mjs' }],
    ['npm run dev', {}],
    ['node server.mjs', { dev: 'vite' }],
  ])('%s is a static page, reloaded by the canvas', (command, scripts) => {
    expect(reloadsItself(command, scripts as Record<string, string>)).toBe(false);
  });
});
