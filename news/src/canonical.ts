/**
 * One address per article, whoever linked it: tracking parameters out, the
 * AMP copy back to the page it copies, the host lower-cased, the fragment and
 * a trailing slash dropped, the query sorted. Pure.
 */
import { createHash } from 'node:crypto';

/** Query parameters that say who sent the reader, never what the page is. */
const TRACKING = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'twclid', 'igshid', 'mc_cid', 'mc_eid', 'mkt_tok', 'ocid', 'cmpid',
  'cmp', 'xtor', 'xtref', 'at_medium', 'at_campaign', 'at_custom1', 'at_custom2', 'at_custom3', 'at_custom4', 'ito',
  'ns_mchannel', 'ns_source', 'ns_campaign', 'ns_linkname', 'ns_fee', 'smid', 'smtyp', 'partner', 'ref', 'ref_src',
  'referrer', 'source', 'src', 'share', 'via', 'amp', 'outputtype', 'guccounter', 'guce_referrer', 'guce_referrer_sig',
  'rss', 'feed', 'from', 'origin', 'taid', 'spm', 'sr_share', '__twitter_impression', 'ftag', 'icid', 'int_source',
  'ved', 'usg', 'ei', 'oc',
]);

const TRACKING_PREFIX = /^(utm_|pk_|mtm_|hsa_|vero_|_hs|oly_)/;

/** The canonical form of an article's address, or the input trimmed when it is not an http(s) URL. */
export function canonicalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input.trim();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return input.trim();

  // Google's AMP cache: https://www-example-com.cdn.ampproject.org/c/s/www.example.com/path
  const cache = /\.cdn\.ampproject\.org$/i.test(url.hostname) ? /^\/[a-z](?:\/s)?\/(.+)$/i.exec(url.pathname) : null;
  if (cache) {
    const secure = /^\/[a-z]\/s\//i.test(url.pathname);
    try {
      url = new URL(`${secure ? 'https' : 'http'}://${cache[1]}${url.search}`);
    } catch {
      // Not a cache address after all; keep it.
    }
  }

  url.hash = '';
  url.username = '';
  url.password = '';
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('amp.')) host = host.slice(4);
  url.hostname = host;
  url.port = '';

  let path = url.pathname
    .replace(/\/amp\/?$/i, '/')
    .replace(/\/amp\//i, '/')
    .replace(/\.amp(\.html?)$/i, '$1')
    .replace(/\/+/g, '/');
  if (path.length > 1) path = path.replace(/\/$/, '');
  url.pathname = path;

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => {
      const k = key.toLowerCase();
      return !TRACKING.has(k) && !TRACKING_PREFIX.test(k);
    })
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  return url.toString();
}

/** The host without `www.`, as an outlet is named by: `lemonde.fr`. */
export function outletHost(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\d?\./, '').replace(/^amp\./, '');
  } catch {
    return '';
  }
}

/** A stable key for an article: the SHA-256 of its canonical address, http and https alike. */
export function urlHash(canonical: string): string {
  return createHash('sha256').update(canonical.replace(/^http:/i, 'https:')).digest('hex');
}
