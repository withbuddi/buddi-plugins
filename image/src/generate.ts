/**
 * `image.generate` — one picture from a prompt, kept in the Files library.
 *
 * **The tier.** Core has no "approve once per conversation" tier: `session`
 * is "only inside a live owner request, never in a delegate", which would
 * shut out exactly the agents that ask the Illustrator for a picture, and
 * `gated` asks every time. So the tool declares `auto` and narrows every call
 * with `tierFor`: gated until the owner has approved one `image.generate` in
 * this conversation (a delegated colleague's conversation counts as the one
 * that delegated to it), then auto. The rule reads core's own action ledger
 * and the conversation id the runtime stamped — nothing a model chose — and a
 * throw is a refusal. The daily cap then bounds what "auto" can spend.
 *
 * **The account first.** `tierFor` checks the account before anything else,
 * so a call with nothing to draw with is refused at once — no card for the
 * owner to approve only to learn there was no account — and the card, when
 * there is one, names the account and model it will use.
 *
 * **Two readers.** The result's `forAgent` is the model's instruction ("you
 * have not seen it"), which the canvas never draws (core's
 * `AGENT_ONLY_FIELD`); the owner reads the prompt instead, folded under it.
 *
 * **The prompt is data.** It goes to the image model as the description of a
 * picture and to the Files library as the caption; nothing here follows it.
 * **References are library ids**, read by id from `core.artifacts`, and each
 * must be an image by its bytes.
 */
import { z } from 'zod';
import type { EffectDescription, ProviderAccountListing, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { backendFor, ImageRefusal, type Aspect, type Reference } from './backends/index.js';
import { EXTENSIONS, sniffImage } from './magic.js';
import { countToday, getSettings, recordGeneration } from './store.js';

export const GENERATE_TIMEOUT_MS = 3 * 60_000;
export const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sentence for "there is nothing to draw with". */
export const NO_ACCOUNT =
  'refused: no image account is connected. Connect a ChatGPT subscription, OpenAI, Gemini or ' +
  'OpenAI-compatible account in Settings → Model accounts, then choose it in Settings → Image.';

export const generateInput = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe('One clear description of the picture: subject, style, composition, palette, what to avoid.'),
    references: z
      .array(z.string().uuid())
      .max(MAX_REFERENCES)
      .optional()
      .describe('Up to four Files library ids of images to use as references.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('A short file name for the result, without extension.'),
    aspect: z.enum(['square', 'portrait', 'landscape']).optional().describe('Defaults to square.'),
  })
  .strict();

export type GenerateInput = z.infer<typeof generateInput>;

export interface GenerateOutput {
  artifacts: Array<{ id: string }>;
  id: string;
  name: string;
  bytes: number;
  width?: number;
  height?: number;
  backend: string;
  account: string;
  model: string;
  /** What the picture was asked for: the owner's caption on the canvas. */
  prompt: string;
  /** For the model only; the canvas never draws it (core's `AGENT_ONLY_FIELD`). */
  forAgent: string;
}

export function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return cleaned === '' ? 'image' : cleaned;
}

/** The account the owner chose, with its backend, or the sentence that says why not. */
export async function chooseAccount(ctx: ToolContext): Promise<{ account: ProviderAccountListing; model: string; backendKind: string }> {
  // The owner's model accounts, as far as they bound them to this plugin:
  // choosing one in Settings → Image binds it (settings.ts), and the account
  // chosen before bindings existed was bound by migrations/002.
  const accounts = ctx.buddi!.accounts;
  if (!accounts) throw new ImageRefusal(NO_ACCOUNT);
  let all: ProviderAccountListing[];
  try {
    all = accounts.list();
  } catch {
    // No model accounts in this process at all.
    throw new ImageRefusal(NO_ACCOUNT);
  }
  const settings = await getSettings(ctx.buddi!.db);
  const usable = all.filter((a) => backendFor(a) && a.enabled && a.configured);
  if (!settings.accountId) {
    if (usable.length === 0) throw new ImageRefusal(NO_ACCOUNT);
    throw new ImageRefusal('refused: no image account is chosen yet. The owner picks one in Settings → Image.');
  }
  const account = all.find((a) => a.id === settings.accountId);
  if (!account) {
    throw new ImageRefusal(usable.length === 0 ? NO_ACCOUNT : 'refused: the image account chosen in Settings → Image no longer exists. The owner picks another there.');
  }
  const backend = backendFor(account);
  if (!backend) {
    throw new ImageRefusal(`refused: "${account.label}" is a ${account.kind} account, and there is no image backend for that kind. The owner picks another in Settings → Image.`);
  }
  if (!account.enabled) throw new ImageRefusal(`refused: the image account "${account.label}" is disabled in Settings → Model accounts.`);
  if (!account.configured) {
    throw new ImageRefusal(`refused: the image account "${account.label}" is not connected. Connect it in Settings → Model accounts.`);
  }
  const model = settings.model?.trim() || backend.defaultModel(account);
  return { account, model, backendKind: backend.kind };
}

