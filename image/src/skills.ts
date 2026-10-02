/**
 * The skill this plugin ships, for any agent granted `image.generate`.
 *
 * The plugin proposes no agent: the Illustrator is a catalogue agent
 * (withbuddi.com), and an owner who accepted it from an earlier version keeps
 * it (`@art`), file, roles and data untouched.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuggestedSkill } from '@buddi/core/plugin';

export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export const imageSkills: SuggestedSkill[] = [
  {
    name: 'writing-an-image-prompt',
    description:
      'How one request becomes one image prompt: subject, style, composition, palette, what to avoid; ' +
      'references; no text unless asked; no brands or real people. Read it before calling image.generate.',
    body: readFileSync(path.join(SKILLS_DIR, 'writing-an-image-prompt.md'), 'utf8'),
  },
];
