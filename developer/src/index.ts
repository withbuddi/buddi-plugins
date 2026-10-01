/**
 * @withbuddi/plugin-developer — an agent that works in a workspace.
 *
 * `docs/developer.md` is the whole design. What is worth knowing before
 * reading any of the tools:
 *
 * **Every model-facing tool declares `session`.** Not `auto`, and not `gated`.
 * That is the floor, and it is what makes acceptance §10.5 — "a delegate of
 * the developer agent gets none of its tools" — true by construction rather
 * than by a check somebody has to remember: `ToolRegistry.invoke` refuses a
 * `session` tool without a live owner request, an explicit per-agent grant and
 * `delegationDepth` of 0, and a delegate has none of the three. `tierFor` then
 * resolves the *actual* tier of each call from the workspace's mode and the
 * §5 parser, which is what makes an edit free in `edit` mode and an
 * `npm install` a card in every mode.
 *
 * `developer.workspace` is the exception and is plainly `gated`: it is the
 * grant itself, so there is nothing for a session to have been granted yet.
 * The three `ownerOnly` tools are the Settings page's own writes and no model
 * is ever shown them.
 *
 * **It is not a sandbox.** §9, said out loud: this runs as the owner's user
 * and the workspace boundary is a rule this plugin enforces (`paths.ts`), not
 * an operating-system one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { developerMetrics } from './metrics.js';
import { envDestination } from './secrets.js';
import { developerFiles, developerPages, developerQueries } from './pages.js';
import { developerAgents, developerSkills } from './skills.js';
import { developerViews } from './views.js';
import {
  forgetCommandTool,
  setModeTool,
  setSettingsTool,
  stopAllTool,
  workspaceTool,
} from './tools/workspace.js';
import { editTool, listTool, readTool, searchTool, writeTool } from './tools/files.js';
import { outputTool, runTool, startTool, stopTool } from './tools/run.js';
import { gitTool } from './tools/git.js';
import { previewTool, resolvePreview, summariseTool } from './tools/review.js';
import { screenshotTool } from './tools/screenshot.js';
import { developerCarryOver } from './carryover.js';

/** Absolute, resolved from the *built* file so it is right from `dist`. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export const manifest: PluginManifest = {
  name: 'developer',
  version: '0.1.0',
  schema: 'developer',
  migrationsDir: MIGRATIONS_DIR,
  author: { name: 'withbuddi', url: 'https://withbuddi.com' },
  description:
    'A workspace an agent may read, edit and run code in — one directory you name, with a mode ' +
    'you choose. It runs code you did not write, as your user.',
  // No host, ever. The network-shaped things here are a preview, which is the
  // gateway proxying a loopback port of this machine, and a screenshot, which
  // is a throwaway browser loading that same loopback port and nothing else.
  network: [],
  tools: [
    workspaceTool,
    readTool,
    listTool,
    searchTool,
    writeTool,
    editTool,
    runTool,
    startTool,
    outputTool,
    stopTool,
    gitTool,
    summariseTool,
    previewTool,
    screenshotTool,
    setModeTool,
    stopAllTool,
    setSettingsTool,
    forgetCommandTool,
  ],
  metrics: developerMetrics,
  views: developerViews,
  pages: developerPages,
  queries: developerQueries,
  files: developerFiles,
  agents: developerAgents,
  skills: developerSkills,
  previews: {
    resolve: resolvePreview,
  },
  // Workspace, branch, last commit and uncommitted files, in the note a
  // rolled-over chat opens with (host API 1.16; older hosts ignore it).
  carryOver: developerCarryOver,
  uses: ['files', 'secrets'],
  // `developer.env` (owner-secrets §3): one variable of one workspace's child
  // environment. `start` and `run` deliver the bindings for the workspace they
  // run in; `write` and `edit` refuse content that carries a stored value.
  destinations: [envDestination],
};

export default manifest;

export * from './fence.js';
export * from './paths.js';
export * from './parser.js';
export * from './runlist.js';
export * from './runtime.js';
export * from './modes.js';
export * from './exec.js';
export * from './files.js';
export * from './ports.js';
export * from './git.js';
export * from './processes.js';
export * from './store.js';
export * from './secrets.js';
export * from './summarise.js';
export * from './metrics.js';
export * from './views.js';
export * from './pages.js';
export * from './browse.js';
export * from './archive.js';
export * from './skills.js';
export * from './screenshot.js';
export * from './carryover.js';
export {
  workspaceTool,
  setModeTool,
  stopAllTool,
  setSettingsTool,
} from './tools/workspace.js';
export { readTool, listTool, searchTool, writeTool, editTool } from './tools/files.js';
export { runTool, startTool, outputTool, stopTool } from './tools/run.js';
export { gitTool } from './tools/git.js';
export { summariseTool, previewTool, resolvePreview } from './tools/review.js';
export { screenshotTool } from './tools/screenshot.js';
export { runListFor } from './tools/run.js';
