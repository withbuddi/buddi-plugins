/**
 * Settings → Image: which provider account draws, with which model, and how
 * many pictures a day. The owner's own: `image.set_settings` is `ownerOnly`,
 * so no model is ever shown it.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery, ProviderAccountListing, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { backendFor } from './backends/index.js';
import { countToday, getSettings, lastSuccessByAccount, recentGenerations, setSettings } from './store.js';

export const IMAGE_NOTICE =
  'Pictures are made with the provider account you choose here, from Settings → Model accounts. ' +
  'A ChatGPT subscription (Codex) account uses your subscription; an OpenAI, Gemini or OpenAI-compatible ' +
  'account is billed per image by that service. The first image in each conversation asks you first; ' +
  'the rest of that conversation runs, up to the daily limit.';

/** What the "Default model" column says for a compatible server: its chat model is no image model. */
export const SET_A_MODEL = 'set a model';

/**
 * Every account, with whether it can draw, for the page and the picker.
 *
 * `lastSuccess` is `lastSuccessByAccount`: an OpenAI-compatible server (a
 * local one, usually) reads "untested" until one picture has come back from
 * it, since being configured says only that it chats. Its default model reads
 * "set a model": the account's own default is a chat model.
 */
export function accountRows(ctx: ToolContext, lastSuccess: ReadonlyMap<string, Date> = new Map()): Array<{
  id: string; label: string; kind: ProviderAccountListing['kind']; backend: string; defaultModel: string; state: string; canDraw: boolean;
}> {
  let listed: ProviderAccountListing[] = [];
  try {
    listed = ctx.buddi?.accounts?.list() ?? [];
  } catch {
    // No model accounts in this process: nothing to offer.
  }
  return listed.map((a) => {
    const backend = backendFor(a);
    const compatible = backend?.kind === 'openai-compatible';
    return {
      id: a.id,
      label: a.label,
      kind: a.kind,
      backend: backend?.label ?? 'no image backend',
      defaultModel: !backend ? '' : compatible ? SET_A_MODEL : backend.defaultModel(a),
      state: !backend ? 'not usable' : !a.enabled ? 'disabled' : !a.configured ? 'not connected'
        : compatible && !lastSuccess.has(a.id) ? 'untested' : 'ready',
      canDraw: Boolean(backend),
    };
  });
}

export const imageQueries: PageQuery[] = [
  {
    name: 'settings',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      const settings = await getSettings(ctx.buddi!.db);
      const rows = accountRows(ctx, await lastSuccessByAccount(ctx.buddi!.db));
      return {
        account: settings.accountId ?? '',
        model: settings.model ?? '',
        dailyCap: settings.dailyCap,
        today: await countToday(ctx.buddi!.db, ctx.buddi!.clock.now(), ctx.buddi!.owner.timezone),
        // Only accounts whose kind has a backend are offered.
        choices: rows
          .filter((r) => r.canDraw)
          .map((r) => ({
            id: r.id,
            label: `${r.label} — ${r.backend}, ${r.defaultModel === SET_A_MODEL ? 'set a model' : `default model ${r.defaultModel || 'none'}`} (${r.state})`,
          })),
        accounts: rows,
      };
    },
  },
  {
    name: 'recent',
    params: z.object({}),
    async produce(_params, ctx: ToolContext) {
      return { images: await recentGenerations(ctx.buddi!.db, ctx.buddi!.files!, 20) };
    },
  },
];

const settingsInput = z
  .object({
    account: z.string().max(200).describe('A provider account id, or empty for none.'),
    model: z.string().max(150).optional(),
    dailyCap: z.coerce.number().int().min(1).max(1000),
  })
  .strict();

export const setSettingsTool: ToolDefinition<z.infer<typeof settingsInput>, unknown> = {
  name: 'image.set_settings',
  description: "The Image settings. The owner's own.",
  tier: 'auto',
  ownerOnly: true,
  input: settingsInput,
  async execute(input, ctx) {
    const accountId = input.account.trim() || null;
    if (accountId) {
      const account = ctx.buddi!.accounts!.list().find((a) => a.id === accountId);
      if (!account) throw new Error('That account is not in Settings → Model accounts.');
      if (!backendFor(account)) throw new Error(`A ${account.kind} account cannot make images here.`);
      // Choosing it here is the owner binding it to this plugin: only a bound
      // account can be resolved through ctx.buddi.accounts.
      await ctx.buddi!.accounts!.bind(accountId);
    }
    const model = input.model?.trim() || null;
    if (model && (model.length > 150 || /[\r\n\x00-\x1f]/.test(model))) throw new Error('Enter a valid model id.');
    const saved = await setSettings(ctx.buddi!.db, { accountId, model, dailyCap: input.dailyCap }, ctx.buddi!.clock.now());
    return {
      ...saved,
      note: accountId
        ? `Saved. Images use ${ctx.buddi!.accounts!.list().find((a) => a.id === accountId)?.label}${model ? ` with ${model}` : ''}, up to ${saved.dailyCap} a day.`
        : 'Saved. No account is chosen, so image.generate refuses until one is.',
    };
  },
};

export const imagePages: PageDescriptor[] = [
  {
    id: 'settings',
    title: 'Image',
    place: 'settings',
    icon: 'file',
    data: { query: 'settings' },
    body: [
      { kind: 'notice', text: IMAGE_NOTICE },
      {
        kind: 'section',
        title: 'Account and model',
        note: 'Leave the model blank for the default the account list shows: gpt-5.5 calling the image tool on a ChatGPT subscription, gpt-image-1 on OpenAI, imagen-4.0-generate-001 on Gemini. An OpenAI-compatible server needs its image model typed here; it reads "untested" until one picture has come back from it.',
        body: [
          {
            kind: 'form',
            initial: { query: 'settings' },
            fields: [
              {
                name: 'account',
                label: 'Account',
                type: 'select',
                from: 'account',
                optionsFrom: { query: { query: 'settings' }, rows: 'choices', value: 'id', label: 'label' },
              },
              { name: 'model', label: 'Model', type: 'text', from: 'model', hint: 'Any model id the service takes, e.g. gpt-image-1, imagen-4.0-generate-001, or a compatible server\'s own name' },
              { name: 'dailyCap', label: 'Images per day', type: 'number', min: 1, max: 1000, step: 1, required: true, from: 'dailyCap' },
            ],
            submit: {
              tool: 'image.set_settings',
              label: 'Save',
              busy: 'Saving…',
              args: { account: { field: 'account' }, model: { field: 'model' }, dailyCap: { field: 'dailyCap' } },
              done: { path: 'note' },
            },
          },
          {
            kind: 'table',
            query: { query: 'settings' },
            rows: 'accounts',
            columns: [
              { key: 'label', label: 'Account' },
              { key: 'kind', label: 'Kind' },
              { key: 'backend', label: 'Image backend' },
              { key: 'defaultModel', label: 'Default model' },
              { key: 'state', label: 'State', pill: {} },
            ],
            empty: 'No provider accounts yet. Add one in Settings → Model accounts.',
          },
        ],
      },
      {
        kind: 'section',
        title: 'Recent images',
        note: 'The newest twenty, with who asked and on what.',
        body: [
          {
            kind: 'table',
            query: { query: 'recent' },
            rows: 'images',
            columns: [
              { key: 'name', label: 'File' },
              { key: 'agent', label: 'Agent' },
              { key: 'prompt', label: 'Prompt' },
              { key: 'model', label: 'Model' },
              { key: 'createdAt', label: 'Made', type: 'date' },
            ],
            empty: 'No images yet.',
          },
        ],
      },
    ],
  },
];
