import { describe, expect, it } from 'vitest';
import { canonicalUrl, outletHost, urlHash } from './canonical.js';

describe('canonicalUrl', () => {
  it('drops tracking parameters and keeps the ones that say what the page is', () => {
    expect(canonicalUrl('https://www.bbc.co.uk/news/articles/c5j9x99yep92o?at_medium=RSS&at_campaign=rss')).toBe('https://www.bbc.co.uk/news/articles/c5j9x99yep92o');
    expect(canonicalUrl('https://example.com/story?id=42&utm_source=x&utm_medium=y&fbclid=abc&xtor=RSS-1')).toBe('https://example.com/story?id=42');
    expect(canonicalUrl('https://example.com/a?b=2&a=1')).toBe('https://example.com/a?a=1&b=2');
  });

  it('brings an AMP copy back to the page it copies', () => {
    expect(canonicalUrl('https://www.example.com/news/story/amp/')).toBe('https://www.example.com/news/story');
    expect(canonicalUrl('https://www.example.com/amp/news/story')).toBe('https://www.example.com/news/story');
    expect(canonicalUrl('https://www.example.com/news/story.amp.html')).toBe('https://www.example.com/news/story.html');
    expect(canonicalUrl('https://amp.example.com/news/story?amp=1')).toBe('https://example.com/news/story');
    expect(canonicalUrl('https://www-example-com.cdn.ampproject.org/c/s/www.example.com/news/story')).toBe('https://www.example.com/news/story');
    expect(canonicalUrl('https://www.example.com/news/story?outputType=amp')).toBe('https://www.example.com/news/story');
  });

  it('lower-cases the host, drops the fragment, the port, a trailing slash and a double slash', () => {
    expect(canonicalUrl('HTTPS://WWW.Example.COM:443//world//story/#comments')).toBe('https://www.example.com/world/story');
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('leaves what is not a web address alone', () => {
    expect(canonicalUrl('  tag:blog.example.fr,2026:1 ')).toBe('tag:blog.example.fr,2026:1');
    expect(canonicalUrl('not a url')).toBe('not a url');
  });

  it('hashes http and https alike', () => {
    expect(urlHash('http://example.com/a')).toBe(urlHash('https://example.com/a'));
    expect(urlHash('https://example.com/a')).not.toBe(urlHash('https://example.com/b'));
  });

  it('names an outlet by its host without www', () => {
    expect(outletHost('https://www.lemonde.fr/afrique/')).toBe('lemonde.fr');
    expect(outletHost('https://fr.africanews.com/feed')).toBe('fr.africanews.com');
    expect(outletHost('nonsense')).toBe('');
  });
});
