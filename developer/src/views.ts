/**
 * How the canvas draws the developer's results.
 *
 * **A screenshot is an `image`.** `developer.screenshot` puts its PNG in the
 * Files library and names it by id; the canvas builds the library's own URLs.
 * (`developer.read` still refuses a binary file and stores nothing.)
 *
 * **A change is a `diff`.** §6 says "the unit of review is the diff": the diff
 * is the body of the thing the owner reads, and `diff` is the renderer whose
 * body is a change — added and removed lines told apart — with facts drawn
 * above it. For `developer.summarise` those facts are exactly what a
 * `keyvalue` view would have carried — branch, base, files, the test command
 * and how it went — so the owner reads "on this branch, these files, tests
 * green" and then the change itself, in one panel and one scroll. A write and
 * an edit are the same thing at the size of one file: the path is the title.
 *
 * (Two descriptors for one tool are not expressible: a descriptor is
 * `{ tool, renderer, map }` and the canvas draws one per result.)
 *
 * The summary's diff is read from `plain`, not `diff`: the result carries it
 * fenced for the model and plain for the owner, and the markers are no part
 * of a change. A write's and an edit's `diff` is the short form `shortDiff`
 * writes, which the renderer reads by the same prefixes.
 */
import type { ViewDescriptor } from '@buddi/core/plugin';

export const developerViews: ViewDescriptor[] = [
  {
    tool: 'developer.summarise',
    renderer: 'diff',
    title: 'What changed',
    map: {
      title: { path: 'branch' },
      diff: 'plain',
      metadata: [
        { label: 'Branch', value: { path: 'branch' } },
        { label: 'Base', value: { path: 'base' } },
        { label: 'Files changed', value: { path: 'changedFiles' }, unit: 'text' },
        { label: 'Diff stat', value: { path: 'diffStat' } },
        { label: 'Test command', value: { path: 'testCommand' } },
        { label: 'Test result', value: { path: 'testResult' } },
        { label: 'Truncated', value: { path: 'diffTruncated' } },
      ],
    },
  },
  {
    tool: 'developer.write',
    renderer: 'diff',
    title: 'File written',
    map: {
      title: { path: 'path' },
      diff: 'diff',
      metadata: [
        { label: 'Created', value: { path: 'created' } },
        { label: 'Bytes', value: { path: 'bytes' }, unit: 'number' },
      ],
    },
  },
  {
    tool: 'developer.edit',
    renderer: 'diff',
    title: 'File edited',
    map: {
      title: { path: 'path' },
      diff: 'diff',
      metadata: [
        { label: 'Replacements', value: { path: 'replacements' }, unit: 'number' },
        { label: 'Note', value: { path: 'note' } },
      ],
    },
  },
  /**
   * A running process, framed beside what it is printing.
   *
   * `src` is a *path into the result* whose value names the process
   * (`/preview/developer/<name>/`), not a URL: previews are served on a second
   * origin behind a ticket the dashboard's own link route hands out, and the
   * panel calls that route for itself. A descriptor that tried to name a URL
   * would be drawn as nothing, which is the right answer.
   */
  {
    tool: 'developer.preview',
    renderer: 'preview',
    title: 'Preview',
    map: {
      src: 'preview',
      title: { path: 'name' },
      output: 'plain',
      port: 'port',
      ports: 'ports',
      reloadsItself: 'reloadsItself',
    },
  },
  /**
   * A process just started is a preview too, without the agent asking.
   *
   * When `start` saw the port, `preview` names the process and the panel is
   * drawn at once. When it did not, `preview` is null and `awaiting` names
   * the process instead: the canvas draws no tab, asks the dashboard whether
   * that preview is being served yet, and opens it when it is — the plugin
   * watches the pid in the meantime and writes the port on its row the moment
   * the kernel says it holds one.
   */
  {
    tool: 'developer.start',
    renderer: 'preview',
    title: 'Preview',
    map: {
      src: 'preview',
      awaiting: 'awaiting',
      title: { path: 'name' },
      port: 'port',
      ports: 'ports',
      reloadsItself: 'reloadsItself',
    },
  },
  /**
   * And the other thing an owner stares at: what a command printed, as a
   * terminal — the command on top with the exit code and the elapsed time
   * beside it, the output as the body. `plain` is the output with no fence
   * and no colour codes; `omittedBytes` is what the 200 KB bound let go from
   * the head, which the panel says.
   */
  {
    tool: 'developer.run',
    renderer: 'terminal',
    title: 'Command output',
    map: {
      command: { path: 'command' },
      output: 'plain',
      exitCode: 'exitCode',
      elapsedMs: 'elapsedMs',
      omittedBytes: 'omittedBytes',
      metadata: [
        { label: 'Directory', value: { path: 'path' } },
        { label: 'State', value: { path: 'state' } },
      ],
    },
  },
  /**
   * What a running process has printed lately: the same terminal, headed by
   * the command it runs. No exit code — it has not exited.
   */
  {
    tool: 'developer.output',
    renderer: 'terminal',
    title: 'Process output',
    map: {
      command: { path: 'command' },
      output: 'plain',
      omittedBytes: 'omittedBytes',
      metadata: [
        { label: 'Process', value: { path: 'name' } },
        { label: 'Port', value: { path: 'port' } },
      ],
    },
  },
  /**
   * A page the agent's own server serves, as a picture. `src` is the library
   * id, never a URL; the caption says where it was taken.
   */
  {
    tool: 'developer.screenshot',
    renderer: 'image',
    title: 'Screenshot',
    map: {
      src: 'id',
      title: { path: 'filename' },
      caption: { path: 'note' },
    },
  },
];
