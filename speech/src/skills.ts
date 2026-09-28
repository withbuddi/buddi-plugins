/**
 * The one skill this plugin proposes: writing a reply that will be heard.
 * A proposal only; accepting it is the owner's (docs/plugins.md §2.6).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuggestedSkill } from '@buddi/core/plugin';

export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export const speechSkills: SuggestedSkill[] = [
  {
    name: 'speaking-for-the-ear',
    description:
      'How to write a reply that will be spoken: short sentences, no tables or markdown, numbers as people ' +
      'say them. Read it before calling speech.say.',
    body: readFileSync(path.join(SKILLS_DIR, 'speaking-for-the-ear.md'), 'utf8'),
  },
];
