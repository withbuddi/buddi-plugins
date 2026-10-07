import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clip, decodeBytes, parseDate, parseFeed, plainText } from './feed.js';

const bytes = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const read = (name: string, url: string, contentType?: string) => parseFeed(decodeBytes(bytes(name), contentType), url);

describe('RSS 2.0', () => {
  const feed = read('rss2.xml', 'https://www.example-news.com/feeds/world.xml');

  it('reads the channel, resolving its link against xml:base', () => {
    expect(feed.format).toBe('rss');
    expect(feed.title).toBe('Example News – World');
    expect(feed.link).toBe('https://www.example-news.com/world');
    expect(feed.language).toBe('en-gb');
  });

  it('keeps items with a title and a link, newest first, and leaves the others out', () => {
    expect(feed.items.map((i) => i.title)).toEqual([
      'It’s the economy: markets rally',
      'Leaders meet in Geneva for ceasefire talks',
      'Opinion: Why the summit will fail',
    ]);
  });

  it('resolves a relative link against xml:base, strips markup, decodes twice-escaped entities', () => {
    const geneva = feed.items.find((i) => i.title.startsWith('Leaders'))!;
    expect(geneva.url).toBe('https://www.example-news.com/world/2026/10/02/geneva-talks?utm_source=rss&utm_medium=feed');
    expect(geneva.summary).toBe('Delegations arrived on Friday & talks began at noon.');
    expect(geneva.publishedAt?.toISOString()).toBe('2026-10-02T12:30:00.000Z');
    expect(geneva.categories).toEqual(['World']);
  });

  it('falls back to a permalink guid, content:encoded and dc:date', () => {
    const markets = feed.items[0]!;
    expect(markets.url).toBe('https://www.example-news.com/business/markets-rally');
    expect(markets.summary).toBe('Stocks rose for a third day.');
    expect(markets.publishedAt?.toISOString()).toBe('2026-10-02T15:00:00.000Z');
  });

  it('keeps at most the items asked for', () => {
    expect(parseFeed(decodeBytes(bytes('rss2.xml')), 'https://www.example-news.com/', 1).items).toHaveLength(1);
  });
});

describe('Atom', () => {
  const feed = read('atom.xml', 'https://blog.example.fr/feed.atom');

  it('reads the alternate link, the language and the entries', () => {
    expect(feed.format).toBe('atom');
    expect(feed.title).toBe('Le Blog Tech');
    expect(feed.link).toBe('https://blog.example.fr/');
    expect(feed.language).toBe('fr');
    expect(feed.items).toHaveLength(2);
  });

  it('resolves relative links against the feed and the entry xml:base', () => {
    expect(feed.items[0]!.url).toBe('https://blog.example.fr/articles/ia-loi');
    expect(feed.items[1]!.url).toBe('https://autre.example.fr/rubrique/processeur');
  });

  it('reads html and xhtml titles and summaries as plain text, published before updated', () => {
    expect(feed.items[0]!.title).toBe("L'IA & la loi");
    expect(feed.items[0]!.summary).toBe('Le Parlement européen a voté.');
    expect(feed.items[0]!.publishedAt?.toISOString()).toBe('2026-10-02T07:00:00.000Z');
    expect(feed.items[0]!.categories).toEqual(['Intelligence artificielle']);
    expect(feed.items[1]!.title).toBe('Un nouveau processeur');
    expect(feed.items[1]!.summary).toBe('Plus rapide et moins cher.');
  });
});

describe('RSS 1.0 (RDF)', () => {
  it('reads items in the RSS 1.0 namespace, the about address standing in for a missing link', () => {
    const feed = read('rdf.xml', 'https://old.example.org/index.rdf');
    expect(feed.format).toBe('rdf');
    expect(feed.title).toBe('Old Example');
    expect(feed.language).toBe('en');
    expect(feed.items.map((i) => [i.title, i.url])).toEqual([
      ['An RSS 1.0 story', 'https://old.example.org/story/1'],
      ['Another', 'https://old.example.org/story/2'],
    ]);
  });
});

describe('Google News', () => {
  it('names the outlet each item comes from', () => {
    const [item] = read('gnews.xml', 'https://news.google.com/rss/search?q=Togo').items;
    expect(item!.title).toBe('Togo : les municipales se tiennent sous tension - RFI');
    expect(item!.outlet).toEqual({ name: 'RFI', url: 'https://www.rfi.fr/' });
    expect(item!.url).toBe('https://news.google.com/rss/articles/CBMiAAA?oc=5');
  });
});

