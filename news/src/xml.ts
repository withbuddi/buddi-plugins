/**
 * Just enough XML for a feed: elements that know their namespace, text with
 * its entities decoded (XML's five and the HTML ones feeds carry anyway, like
 * `&nbsp;` and `&rsquo;`), CDATA kept as written. No DTDs, no external
 * entities, nothing fetched: a feed is data. Elements are matched by
 * namespace and local name, never by prefix.
 *
 * Strict about structure (an unclosed tag, a doctype with an internal subset,
 * a document with no element all throw a short sentence) and forgiving about
 * the one thing real feeds get wrong: a closing tag that does not match the
 * open one closes back to the element it names, or is ignored when nothing
 * open has that name.
 */

export interface XmlElement {
  ns: string;
  name: string;
  children: XmlElement[];
  /** Attributes by local name (a namespaced one keeps no prefix), `xmlns` ones left out; `xml:base` kept as `base`. */
  attrs: Record<string, string>;
  /** The text directly inside, entities decoded, CDATA as written. */
  text: string;
  /** The qualified name as written, for matching a closing tag. */
  qname: string;
  /** All the text inside, children included, in document order. */
  deep: string;
}

export const ATOM = 'http://www.w3.org/2005/Atom';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RSS1 = 'http://purl.org/rss/1.0/';
export const DC = 'http://purl.org/dc/elements/1.1/';
export const CONTENT = 'http://purl.org/rss/1.0/modules/content/';
export const MEDIA = 'http://search.yahoo.com/mrss/';

const ENTITIES: Record<string, string> = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
  nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»',
  hellip: '…', mdash: '—', ndash: '–', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à',
  acirc: 'â', aacute: 'á', auml: 'ä', ccedil: 'ç', icirc: 'î', iuml: 'ï', iacute: 'í', ocirc: 'ô', ouml: 'ö', oacute: 'ó',
  ugrave: 'ù', ucirc: 'û', uuml: 'ü', uacute: 'ú', ntilde: 'ñ', oelig: 'œ', aelig: 'æ', Eacute: 'É', Egrave: 'È',
  Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Ocirc: 'Ô', Icirc: 'Î', Ucirc: 'Û', OElig: 'Œ', euro: '€',
  pound: '£', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•', times: '×', shy: '',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The most elements one feed may hold: a few hundred items with their parts, and room. */
const MAX_ELEMENTS = 100_000;

/** Parse a document; throws a short sentence on what is not XML. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { ns: '', name: '#document', qname: '#document', children: [], attrs: {}, text: '', deep: '' };
  const stack: Array<{ el: XmlElement; scope: Record<string, string> }> = [{ el: root, scope: { xml: 'http://www.w3.org/XML/1998/namespace' } }];
  let i = 0;
  let count = 0;
  const n = source.length;
  const addText = (text: string): void => {
    if (!text) return;
    stack[stack.length - 1]!.el.text += text;
    for (const frame of stack) frame.el.deep += text;
  };
  const addBreak = (): void => {
    for (const frame of stack) frame.el.deep += ' ';
  };
  while (i < n) {
    const lt = source.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt === -1) {
      addText(decodeEntities(source.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(source.slice(i, lt)));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('the feed is not XML (an unclosed comment)');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('the feed is not XML (an unclosed CDATA section)');
      addText(source.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('the feed is not XML');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2);
      if (end === -1 || source.slice(lt, end).includes('[')) throw new Error('the feed carries a doctype buddi does not read');
      i = end + 1;
      continue;
    }
    const gt = findTagEnd(source, lt + 1);
    if (gt === -1) throw new Error('the feed is not XML (an unclosed tag)');
    const raw = source.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const closing = raw.slice(1).trim();
      // Close back to the element this names; a closing tag nothing open has is ignored.
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k]!.el.qname === closing) {
          stack.length = k;
          addBreak();
          break;
        }
      }
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error('the feed is not XML (a tag without a name)');
    const qname = nameMatch[1]!;
    const scope = { ...top.scope };
    const attrs: Record<string, string> = {};
    for (const m of body.slice(qname.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const attr = m[1]!;
      const value = decodeEntities(m[3] ?? m[4] ?? '');
      if (attr === 'xmlns') scope[''] = value;
      else if (attr.startsWith('xmlns:')) scope[attr.slice(6)] = value;
      else attrs[attr.includes(':') ? attr.slice(attr.indexOf(':') + 1) : attr] = value;
    }
    const colon = qname.indexOf(':');
    const prefix = colon === -1 ? '' : qname.slice(0, colon);
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    const el: XmlElement = { ns: scope[prefix] ?? '', name: local, qname, children: [], attrs, text: '', deep: '' };
    if (++count > MAX_ELEMENTS) throw new Error('the feed is too large to read');
    top.el.children.push(el);
    addBreak();
    if (!selfClosing) stack.push({ el, scope });
  }
  const doc = root.children[0];
  if (!doc) throw new Error('the feed is not XML (no element)');
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

/** All the text inside, children included: an Atom `type="xhtml"` body, a title with markup in it. */
export function deepText(el: XmlElement | undefined): string {
  return el ? el.deep : '';
}
