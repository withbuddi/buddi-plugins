import { chmodSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * Before `npm pack` / `npm publish`: is the helper there, and executable?
 *
 * The publish workflow builds it on a macOS runner and hands it to the Linux
 * job as an artifact, which drops the execute bit; this puts it back (npm
 * packs a file as 0755 only when some execute bit is set). With
 * BUDDI_REQUIRE_HELPER=1 — the publish job sets it — a missing helper fails
 * the pack: the npm package always carries it. A local pack without it only
 * says so. Everything goes to stderr: `npm pack --json` owns stdout.
 */
const helper = fileURLToPath(new URL('../helper/buddi-computer', import.meta.url));
let present = false;
try { present = statSync(helper).isFile(); } catch { present = false; }
if (!present) {
  const message = 'helper/buddi-computer is missing: build it on macOS (node scripts/build-native.mjs --universal) before packing.';
  if (process.env.BUDDI_REQUIRE_HELPER === '1') { console.error(message); process.exit(1); }
  console.error(`${message} Packing without it.`);
} else {
  chmodSync(helper, 0o755);
  console.error('helper/buddi-computer: present, executable.');
}
