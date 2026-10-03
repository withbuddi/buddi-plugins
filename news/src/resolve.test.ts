/**
 * A Google News item's own link: the id read, an old-style id decoded with
 * no request, the page's signature handed to Google's decoder, and a failure
 * that keeps the redirect.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpArea } from '@buddi/core/plugin';
import { decodeOffline, decoderBody, googleNewsId, outletLink, parseDecoder, resolveGoogleNews, signatureOf } from './resolve.js';
import { resetPoliteness } from './fetch.js';

const ID = 'CBMiWkFVX3lxTE1hc09qa01yTFV1WkxHVWVNSVpCNTZkbkFOMkc5dTZSOE9vclo5YVpVZlgyR0lMeVpScWFXOWpPYkZjS0U2NVZkNXUzaURLQnpGRDNtZXY5WHZ4Zw';
const LINK = `https://news.google.com/rss/articles/${ID}?oc=5`;
const PAGE = `<html><body><c-wiz><div jscontroller="aLI87" data-n-a-id="${ID}" data-n-a-ts="1791013716" data-n-a-sg="AbIaSL-IgUfEpfEdO9nlmw1FCWK4"></div></c-wiz></body></html>`;
const ANSWER = `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://apnews.com/article/flydubai-pilot-attack-123?utm_source=x\\",1]",null,null,null,"generic"],["di",23]]`;
const noSleep = async (): Promise<void> => {};

interface Seen { url: string; method: string; body?: string; maxBytes?: number }
function fakeHttp(answers: Record<string, { status: number; body?: string; headers?: Record<string, string> }>, seen: Seen[]): HttpArea {
  return {
    async request(req) {
      seen.push({ url: req.url, method: req.method ?? 'GET', ...(typeof req.body === 'string' ? { body: req.body } : {}), ...(req.maxBytes ? { maxBytes: req.maxBytes } : {}) });
      const a = answers[`${req.method ?? 'GET'} ${req.url}`] ?? { status: 404 };
      const headers = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return {
        ok: a.status >= 200 && a.status < 300, status: a.status, statusText: '', headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
        text: async () => a.body ?? '', json: async () => JSON.parse(a.body ?? 'null'), arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
  };
}

beforeEach(() => resetPoliteness());

describe('Google News links', () => {
  it('reads the id of an article link and nothing else', () => {
    expect(googleNewsId(LINK)).toBe(ID);
    expect(googleNewsId(`https://news.google.com/articles/${ID}`)).toBe(ID);
    expect(googleNewsId('https://news.google.com/rss/search?q=x')).toBeNull();
    expect(googleNewsId('https://www.lemonde.fr/rss/articles/x')).toBeNull();
  });

  it('decodes an old-style id that holds the address, and leaves a new-style one to the decoder', () => {
    const old = Buffer.concat([Buffer.from([0x08, 0x13, 0x22, 0x20]), Buffer.from('https://www.lemonde.fr/a/b.html'), Buffer.from([0xd2, 0x01, 0x00])]).toString('base64url');
    expect(decodeOffline(old)).toBe('https://www.lemonde.fr/a/b.html');
    expect(decodeOffline(ID)).toBeNull();
  });

  it('keeps only an outlet\'s web address, canonical', () => {
    expect(outletLink('https://www.bbc.co.uk/news/x?utm_source=rss')).toBe('https://www.bbc.co.uk/news/x');
    expect(outletLink('https://news.google.com/foo')).toBeNull();
    expect(outletLink('https://consent.google.co.uk/x')).toBeNull();
    expect(outletLink('javascript:alert(1)')).toBeNull();
  });

  it('reads the signature and the decoder\'s answer', () => {
    expect(signatureOf(PAGE)).toEqual({ ts: '1791013716', sg: 'AbIaSL-IgUfEpfEdO9nlmw1FCWK4' });
    expect(signatureOf('<html></html>')).toBeNull();
    const body = decodeURIComponent(decoderBody(ID, { ts: '1791013716', sg: 'sig' }).slice('f.req='.length));
    expect(body).toContain('garturlreq');
    expect(body).toContain(ID);
    expect(parseDecoder(ANSWER)).toBe('https://apnews.com/article/flydubai-pilot-attack-123');
    expect(parseDecoder(')]}\'\n[["er",null]]')).toBeNull();
  });

  it('resolves a link with one capped GET of the page and one POST to the decoder', async () => {
    const seen: Seen[] = [];
    const http = fakeHttp({
      [`GET ${LINK}`]: { status: 302, headers: { location: `${LINK}&hl=en-US` } },
      [`GET ${LINK}&hl=en-US`]: { status: 200, body: PAGE },
      'POST https://news.google.com/_/DotsSplashUi/data/batchexecute': { status: 200, body: ANSWER },
    }, seen);
    expect(await resolveGoogleNews(http, LINK, { sleep: noSleep })).toBe('https://apnews.com/article/flydubai-pilot-attack-123');
    expect(seen.map((s) => s.method)).toEqual(['GET', 'GET', 'POST']);
    expect(seen[0]!.maxBytes).toBe(1024 * 1024);
    expect(seen[2]!.body).toMatch(/^f\.req=/);
  });

  it('takes a redirect that leads off Google as the answer, and answers null when the page has no signature', async () => {
    const off = fakeHttp({
      [`GET ${LINK}`]: { status: 302, headers: { location: 'https://www.reuters.com/world/x/?utm_medium=rss' } },
    }, []);
    expect(await resolveGoogleNews(off, LINK, { sleep: noSleep })).toBe('https://www.reuters.com/world/x');
    expect(await resolveGoogleNews(fakeHttp({ [`GET ${LINK}`]: { status: 200, body: '<html></html>' } }, []), LINK, { sleep: noSleep })).toBeNull();
    expect(await resolveGoogleNews(fakeHttp({}, []), 'https://www.lemonde.fr/x', { sleep: noSleep })).toBeNull();
  });
});
