export const XML_REFUSAL_CODES = [
  'doctype',
  'entity-reference',
  'character-reference',
  'depth-cap',
  'unbound-prefix',
  'unknown-namespace',
  'malformed',
] as const;

export type XmlRefusalCode = (typeof XML_REFUSAL_CODES)[number];

export class XmlRefusal extends Error {
  readonly code: XmlRefusalCode;
  readonly offset: number;

  constructor(code: XmlRefusalCode, detail: string, offset: number) {
    super(`${code}: ${detail} at offset ${offset}`);
    this.name = 'XmlRefusal';
    this.code = code;
    this.offset = offset;
  }
}

const refuse = (code: XmlRefusalCode, detail: string, offset: number): never => {
  throw new XmlRefusal(code, detail, offset);
};

export type XmlLimits = { depth: number };

export const XML_LIMITS: XmlLimits = { depth: 64 };

export const WORDPROCESSINGML_NAMESPACES = [
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
] as const;

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

const CANONICAL_PREFIXES = new Map<string, string>(
  WORDPROCESSINGML_NAMESPACES.map((uri): [string, string] => [uri, 'w']),
);

export type QName = {
  ns: string | null;
  local: string;
};

export type XmlAttribute = {
  name: QName;
  value: string;
  offset: number;
};

export type XmlToken =
  | {
      kind: 'start';
      offset: number;
      name: QName;
      attributes: XmlAttribute[];
      selfClosing: boolean;
      depth: number;
    }
  | { kind: 'end'; offset: number; name: QName; depth: number }
  | { kind: 'text'; offset: number; text: string };

export type XmlOptions = {
  limits?: XmlLimits;
  rootNamespaces?: readonly string[];
};

export const canonicalName = (name: QName): string => {
  if (name.ns === null) {
    return name.local;
  }
  const prefix = CANONICAL_PREFIXES.get(name.ns);
  return prefix === undefined ? `{${name.ns}}${name.local}` : `${prefix}:${name.local}`;
};

const PREDEFINED = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['apos', "'"],
  ['quot', '"'],
]);

const SPACE = /^[ \t\r\n]$/;

const NCNAME =
  /[A-Za-z_\u00c0-\u02ff\u0370-\u037d\u037f-\u1fff\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd][-.0-9A-Za-z_\u00b7\u00c0-\u02ff\u0300-\u036f\u0370-\u037d\u037f-\u1fff\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]*/y;

const QUOTED = /"([^"<]*)"|'([^'<]*)'/y;

const DECIMAL = /^[0-9]+$/;
const HEXADECIMAL = /^[0-9a-fA-F]+$/;

