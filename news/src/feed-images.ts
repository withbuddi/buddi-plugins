import { ATOM, CONTENT, MEDIA, childOf, deepText, type XmlElement } from './xml.js';
import { absolute, plainText } from './feed.js';
export interface FeedImage { url: string; caption?: string; credit?: string }
const text = (el?: XmlElement): string => el ? plainText(deepText(el)).slice(0, 500) : '';
function imageUrl(raw: string | undefined, base: string): string | undefined {
  const url = absolute(raw, base);
  if (!url) return;
  const parsed = new URL(url);
  if (parsed.username || parsed.password) return;
  return url;
}
/** Read publisher-supplied media only; never the feed's channel logo. */
export function feedImage(item: XmlElement, base: string): FeedImage | undefined {
  const candidates: FeedImage[] = [];
  const visit = (parent: XmlElement, inherited: { caption?: string; credit?: string } = {}): void => {
    const caption = text(childOf(parent, MEDIA, 'description')) || inherited.caption;
    const credit = text(childOf(parent, MEDIA, 'credit')) || text(childOf(parent, MEDIA, 'copyright')) || inherited.credit;
    for (const el of parent.children) {
      const localBase = absolute(el.attrs.base, base) ?? base;
      if (el.ns === MEDIA && el.name === 'group') visit(el, { ...(caption ? { caption } : {}), ...(credit ? { credit } : {}) });
      const media = el.ns === MEDIA && (el.name === 'thumbnail' || el.name === 'content' && (el.attrs.medium === 'image' || el.attrs.type?.startsWith('image/') || /\.(jpe?g|png|gif)(?:[?#]|$)/i.test(el.attrs.url ?? '')));
      const enclosure = (el.name === 'enclosure' || el.ns === ATOM && el.name === 'link' && el.attrs.rel === 'enclosure') && el.attrs.type?.startsWith('image/');
      if (!media && !enclosure) continue;
      if (['width', 'height'].some(key => el.attrs[key] && Number(el.attrs[key]) < 64)) continue;
      const url = imageUrl(el.attrs.url ?? el.attrs.href, localBase);
      if (!url) continue;
      const ownCaption = text(childOf(el, MEDIA, 'description')) || caption;
      const ownCredit = text(childOf(el, MEDIA, 'credit')) || credit;
      candidates.push({ url, ...(ownCaption ? { caption: ownCaption } : {}), ...(ownCredit ? { credit: ownCredit } : {}) });
    }
  };
  visit(item);
  if (candidates.length) return candidates[0];
  const html = [childOf(item, CONTENT, 'encoded'), childOf(item, '', 'description'), childOf(item, ATOM, 'content'), childOf(item, ATOM, 'summary')].map(el => el ? deepText(el) : '').join('\n');
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    if (['width', 'height'].some(key => attrs[key] && Number(attrs[key]) < 64)) continue;
    const url = imageUrl(attrs.src?.replace(/&amp;/g, '&'), base);
    if (url) return { url, ...(attrs.alt ? { caption: plainText(attrs.alt).slice(0, 500) } : {}) };
  }
  return undefined;
}
