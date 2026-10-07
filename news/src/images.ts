import type { BuddiHost } from '@buddi/core/plugin';
import { politeGet } from './fetch.js';

/** Bounded local cache; publisher addresses never reach the browser. */
export async function cacheStoryImages(buddi: BuddiHost): Promise<void> {
  if (!buddi.assets || !buddi.http) return;
  const { rows } = await buddi.db.query<{ id: string; image_url: string }>(
    `select a.id, a.image_url from news.articles a join news.sources src on src.id = a.source_id
     left join news.outlets o on o.id = a.outlet_id
     where a.image_url is not null and a.image_checked_at is null and not src.muted and not coalesce(o.muted, false)
     and a.published_at > $1
     order by exists(select 1 from news.stories s where s.title_article_id = a.id) desc, a.published_at desc limit 2`,
    [new Date(buddi.clock.now().getTime() - 48 * 3600_000)],
  );
  for (const row of rows) {
    await buddi.db.query(`update news.articles set image_checked_at = $2 where id = $1`, [row.id, buddi.clock.now()]);
    try {
      const host = new URL(row.image_url).hostname;
      buddi.network.declare([{ host, why: 'A story image supplied by a news feed, cached for display in News.' }]);
      const { response } = await politeGet(buddi.http, row.image_url, { maxBytes: 256 * 1024, allowHost: h => h === host });
      if (response.status !== 200) continue;
      const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(mime)) continue;
      const kept = (await buddi.assets.list()).filter(a => a.key.startsWith('story-')).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      while (kept.length >= 40 || kept.reduce((sum, asset) => sum + asset.bytes, 0) > 12 * 1024 * 1024) {
        const old = kept.shift()!;
        await buddi.assets.delete(old.key);
        await buddi.db.query(`update news.articles set image_key = null where image_key = $1`, [old.key]);
      }
      const key = `story-${row.id}`;
      await buddi.assets.put(key, Buffer.from(await response.arrayBuffer()), mime);
      await buddi.db.query(`update news.articles set image_key = $2 where id = $1`, [row.id, key]);
    } catch { /* Unavailable images leave the story text-only. */ }
  }
}