const isXmlChar = (codePoint: number): boolean =>
  codePoint === 0x9 ||
  codePoint === 0xa ||
  codePoint === 0xd ||
  (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
  (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
  (codePoint >= 0x10000 && codePoint <= 0x10ffff);

// References are decoded before any text leaves the tokenizer, so a smuggled &#x200B; reaches the
// code-point scan as the character it denotes.
const decode = (raw: string, base: number): string => {
  let out = '';
  let index = 0;

  while (index < raw.length) {
    const amp = raw.indexOf('&', index);
    if (amp < 0) {
      out += raw.slice(index);
      break;
    }
    out += raw.slice(index, amp);

    const semi = raw.indexOf(';', amp);
    if (semi < 0) {
      return refuse('malformed', 'a reference without a semicolon', base + amp);
    }

    const body = raw.slice(amp + 1, semi);

    if (body.startsWith('#')) {
      const hex = body.startsWith('#x');
      const digits = hex ? body.slice(2) : body.slice(1);
      if (!(hex ? HEXADECIMAL : DECIMAL).test(digits)) {
        return refuse('character-reference', `&${body}; is not a number`, base + amp);
      }
      const codePoint = Number.parseInt(digits, hex ? 16 : 10);
      if (!isXmlChar(codePoint)) {
        return refuse('character-reference', `&${body}; is not a character XML allows`, base + amp);
      }
      out += String.fromCodePoint(codePoint);
    } else {
      const predefined = PREDEFINED.get(body);
      if (predefined === undefined) {
        return refuse('entity-reference', `&${body}; is not a predefined entity`, base + amp);
      }
      out += predefined;
    }

    index = semi + 1;
  }

  return out;
};

const readQuoted = (source: string, at: number): { raw: string; end: number } => {
  QUOTED.lastIndex = at;
  const match = QUOTED.exec(source);
  if (match === null) {
    return refuse('malformed', 'an attribute value that is not quoted text', at);
  }
  return { raw: match[1] ?? match[2] ?? '', end: at + match[0].length };
};

type RawAttribute = {
  prefix: string;
  local: string;
  raw: string;
  value: string;
  offset: number;
};

export function* readXml(source: string, options: XmlOptions = {}): Generator<XmlToken> {
  const limits = options.limits ?? XML_LIMITS;
  const rootNamespaces = options.rootNamespaces ?? WORDPROCESSINGML_NAMESPACES;
  const scopes: Array<Map<string, string>> = [];
  const open: Array<{ raw: string; name: QName }> = [];
  let at = 0;
  let rootSeen = false;

  const skipSpace = (): boolean => {
    const start = at;
    while (at < source.length && SPACE.test(source[at] ?? '')) {
      at += 1;
    }
    return at > start;
  };

  const lookup = (prefix: string, offset: number): string | null => {
    if (prefix === 'xml') {
      return XML_NAMESPACE;
    }
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const uri = scopes[index]?.get(prefix);
      if (uri !== undefined) {
        return uri === '' ? null : uri;
      }
    }
    if (prefix === '') {
      return null;
    }
    return refuse('unbound-prefix', `prefix ${prefix} is not declared`, offset);
  };

  const readName = (): { prefix: string; local: string; raw: string } => {
    const offset = at;
    NCNAME.lastIndex = offset;
    const first = NCNAME.exec(source);
    if (first === null) {
      return refuse('malformed', 'expected a name', offset);
    }

    let prefix = '';
    let local = first[0];
    at = offset + local.length;

    if (source[at] === ':') {
      NCNAME.lastIndex = at + 1;
      const second = NCNAME.exec(source);
      if (second === null) {
        return refuse('malformed', 'expected a local name', at + 1);
      }
      prefix = local;
      local = second[0];
      at = at + 1 + local.length;
    }

    return { prefix, local, raw: source.slice(offset, at) };
  };

  while (at < source.length) {
    if (source[at] !== '<') {
      const offset = at;
      const nextTag = source.indexOf('<', at);
      const raw = source.slice(offset, nextTag < 0 ? source.length : nextTag);
      at = offset + raw.length;

      if (open.length === 0) {
        if (raw.trim() !== '') {
          refuse('malformed', 'text outside the document element', offset);
        }
        continue;
      }

      const text = decode(raw, offset);
      if (text !== '') {
        yield { kind: 'text', offset, text };
      }
      continue;
    }

    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4);
      if (end < 0) {
        refuse('malformed', 'a comment that does not close', at);
      }
      at = end + 3;
      continue;
    }

    if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at + 9);
      if (end < 0) {
        refuse('malformed', 'a CDATA section that does not close', at);
      }
      if (open.length === 0) {
        refuse('malformed', 'a CDATA section outside the document element', at);
      }
      const offset = at + 9;
      const text = source.slice(offset, end);
      at = end + 3;
      if (text !== '') {
        yield { kind: 'text', offset, text };
      }
      continue;
    }

    if (source.startsWith('<!DOCTYPE', at)) {
      refuse('doctype', 'the part carries a document type declaration', at);
    }

    if (source.startsWith('<!', at)) {
      refuse('malformed', 'a markup declaration that is not a comment', at);
    }

    if (source.startsWith('<?', at)) {
      const end = source.indexOf('?>', at + 2);
      if (end < 0) {
        refuse('malformed', 'a processing instruction that does not close', at);
      }
      at = end + 2;
      continue;
    }

    if (source.startsWith('</', at)) {
      const offset = at;
      at += 2;
      const closing = readName();
      skipSpace();
      if (source[at] !== '>') {
        refuse('malformed', 'an end tag that does not close', at);
      }
      at += 1;

      const top = open.pop();
      if (top === undefined) {
        refuse('malformed', `${closing.raw} closes nothing`, offset);
        continue;
      }
      if (top.raw !== closing.raw) {
        refuse('malformed', `${closing.raw} closes ${top.raw}`, offset);
      }
      scopes.pop();

      yield { kind: 'end', offset, name: top.name, depth: open.length + 1 };
      continue;
    }

    const offset = at;
    at += 1;
    const element = readName();
    const raws: RawAttribute[] = [];
    const seen = new Set<string>();
    let selfClosing = false;

    for (;;) {
      const spaced = skipSpace();

      if (source.startsWith('/>', at)) {
        selfClosing = true;
        at += 2;
        break;
      }
      if (source[at] === '>') {
        at += 1;
        break;
      }
      if (at >= source.length) {
        refuse('malformed', 'a start tag that does not close', offset);
      }
      if (!spaced) {
        refuse('malformed', 'expected whitespace before an attribute', at);
      }

      const nameOffset = at;
      const attribute = readName();
      if (seen.has(attribute.raw)) {
        refuse('malformed', `attribute ${attribute.raw} appears twice`, nameOffset);
      }
      seen.add(attribute.raw);

      skipSpace();
      if (source[at] !== '=') {
        refuse('malformed', 'an attribute without a value', at);
      }
      at += 1;
      skipSpace();

      const quoted = readQuoted(source, at);
      raws.push({
        prefix: attribute.prefix,
        local: attribute.local,
        raw: attribute.raw,
        value: decode(quoted.raw, at + 1),
        offset: nameOffset,
      });
      at = quoted.end;
    }

    const scope = new Map<string, string>();
    for (const raw of raws) {
      if (raw.prefix === '' && raw.local === 'xmlns') {
        scope.set('', raw.value);
      } else if (raw.prefix === 'xmlns') {
        if (raw.value === '') {
          refuse('malformed', `prefix ${raw.local} is bound to no namespace`, raw.offset);
        }
        scope.set(raw.local, raw.value);
      }
    }
    scopes.push(scope);

    const name: QName = { ns: lookup(element.prefix, offset), local: element.local };
    const depth = open.length + 1;

    if (depth > limits.depth) {
      refuse('depth-cap', `nesting passes the cap of ${limits.depth}`, offset);
    }

    if (!rootSeen) {
      rootSeen = true;
      if (name.ns === null || !rootNamespaces.includes(name.ns)) {
        refuse('unknown-namespace', `the document element is ${canonicalName(name)}`, offset);
      }
    }

    const attributes: XmlAttribute[] = [];
    const expanded = new Set<string>();

    for (const raw of raws) {
      if (raw.prefix === 'xmlns' || (raw.prefix === '' && raw.local === 'xmlns')) {
        continue;
      }
      const ns = raw.prefix === '' ? null : lookup(raw.prefix, raw.offset);
      const key = `${ns ?? ''} ${raw.local}`;
      if (expanded.has(key)) {
        refuse('malformed', `attribute ${raw.local} appears twice`, raw.offset);
      }
      expanded.add(key);
      attributes.push({ name: { ns, local: raw.local }, value: raw.value, offset: raw.offset });
    }

    if (selfClosing) {
      scopes.pop();
    } else {
      open.push({ raw: element.raw, name });
    }

    yield { kind: 'start', offset, name, attributes, selfClosing, depth };
  }

  if (open.length > 0) {
    refuse('malformed', 'the part ends inside an element', source.length);
  }
  if (!rootSeen) {
    refuse('malformed', 'the part has no document element', source.length);
  }
}
