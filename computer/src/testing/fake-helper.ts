/**
 * A fake `buddi-computer` for tests: a small Node script written into a
 * temporary folder, answering the helper's JSON protocol from a config baked
 * into it, and appending every request it got to `requests.jsonl` beside it.
 * It is spawned exactly as the real helper is (same bridge, same stripped
 * environment), so what is tested is the plugin's side of the protocol.
 */
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FakeHelperConfig {
  permissions?: { accessibility: boolean; screenRecording: boolean };
  front?: string;
  /** `act` refuses with the helper's "not in front" words, nothing dispatched. */
  notInFront?: boolean;
  title?: string;
}

export async function fakeHelper(config: FakeHelperConfig = {}): Promise<{ dir: string; path: string; requests: () => Promise<Array<Record<string, unknown>>> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fake-'));
  const file = path.join(dir, 'buddi-computer');
  const log = path.join(dir, 'requests.jsonl');
  const settings = { permissions: { accessibility: true, screenRecording: true }, front: 'com.apple.Numbers', notInFront: false, title: 'Household 2026', ...config };
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const config = ${JSON.stringify(settings)};
let input = '';
process.stdin.on('data', (c) => { input += c; }).on('end', () => {
  const request = JSON.parse(input);
  const logged = { ...request }; if ('value' in logged && request.operation === 'secretType') logged.value = '[typed]';
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(logged) + '\\n');
  const answer = (() => {
    switch (request.operation) {
      case 'version': return { version: '1' };
      case 'permissions': return { ...config.permissions, supported: true };
      case 'focused': return { appId: config.front };
      case 'open': return { opened: true };
      case 'observe': return { identity: 'w1', title: config.title, width: 800, height: 600, imageHash: 'h1', jpeg: Buffer.from([255, 216, 255]).toString('base64'),
        nodes: [
          { path: [0], role: 'AXButton', name: 'Add row', value: '', secure: false, enabled: true, bounds: { x: 10, y: 10, width: 80, height: 20 } },
          { path: [1], role: 'AXTextField', name: 'Password', value: '', secure: true, enabled: true, bounds: { x: 10, y: 40, width: 80, height: 20 } },
        ] };
      case 'act': return config.notInFront ? { error: 'The selected app is no longer in front', dispatched: false } : { done: true };
      case 'secretType': return { typed: true };
      default: return { error: 'Unknown operation', dispatched: false };
    }
  })();
  process.stdout.write(JSON.stringify(answer));
});
`;
  await writeFile(file, script);
  await chmod(file, 0o755);
  return {
    dir, path: file,
    requests: async () => {
      try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); }
      catch { return []; }
    },
  };
}
