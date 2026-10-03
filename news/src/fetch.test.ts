import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpArea, HttpResponse } from '@buddi/core/plugin';
import { fetchLogo, fetchSource, FetchError, HOST_GAP_MS, hostDeclared, iconLinks, politeGet, politeWait, readGdelt, resetPoliteness, retryAfterMs, siteOf, sniffImage } from './fetch.js';
import { MAX_BACKOFF_MS, nextFetchAt, stateAfterFailure } from './store.js';

type Handler = (url: string, headers: Record<string, string>) => { status: number; body?: string | Buffer; headers?: Record<string, string> };

function fakeHttp(handler: Handler): HttpArea & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    calls,
    async request(req) {
      const headers = req.headers ?? {};
      calls.push({ url: req.url, headers });
      const answer = handler(req.url, headers);
      const body = answer.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.body, 'utf8');
      const lower = Object.fromEntries(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const response: HttpResponse = {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        statusText: '',
        headers: { get: (name) => lower[name.toLowerCase()] ?? null },
        text: async () => body.toString('utf8'),
        json: async () => JSON.parse(body.toString('utf8')),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      };
      return response;
    },
  };
}

const RSS = readFileSync(new URL('./fixtures/rss2.xml', import.meta.url), 'utf8');
const noSleep = async (): Promise<void> => {};
const source = { url: 'https://www.example-news.com/feed.xml', kind: 'rss' as const, name: 'Example News', language: 'en' as const };

beforeEach(() => resetPoliteness());

