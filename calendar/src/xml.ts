/**
 * Just enough XML for WebDAV: a multistatus answer parsed into elements that
 * know their namespace, and text with its entities decoded. No DTDs, no
 * external entities, nothing fetched — a server's answer is data. Elements
 * are matched by namespace and local name, never by prefix, since every
 * server picks its own prefixes (`d:`, `D:`, none at all).
 */

export interface XmlElement {
  ns: string;
  name: string;
  children: XmlElement[];
  /** Attributes by their local name (a namespaced attribute keeps no prefix), `xmlns` ones left out. */
  attrs: Record<string, string>;
  /** The text directly inside, entities decoded, CDATA kept as written. */
  text: string;
}

export const DAV = 'DAV:';
export const CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const APPLE = 'http://apple.com/ns/ical/';
export const CS = 'http://calendarserver.org/ns/';

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The most elements one answer may hold: a calendar of a few thousand events, and room. */
const MAX_ELEMENTS = 200_000;

/** Parse a document; throws a short sentence on what is not XML. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { ns: '', name: '#document', children: [], attrs: {}, text: '' };
  const stack: Array<{ el: XmlElement; scope: Record<string, string> }> = [{ el: root, scope: { xml: 'http://www.w3.org/XML/1998/namespace' } }];
  let i = 0;
  let count = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt === -1) {
      top.el.text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) top.el.text += decodeEntities(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('the answer is not XML (an unclosed comment)');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('the answer is not XML (an unclosed CDATA section)');
      top.el.text += source.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('the answer is not XML');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      // A doctype: skipped, never read. Its internal subset is not supported.
      const end = source.indexOf('>', lt + 2);
      if (end === -1 || source.slice(lt, end).includes('[')) throw new Error('the answer carries a doctype buddi does not read');
      i = end + 1;
      continue;
    }
    const gt = findTagEnd(source, lt + 1);
    if (gt === -1) throw new Error('the answer is not XML (an unclosed tag)');
    const raw = source.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      if (stack.length <= 1) throw new Error('the answer is not XML (a stray closing tag)');
      stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error('the answer is not XML (a tag without a name)');
    const qname = nameMatch[1]!;
    const scope = { ...top.scope };
    const attrText = body.slice(qname.length);
    const attrs: Record<string, string> = {};
    for (const m of attrText.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const attr = m[1]!;
      const value = decodeEntities(m[3] ?? m[4] ?? '');
      if (attr === 'xmlns') scope[''] = value;
      else if (attr.startsWith('xmlns:')) scope[attr.slice(6)] = value;
      else attrs[attr.includes(':') ? attr.slice(attr.indexOf(':') + 1) : attr] = value;
    }
    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    const el: XmlElement = { ns: scope[prefix] ?? '', name: local, children: [], attrs, text: '' };
    if (++count > MAX_ELEMENTS) throw new Error('the answer is too large to read');
    top.el.children.push(el);
    if (!selfClosing) stack.push({ el, scope });
  }
  const doc = root.children[0];
  if (!doc) throw new Error('the answer is not XML (no element)');
  return doc;
}

/** Where a tag ends: the first `>` outside a quoted attribute value. */
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < source.length; j++) {
    const c = source[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

/** The direct children with this namespace and name. */
export function childrenOf(el: XmlElement | undefined, ns: string, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.ns === ns && c.name === name) : [];
}

/** The first direct child with this namespace and name. */
export function childOf(el: XmlElement | undefined, ns: string, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.ns === ns && c.name === name);
}

/** The first element at this path of (namespace, name) steps. */
export function pathOf(el: XmlElement | undefined, ...steps: Array<[string, string]>): XmlElement | undefined {
  let at = el;
  for (const [ns, name] of steps) at = childOf(at, ns, name);
  return at;
}
