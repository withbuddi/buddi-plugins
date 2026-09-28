/**
 * Settings → Developer (§8).
 *
 * "the workspaces list (agent, directory, mode, running processes), a 'Stop
 * all processes' action, and the sentence."
 *
 * **One judgement call worth stating.** §8 wants the mode to be a select the
 * owner changes in place, and a table column cannot be one: the component set
 * has `table` for rows and `form` for controls, and it does not grow to fit a
 * plugin's wish (docs/plugins.md §2.5a). So the modes are a table that *shows*
 * every agent's mode and one small form under it whose two selects — which
 * agent, which mode — write through `developer.set_mode`. The select is bound
 * to the tool exactly as asked; it just lives under the table instead of
 * inside a cell, and the agent list is a `optionsFrom` read of the same query
 * the table is drawn from, so it can never offer an agent that is not there.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery, ToolContext } from '@buddi/core/plugin';
import { MODE_OPTIONS, allowedCommandRows, processRows, workspaceRows } from './tools/workspace.js';
import {
  archiveFolder,
  archiveParams,
  listFolder,
  listParams,
  readFile,
  readParams,
  statFile,
  statParams,
  workspaceFor,
  workspaceParams,
} from './browse.js';

/** The sentence from §8, verbatim. It is the reason the page exists. */
export const DEVELOPER_NOTICE =
  'A developer agent runs code you did not write, inside this directory, with the rights of ' +
  'your user. Give it a workspace you would let a colleague use.';

export const developerQueries: PageQuery[] = [
  {
    name: 'workspaces',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      return workspaceRows(ctx);
    },
  },
  {
    name: 'processes',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      return processRows(ctx);
    },
  },
  {
    name: 'allowed',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      return allowedCommandRows(ctx);
    },
  },
  /*
   * The canvas's Files tab (`developerFiles` below): the owner reading an
   * agent's workspace, bounded exactly as the agent's own reads are
   * (`browse.ts`), with no tier in the way because nothing here writes.
   */
  {
    name: 'workspace',
    params: workspaceParams,
    async produce(params, ctx: ToolContext) {
      return workspaceFor(params as z.infer<typeof workspaceParams>, ctx);
    },
  },
  {
    name: 'folder',
    params: listParams,
    async produce(params, ctx: ToolContext) {
      return listFolder(params as z.infer<typeof listParams>, ctx);
    },
  },
  {
    name: 'file',
    params: statParams,
    async produce(params, ctx: ToolContext) {
      return statFile(params as z.infer<typeof statParams>, ctx);
    },
  },
  {
    name: 'file_bytes',
    params: readParams,
    async produce(params, ctx: ToolContext) {
      return readFile(params as z.infer<typeof readParams>, ctx);
    },
  },
  {
    name: 'archive',
    params: archiveParams,
    async produce(params, ctx: ToolContext) {
      return archiveFolder(params as z.infer<typeof archiveParams>, ctx);
    },
  },
];

/** The queries the canvas's Files tab reads a workspace with. */
export const developerFiles = {
  workspace: 'workspace',
  list: 'folder',
  stat: 'file',
  read: 'file_bytes',
  archive: 'archive',
} as const;

