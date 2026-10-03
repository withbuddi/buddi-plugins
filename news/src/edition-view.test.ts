import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEdition, storyActions } from './edition-view.js';

const MARKDOWN = `Morning edition · Sat 3 Oct
Seven stories. West African leaders meet in Lomé today; Congress kept the government open overnight.

### Togo & West Africa

**ECOWAS leaders open a two-day summit in Lomé**

Leaders from the fifteen member states open a two-day summit in Lomé today, with trade corridors and the regional currency on the agenda.

*RFI Afrique (fr) and 3 more* · [rfi.fr](https://www.rfi.fr/fr/afrique/cedeao)

**UPDATE · Ghana and Côte d'Ivoire raise the cocoa farm-gate price**

The higher farm-gate price you heard about last night takes effect on Monday.

*Reuters and 1 more* · [reuters.com](https://www.reuters.com/markets/cocoa)

### AI

**OPINION · We are measuring AI with the wrong rulers**

An Economist column argues benchmarks reward tests models have already seen.

*The Economist* · [economist.com](https://www.economist.com/column)

Voice was off today: the Speech plugin is not installed

— Anchor · next at 12:30`;

describe('reading an edition back from its text', () => {
  it('reads the Markdown shape Anchor writes: topics, headlines, leads, marks, sources and the next time', () => {
    const e = parseEdition(MARKDOWN);
    expect(e).toMatchObject({ name: 'Morning edition', date: 'Sat 3 Oct', next: '12:30', notes: ['Voice was off today: the Speech plugin is not installed'] });
    expect(e.lede).toBe('Seven stories. West African leaders meet in Lomé today; Congress kept the government open overnight.');
    expect(e.groups.map((g) => [g.topic, g.stories.length])).toEqual([['Togo & West Africa', 2], ['AI', 1]]);
    expect(e.groups[0]!.stories[0]).toEqual({
      title: 'ECOWAS leaders open a two-day summit in Lomé',
      lead: 'Leaders from the fifteen member states open a two-day summit in Lomé today, with trade corridors and the regional currency on the agenda.',
      outlet: 'RFI Afrique (fr)', more: 3, link: { url: 'https://www.rfi.fr/fr/afrique/cedeao', label: 'rfi.fr' },
    });
    expect(e.groups[0]!.stories[1]).toMatchObject({ mark: 'update', markLabel: 'UPDATE', title: 'Ghana and Côte d\'Ivoire raise the cocoa farm-gate price', outlet: 'Reuters', more: 1 });
    expect(e.groups[1]!.stories[0]).toMatchObject({ mark: 'opinion', title: 'We are measuring AI with the wrong rulers', outlet: 'The Economist', more: 0 });
  });

  it('reads the plain shape of the first editions: topics in capitals, raw links', () => {
    const e = parseEdition(readFileSync(new URL('./fixtures/edition-plain.txt', import.meta.url), 'utf8'));
    expect(e.name).toBe('Morning edition');
    expect(e.lede).toMatch(/^Six stories\. Brazil votes tomorrow/);
    expect(e.groups.map((g) => [g.topic, g.stories.length])).toEqual([['TOGO & WEST AFRICA', 2], ['INTERNATIONAL', 4]]);
    const brazil = e.groups[1]!.stories[0]!;
    expect(brazil).toMatchObject({ mark: 'update', title: 'Brazil heads into Sunday\'s election', outlet: 'Le Figaro (fr)', more: 4 });
    expect(brazil.link!.label).toBe('lefigaro.fr');
    expect(e.groups[0]!.stories[1]).toMatchObject({ outlet: 'leadership.ng', more: 4 });
    expect(e.next).toBe('12:30');
  });

  it('gives no groups for a text it does not recognise, and never throws', () => {
    expect(parseEdition('Just a sentence.').groups).toEqual([]);
    expect(parseEdition('').groups).toEqual([]);
  });
});

describe('a told story\'s ways out', () => {
  it('are page actions with the ids written in, grouped as the News page groups them', () => {
    const actions = storyActions(
      { storyId: 's1', topicId: 'economy', topicName: 'Economy', mutable: [{ id: 'rfi.fr', name: 'RFI' }] },
      { now: new Date('2026-10-03T08:00:00Z'), zone: 'Europe/Paris' },
    );
    expect(actions.map((a) => a.label)).toEqual(['Not interested', 'Mute RFI', 'Quiet Economy for a week', 'Mute Economy']);
    expect(actions[1]).toMatchObject({
      tool: 'news.mute_outlet', group: 'Mute an outlet', args: { outlet: { const: 'rfi.fr' }, muted: { const: true } },
      done: 'Muted RFI. Its stories are hidden.', undo: { tool: 'news.mute_outlet', label: 'Undo', args: { outlet: { const: 'rfi.fr' }, muted: { const: false } } },
    });
    expect(actions[2]).toMatchObject({ hint: 'Back on its own next Saturday', args: { topic: { const: 'economy' }, mutedForHours: { const: 168 } }, done: 'Economy is quiet for a week.' });
    expect(storyActions({ storyId: 's2' }, { now: new Date(), zone: 'UTC' }).map((a) => a.tool)).toEqual(['news.hide_story']);
  });
});