describe('encodings', () => {
  it('decodes ISO-8859-1 by the XML declaration, and a French date', () => {
    const [item] = read('latin1.xml', 'https://journal.example.fr/rss').items;
    expect(item!.title).toBe("François et l'économie : déjà l'été");
    expect(item!.publishedAt?.toISOString()).toBe('2026-10-03T05:24:53.000Z');
  });

  it('decodes by the charset the answer names before the declaration', () => {
    const text = decodeBytes(bytes('latin1.xml'), 'application/rss+xml; charset=ISO-8859-1');
    expect(text).toContain('François');
  });

  it('falls back to windows-1252 when UTF-8 does not fit and nothing is named', () => {
    const [item] = read('cp1252.xml', 'https://undeclared.example.com/feed').items;
    expect(item!.title).toBe('Café “crème”');
  });

  it('drops a UTF-8 byte order mark', () => {
    const [item] = read('bom.xml', 'https://bom.example.tg/feed').items;
    expect(item!.title).toBe('Lomé après la pluie');
  });
});

describe('what real feeds get wrong', () => {
  it('survives a stray or mismatched closing tag and HTML entities', () => {
    const feed = read('malformed.xml', 'https://sloppy.example.com/feed');
    expect(feed.items.map((i) => i.title)).toEqual(['First', 'Second ’quoted’']);
    expect(feed.items[0]!.summary).toBe('An unclosed bold');
  });

  it('refuses what is not a feed, in a sentence', () => {
    expect(() => parseFeed('<html><body>Hi</body></html>', 'https://x.example/')).toThrow('this is not a feed (its root is <html>)');
    expect(() => parseFeed('{"articles": []}', 'https://x.example/')).toThrow(/not XML/);
    expect(() => parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', 'https://x.example/')).toThrow(/doctype/);
  });
});

describe('helpers', () => {
  it('plainText strips scripts, tags and escaped tags', () => {
    expect(plainText('<script>alert(1)</script><p>One&nbsp;&amp; two</p>&lt;br&gt;three')).toBe('One & two three');
  });

  it('clip cuts at a word boundary with an ellipsis', () => {
    expect(clip('one two three four', 12)).toBe('one two…');
    expect(clip('short', 12)).toBe('short');
  });

  it('parseDate reads RFC 822, ISO 8601, and refuses nonsense', () => {
    expect(parseDate('Fri, 02 Oct 2026 12:30:00 GMT')?.toISOString()).toBe('2026-10-02T12:30:00.000Z');
    expect(parseDate('2026-10-02T12:30:00+02:00')?.toISOString()).toBe('2026-10-02T10:30:00.000Z');
    expect(parseDate('ven., 02 oct. 2026 14:30:00 +0200')?.toISOString()).toBe('2026-10-02T12:30:00.000Z');
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
});

describe('article images', () => {
  const rss = (body: string) => parseFeed(`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><image><url>https://site.test/logo.png</url></image><item><title>Story</title><link>https://site.test/story</link>${body}</item></channel></rss>`, 'https://site.test/feed');
  it('keeps Media RSS captions and credits and resolves URLs', () => {
    expect(rss('<media:content url="/photo.jpg" type="image/jpeg"><media:description>A crowd</media:description><media:credit>Jane Doe</media:credit></media:content>').items[0]?.image).toEqual({ url: 'https://site.test/photo.jpg', caption: 'A crowd', credit: 'Jane Doe' });
  });
  it('reads grouped thumbnails and enclosures, excluding channel logos and video', () => {
    expect(rss('<media:group><media:credit>Agency</media:credit><media:thumbnail url="https://img.test/p.jpg" /></media:group>').items[0]?.image?.credit).toBe('Agency');
    expect(rss('<enclosure url="/p.png" type="image/png" />').items[0]?.image?.url).toBe('https://site.test/p.png');
    expect(rss('<media:content url="/movie.mp4" type="video/mp4" />').items[0]?.image).toBeUndefined();
    expect(rss('').items[0]?.image).toBeUndefined();
  });
  it('ignores tracking pixels, unsafe URLs and credentials', () => {
    expect(rss('<description><![CDATA[<img src="/pixel" width="1" height="1"><img src="/photo.jpg" alt="Sunny day">]]></description>').items[0]?.image).toEqual({ url: 'https://site.test/photo.jpg', caption: 'Sunny day' });
    for (const url of ['data:image/png;base64,xx', 'https://user:password@site.test/a.jpg']) expect(rss(`<media:thumbnail url="${url}" />`).items[0]?.image).toBeUndefined();
  });
  it('reads Atom enclosures', () => {
    const feed = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Story</title><link href="https://site.test/story"/><link rel="enclosure" type="image/jpeg" href="/a.jpg" /></entry></feed>', 'https://site.test/feed');
    expect(feed.items[0]?.image?.url).toBe('https://site.test/a.jpg');
  });
});