describe('fetchSource', () => {
  it('reads a feed and keeps the validators; a publisher feed leaves the outlet to its source', async () => {
    const http = fakeHttp(() => ({ status: 200, body: RSS, headers: { etag: '"v1"', 'last-modified': 'Fri, 02 Oct 2026 16:00:00 GMT', 'content-type': 'application/rss+xml' } }));
    const result = await fetchSource(http, source, { sleep: noSleep });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({ outletName: '', outletHost: '', language: 'en' });
    expect(result.etag).toBe('"v1"');
    expect(result.lastModified).toBe('Fri, 02 Oct 2026 16:00:00 GMT');
    expect(http.calls[0]!.headers['user-agent']).toMatch(/^buddi-news\//);
  });

  it('asks conditionally, and a 304 is not modified', async () => {
    const http = fakeHttp((_url, headers) => (headers['if-none-match'] === '"v1"' ? { status: 304 } : { status: 200, body: RSS }));
    const result = await fetchSource(http, { ...source, etag: '"v1"', lastModified: 'Fri, 02 Oct 2026 16:00:00 GMT' }, { sleep: noSleep });
    expect(result).toEqual({ status: 'not-modified' });
    expect(http.calls[0]!.headers['if-modified-since']).toBe('Fri, 02 Oct 2026 16:00:00 GMT');
  });

  it('follows a redirect by hand, three at most', async () => {
    const http = fakeHttp((url) => (url.endsWith('/old') ? { status: 301, headers: { location: '/feed.xml' } } : { status: 200, body: RSS }));
    const result = await fetchSource(http, { ...source, url: 'https://www.example-news.com/old' }, { sleep: noSleep });
    expect(result.status).toBe('ok');
    expect(http.calls.map((c) => c.url)).toEqual(['https://www.example-news.com/old', 'https://www.example-news.com/feed.xml']);
    expect(result.finalUrl).toBe('https://www.example-news.com/feed.xml');

    const loop = fakeHttp(() => ({ status: 302, headers: { location: '/again' } }));
    await expect(fetchSource(loop, source, { sleep: noSleep })).rejects.toThrow('redirected more than 3 times');
  });

  it('refuses a redirect to a host not declared, and allows one within the same site', async () => {
    const away = fakeHttp((url) => (url.includes('example-news') ? { status: 302, headers: { location: 'https://elsewhere.example.org/feed' } } : { status: 200, body: RSS }));
    await expect(fetchSource(away, source, { sleep: noSleep, allowHost: () => false })).rejects.toThrow('redirected to elsewhere.example.org, which this plugin has not declared');
    const www = fakeHttp((url) => (url.startsWith('https://example-news.com') ? { status: 301, headers: { location: 'https://www.example-news.com/feed.xml' } } : { status: 200, body: RSS }));
    const result = await fetchSource(www, { ...source, url: 'https://example-news.com/feed.xml' }, { sleep: noSleep, allowHost: () => false });
    expect(result.status).toBe('ok');
  });

  it('keeps what a 429 asks for in Retry-After', async () => {
    const busy = fakeHttp(() => ({ status: 429, headers: { 'retry-after': '120' } }));
    const err = await fetchSource(busy, source, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).retryAfterMs).toBe(120_000);
    expect(retryAfterMs('Sat, 03 Oct 2026 12:02:00 GMT', Date.parse('2026-10-03T12:00:00Z'))).toBe(120_000);
    expect(retryAfterMs(null)).toBeUndefined();
  });

  it('never has two requests in flight to one host', async () => {
    let inFlight = 0;
    let most = 0;
    const slow: Parameters<typeof politeGet>[0] = {
      async request() {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { ok: true, status: 200, statusText: '', headers: { get: () => null }, text: async () => '', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      },
    };
    await Promise.all([1, 2, 3].map((i) => politeGet(slow, `https://one.example.com/${i}`, { sleep: noSleep })));
    expect(most).toBe(1);
  });

  it('fails in a sentence on an error status or something that is not a feed', async () => {
    await expect(fetchSource(fakeHttp(() => ({ status: 503 })), source, { sleep: noSleep })).rejects.toThrow(new FetchError('answered 503'));
    await expect(fetchSource(fakeHttp(() => ({ status: 200, body: '<html><body>Paywall</body></html>' })), source, { sleep: noSleep }))
      .rejects.toThrow('this is not a feed (its root is <html>)');
  });

  it('names the outlet Google News gives for each item', async () => {
    const gnews = readFileSync(new URL('./fixtures/gnews.xml', import.meta.url), 'utf8');
    const result = await fetchSource(fakeHttp(() => ({ status: 200, body: gnews })), { url: 'https://news.google.com/rss/search?q=Togo', kind: 'gnews', name: 'Google News', language: 'fr' }, { sleep: noSleep });
    expect(result.status === 'ok' && result.items[0]).toMatchObject({ outletName: 'RFI', outletHost: 'rfi.fr', language: 'fr' });
  });

  it('reads Hacker News\'s front page through Algolia: 100 points or more, the discussion when there is no link', async () => {
    const body = JSON.stringify({ hits: [
      { objectID: '1', title: 'Show HN: A thing', url: 'https://thing.example.com/', points: 340, created_at_i: 1_790_000_000 },
      { objectID: '2', title: 'Too quiet', url: 'https://quiet.example.com/', points: 40, created_at_i: 1_790_000_000 },
      { objectID: '3', title: 'Ask HN: Something?', url: null, story_text: '<p>Question</p>', points: 150, created_at_i: 1_790_000_100 },
    ] });
    const result = await fetchSource(fakeHttp(() => ({ status: 200, body })), { url: 'https://hn.algolia.com/api/v1/search?tags=front_page', kind: 'hn', name: 'Hacker News', language: 'en' }, { sleep: noSleep });
    expect(result.status === 'ok' && result.items.map((i) => [i.title, i.url, i.outletHost, i.summary])).toEqual([
      ['Show HN: A thing', 'https://thing.example.com/', 'thing.example.com', ''],
      ['Ask HN: Something?', 'https://news.ycombinator.com/item?id=3', 'news.ycombinator.com', 'Question'],
    ]);
  });

  it('reads a GDELT article list, keeping English and French, and says what GDELT said when it refuses', () => {
    const body = JSON.stringify({ articles: [
      { url: 'https://a.example.com/x', title: 'Summit opens', seendate: '20261003T051500Z', domain: 'a.example.com', language: 'English' },
      { url: 'https://b.example.fr/y', title: 'Le sommet s’ouvre', seendate: '20261003T060000Z', domain: 'b.example.fr', language: 'French' },
      { url: 'https://c.example.de/z', title: 'Gipfel', seendate: '20261003T060000Z', domain: 'c.example.de', language: 'German' },
    ] });
    const items = readGdelt(Buffer.from(body));
    expect(items.map((i) => [i.language, i.outletHost, i.publishedAt?.toISOString()])).toEqual([
      ['en', 'a.example.com', '2026-10-03T05:15:00.000Z'],
      ['fr', 'b.example.fr', '2026-10-03T06:00:00.000Z'],
    ]);
    expect(() => readGdelt(Buffer.from('Please limit requests to one every 5 seconds'))).toThrow(/^GDELT said: Please limit/);
  });
});

describe('politeness', () => {
  it('waits between two requests to one host, not between two hosts', async () => {
    let t = 1_000_000;
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => { waits.push(ms); };
    await politeWait('a.example.com', () => t, sleep);
    await politeWait('b.example.com', () => t, sleep);
    await politeWait('a.example.com', () => t, sleep);
    expect(waits).toEqual([HOST_GAP_MS]);
    t += 10 * HOST_GAP_MS;
    await politeWait('a.example.com', () => t, sleep);
    expect(waits).toEqual([HOST_GAP_MS]);
    await politeWait('api.gdeltproject.org', () => t, sleep);
    await politeWait('api.gdeltproject.org', () => t, sleep);
    expect(waits[1]).toBeGreaterThanOrEqual(6_000);
  });

  it('knows a site and a declared host', () => {
    expect(siteOf('feeds.bbci.co.uk')).toBe('bbci.co.uk');
    expect(siteOf('www.lemonde.fr')).toBe('lemonde.fr');
    expect(hostDeclared('www.lemonde.fr', ['lemonde.fr', '*.lemonde.fr'])).toBe(true);
    expect(hostDeclared('lemonde.fr.evil.example', ['lemonde.fr', '*.lemonde.fr'])).toBe(false);
  });
});

describe('health and backoff', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  it('fetches each source on its period with up to a tenth more as jitter', () => {
    expect(nextFetchAt(now, 900, 0, () => 0).getTime() - now.getTime()).toBe(900_000);
    expect(nextFetchAt(now, 900, 0, () => 0.999).getTime() - now.getTime()).toBeLessThan(990_000);
  });

  it('doubles the wait for each failure in a row, at most six hours', () => {
    const waits = [1, 2, 3, 10, 50].map((f) => nextFetchAt(now, 900, f, () => 0).getTime() - now.getTime());
    expect(waits).toEqual([1_800_000, 3_600_000, 7_200_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  });

  it('is failing after a day and paused after a week', () => {
    const ago = (h: number): Date => new Date(now.getTime() - h * 3600_000);
    expect(stateAfterFailure(ago(2), now)).toBe('ok');
    expect(stateAfterFailure(ago(24), now)).toBe('failing');
    expect(stateAfterFailure(ago(24 * 7), now)).toBe('paused');
  });
});

describe('logos', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);

  it('prefers an apple-touch-icon, skips SVG, resolves relative links', () => {
    const html = `<head><link rel="icon" href="/favicon-16.png" sizes="16x16"><link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="apple-touch-icon" href="/touch.png"><link rel="shortcut icon" href="https://cdn.example.com/f.ico"></head>`;
    expect(iconLinks(html, 'https://www.example.com/news/')).toEqual([
      'https://www.example.com/touch.png', 'https://www.example.com/favicon-16.png', 'https://cdn.example.com/f.ico',
    ]);
  });

  it('keeps raster images by their bytes, not their content type', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('<html>not found</html>'))).toBeUndefined();
  });

  it('fetches the page icon, falls back to /favicon.ico, and refuses one that is too large', async () => {
    const http = fakeHttp((url) => {
      if (url === 'https://www.example.com/') return { status: 200, body: '<link rel="apple-touch-icon" href="/big.png">' };
      if (url.endsWith('/big.png')) return { status: 200, body: Buffer.concat([PNG, Buffer.alloc(300 * 1024)]) };
      if (url.endsWith('/favicon.ico')) return { status: 200, body: PNG, headers: { 'content-type': 'text/html' } };
      return { status: 404 };
    });
    const logo = await fetchLogo(http, 'https://www.example.com/', { sleep: noSleep });
    expect(logo).toMatchObject({ mime: 'image/png', url: 'https://www.example.com/favicon.ico' });
    expect(await fetchLogo(fakeHttp(() => ({ status: 404 })), 'https://none.example.com/', { sleep: noSleep })).toBeNull();
  });
});