async function loadReferences(ids: readonly string[], ctx: ToolContext): Promise<Reference[]> {
  const out: Reference[] = [];
  for (const id of new Set(ids)) {
    const row = await ctx.buddi!.files!.get(id);
    if (!row) throw new ImageRefusal(`refused: ${id} is not a file in the Files library.`);
    if (row.sizeBytes > MAX_REFERENCE_BYTES) throw new ImageRefusal(`refused: reference ${id} is larger than 20 MB.`);
    const bytes = await ctx.buddi!.files!.read(row.id);
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new ImageRefusal(`refused: reference ${id} (${row.filename ?? 'unnamed'}) is not an image.`);
    out.push({ bytes, mime: sniffed.mime, filename: row.filename ?? `${id}.${EXTENSIONS[sniffed.mime]}` });
  }
  return out;
}

export interface GenerateToolOptions {
  timeoutMs?: number;
}

export function createGenerateTool(options: GenerateToolOptions = {}): ToolDefinition<GenerateInput, GenerateOutput> {
  const timeoutMs = options.timeoutMs ?? GENERATE_TIMEOUT_MS;
  return {
    name: 'image.generate',
    description:
      'Make one image from a prompt and keep it in the owner\'s Files library; it shows on the canvas. ' +
      'Write the prompt as one clear description: subject, style, composition, palette, and what to avoid. ' +
      'No text in the picture unless asked. `references` are Files library ids of images to work from. ' +
      'You cannot see the result: report what you asked for and the library id you get back.',
    tier: 'auto',
    producesArtifacts: true,
    timeoutMs: timeoutMs + 20_000,
    input: generateInput,
    async tierFor(_input, ctx) {
      // Nothing to draw with is a refusal now, not after the owner approved.
      await chooseAccount(ctx);
      if (ctx.conversationId && UUID.test(ctx.conversationId) && (await ctx.buddi!.approvals.approvedInConversation('image.generate', ctx.conversationId))) {
        return { tier: 'auto' };
      }
      return {
        tier: 'gated',
        reason: 'The first image in a conversation is yours to approve; later ones in the same conversation then run.',
      };
    },
    async describe(input, ctx): Promise<EffectDescription> {
      const chosen = await chooseAccount(ctx);
      const where = `${chosen.account.label} · ${chosen.model}`;
      const envelope = { accountId: chosen.account.id, model: chosen.model, backend: chosen.backendKind };
      const refs = input.references?.length ?? 0;
      const quoted = input.prompt.length > 300 ? `${input.prompt.slice(0, 300)}…` : input.prompt;
      return {
        envelope: { tool: 'image.generate', ...envelope, prompt: input.prompt, references: input.references ?? [], aspect: input.aspect ?? 'square', name: input.name ?? null },
        preview: `Generate one ${input.aspect ?? 'square'} image with ${where}${refs ? `, from ${refs} reference image${refs > 1 ? 's' : ''}` : ''}: "${quoted}"`,
      };
    },
    async execute(input, ctx) {
      const agentId = ctx.agentId?.trim();
      if (!agentId) throw new ImageRefusal('refused: an image is made for an agent, and this call has none.');
      const chosen = await chooseAccount(ctx);
      const backend = backendFor(chosen.account)!;

      const settings = await getSettings(ctx.buddi!.db);
      const now = ctx.buddi!.clock.now();
      const made = await countToday(ctx.buddi!.db, now, ctx.buddi!.owner.timezone);
      if (made >= settings.dailyCap) {
        throw new ImageRefusal(
          `refused: ${made} images have been made today, and the daily limit is ${settings.dailyCap}. ` +
            'The owner can raise it in Settings → Image.',
        );
      }

      const references = await loadReferences(input.references ?? [], ctx);
      const aspect: Aspect = input.aspect ?? 'square';
      const signal = ctx.signal ?? new AbortController().signal;
      const result = await backend.generate(
        { prompt: input.prompt, references, aspect },
        { accounts: ctx.buddi!.accounts!, account: chosen.account, model: chosen.model, signal, timeoutMs },
      );
      const sniffed = sniffImage(result.bytes);
      if (!sniffed) throw new ImageRefusal('refused: what came back is not an image, so nothing was stored.');

      const filename = `${slug(input.name ?? input.prompt)}.${EXTENSIONS[sniffed.mime]}`;
      const saved = await ctx.buddi!.files!.save({
        bytes: result.bytes,
        mime: sniffed.mime,
        filename,
        caption: `Generated by ${agentId} with ${chosen.account.label} (${chosen.model}) from: ${input.prompt.slice(0, 2000)}`,
      });
      const conversationId = saved.conversationId;
      await recordGeneration(ctx.buddi!.db, {
        artifactId: saved.id,
        agentId,
        conversationId,
        prompt: input.prompt,
        aspect,
        referenceIds: [...new Set(input.references ?? [])],
        backend: backend.kind,
        accountId: chosen.account.id,
        model: chosen.model,
        bytes: saved.sizeBytes,
        now,
      });

      return {
        artifacts: [{ id: saved.id }],
        id: saved.id,
        name: saved.filename ?? filename,
        bytes: saved.sizeBytes,
        ...(sniffed.width !== undefined ? { width: sniffed.width } : {}),
        ...(sniffed.height !== undefined ? { height: sniffed.height } : {}),
        backend: backend.kind,
        account: chosen.account.label,
        model: chosen.model,
        prompt: input.prompt,
        forAgent:
          `The image is in the Files library as ${saved.filename ?? filename} (id ${saved.id}) and on the canvas. ` +
          'You have not seen it. In one or two sentences starting "I asked for…", tell the owner what you asked for ' +
          '(never "I generated", never a description of the picture), then give the file name and the id.',
      };
    },
  };
}

export const generateTool = createGenerateTool();
