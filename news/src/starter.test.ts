import { describe, expect, it } from 'vitest';
import { STARTER_TOPICS, STARTER_SOURCES, starterSources, starterHosts } from './starter.js';

describe('starter kit', () => {
  it('offers US and International only, with fourteen feeds each', () => {
    expect(STARTER_TOPICS.map(t => t.name)).toEqual(['US', 'International']);
    expect(starterSources()).toHaveLength(28);
    for (const t of STARTER_TOPICS) expect(starterSources([t.id])).toHaveLength(14);
    expect(STARTER_SOURCES.every(s => s.topics.every(t => STARTER_TOPICS.some(x => x.id === t.topic)))).toBe(true);
  });
  it('does not request access to hosts used only by removed starter feeds', () => {
    const hosts = starterHosts();
    for (const removed of ['togofirst.com', 'africanews.com', 'icilome.com', 'jeuneafrique.com', 'agenceecofin.com', 'republicoftogo.com', 'hn.algolia.com']) {
      expect(hosts).not.toContain(removed);
      expect(hosts).not.toContain(`*.${removed}`);
    }
  });
});