export const developerPages: PageDescriptor[] = [
  {
    id: 'settings',
    title: 'Developer',
    place: 'settings',
    icon: 'plug',
    data: { query: 'workspaces' },
    body: [
      { kind: 'notice', text: DEVELOPER_NOTICE, tone: 'warning' },
      {
        kind: 'section',
        title: 'Workspaces',
        note: 'One directory per agent, and the mode you chose for it.',
        body: [
          {
            kind: 'table',
            query: { query: 'workspaces' },
            rows: 'workspaces',
            columns: [
              { key: 'agent', label: 'Agent' },
              { key: 'dir', label: 'Directory' },
              { key: 'mode', label: 'Mode', pill: {} },
              { key: 'processes', label: 'Running', type: 'number' },
            ],
            empty: 'No agent has a workspace yet. One is granted by approving developer.workspace.',
          },
          {
            kind: 'notice',
            text:
              'run — the default — lets this project\'s own scripts and the ordinary tools run without asking; ' +
              'a new package, anything that reaches the network, a path outside the workspace, elevated rights ' +
              'and the known destroyers are put to you, and on that card you can say "always" for this ' +
              'workspace. edit lets edits through and asks for every command. ask asks for every write too.',
          },
          {
            kind: 'form',
            title: 'Change a mode',
            fields: [
              {
                name: 'agent',
                label: 'Agent',
                type: 'select',
                required: true,
                optionsFrom: {
                  query: { query: 'workspaces' },
                  rows: 'workspaces',
                  value: 'agent',
                  label: 'agent',
                },
              },
              {
                name: 'mode',
                label: 'Mode',
                type: 'select',
                required: true,
                options: [...MODE_OPTIONS],
              },
            ],
            submit: {
              tool: 'developer.set_mode',
              label: 'Set mode',
              busy: 'Setting…',
              args: { agent: { field: 'agent' }, mode: { field: 'mode' } },
              done: { path: 'note' },
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'Commands you allowed',
        note: 'What you said "always" to on an approval card, per workspace. Forget one and it is a card again.',
        body: [
          {
            kind: 'table',
            query: { query: 'allowed' },
            rows: 'allowed',
            columns: [
              { key: 'agent', label: 'Agent' },
              { key: 'dir', label: 'Workspace' },
              { key: 'command', label: 'Command' },
              { key: 'scope', label: 'Scope' },
            ],
            actions: [
              {
                tool: 'developer.forget_command',
                label: 'Forget',
                tone: 'danger',
                busy: 'Forgetting…',
                args: { id: { row: 'id' } },
                then: 'refresh',
                done: { path: 'note' },
              },
            ],
            empty: 'Nothing yet. When a command asks for approval, the card offers to remember your answer.',
          },
        ],
      },
      {
        kind: 'section',
        title: 'Processes',
        note: 'Dev servers and watchers agents started. They stop when buddi stops.',
        actions: [
          {
            kind: 'button',
            action: {
              tool: 'developer.stop_all',
              label: 'Stop all processes',
              tone: 'danger',
              confirm: 'Stop every process every developer agent started?',
              busy: 'Stopping…',
              done: { path: 'note' },
            },
          },
        ],
        body: [
          {
            kind: 'table',
            query: { query: 'processes' },
            rows: 'processes',
            columns: [
              { key: 'agent', label: 'Agent' },
              { key: 'name', label: 'Name' },
              { key: 'command', label: 'Command' },
              { key: 'pid', label: 'PID', type: 'number' },
              { key: 'port', label: 'Port', type: 'number' },
            ],
            empty: 'Nothing is running.',
          },
        ],
      },
      {
        kind: 'section',
        title: 'Tailscale routes',
        body: [
          {
            kind: 'notice',
            text:
              'With this on, a process that listens on a port also gets tailscale serve --https=<port> on this ' +
              'machine: anyone on your tailnet can reach it at https://<host>:<port>, guarded by the tailnet ' +
              'alone and not by the dashboard sign-in. The route is removed when the process stops. Off by default.',
          },
          {
            kind: 'form',
            initial: { query: 'workspaces' },
            fields: [
              {
                name: 'tailscaleRoutes',
                label: 'Add a tailnet route per started process',
                type: 'select',
                required: true,
                from: 'tailscaleRoutes',
                options: [
                  { value: 'false', label: 'Off' },
                  { value: 'true', label: 'On' },
                ],
              },
            ],
            submit: {
              tool: 'developer.set_settings',
              label: 'Save',
              busy: 'Saving…',
              args: { tailscaleRoutes: { field: 'tailscaleRoutes' } },
              done: { path: 'note' },
            },
          },
        ],
      },
    ],
  },
];
