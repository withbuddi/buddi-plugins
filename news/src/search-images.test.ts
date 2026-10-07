import { expect, it, vi } from 'vitest';
import { search } from './reads.js';
it('carries a matching story image into search without extra per-article queries', async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'a_1', story_id: 's_1', title: 'Debate', published_at: new Date('2026-10-06'), outlet: 'A' }, { id: 'a_2', story_id: 's_1', title: 'Debate again', published_at: new Date('2026-10-06'), outlet: 'B' }] }).mockResolvedValueOnce({ rows: [{ id: 'a_1', story_id: 's_1', image_key: 'story-a_1', image_credit: 'Photographer', outlet: 'A', url: 'https://example.test/story' }] });
  const hits = await search({ query } as any, new Date('2026-10-07'), { text: 'Debate', days: 2, n: 10 });
  expect(query).toHaveBeenCalledTimes(2);
  expect(hits[0]?.image).toEqual({ key: 'story-a_1', credit: 'Photographer', outlet: 'A', url: 'https://example.test/story' });
  expect(hits[1]?.image).toEqual(hits[0]?.image);
});
