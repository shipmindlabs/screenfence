import { WORDPROCESSINGML_NAMESPACES, readXml } from './xml.ts';
import type { QName } from './xml.ts';
import type { ZipEntry } from './zip.ts';

export const NS_PACKAGE_RELS = [
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
] as const;

export const NS_OFFICE_RELS = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
] as const;

export const NS_DRAWING = [
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
] as const;

export const NS_WORD_DRAWING = [
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
] as const;

export const NS_PICTURE = [
  'http://schemas.openxmlformats.org/drawingml/2006/picture',
  'http://purl.oclc.org/ooxml/drawingml/picture',
] as const;

export const NS_MARKUP_COMPATIBILITY = [
  'http://schemas.openxmlformats.org/markup-compatibility/2006',
] as const;

export const NS_VML = ['urn:schemas-microsoft-com:vml'] as const;

const prefixed = (uris: readonly string[], prefix: string): Array<[string, string]> =>
  uris.map((uri): [string, string] => [uri, prefix]);

const PREFIXES = new Map<string, string>([
  ...prefixed(WORDPROCESSINGML_NAMESPACES, 'w'),
  ...prefixed(NS_DRAWING, 'a'),
  ...prefixed(NS_WORD_DRAWING, 'wp'),
  ...prefixed(NS_PICTURE, 'pic'),
  ...prefixed(NS_MARKUP_COMPATIBILITY, 'mc'),
  ...prefixed(NS_VML, 'v'),
  ...prefixed(NS_OFFICE_RELS, 'r'),
  ...prefixed(NS_PACKAGE_RELS, 'rel'),
]);

export const named = (name: QName): string => {
  if (name.ns === null) {
    return name.local;
  }
  const prefix = PREFIXES.get(name.ns);
  return prefix === undefined ? `{${name.ns}}${name.local}` : `${prefix}:${name.local}`;
};

export type Element = {
  name: string;
  attributes: Map<string, string>;
  children: Element[];
  text: string;
};

export const parseTree = (xml: string, roots: readonly string[]): Element => {
  const root: Element = { name: '', attributes: new Map(), children: [], text: '' };
  const stack: Element[] = [root];

  for (const token of readXml(xml, { rootNamespaces: roots })) {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      break;
    }
    if (token.kind === 'text') {
      top.text += token.text;
      continue;
    }
    if (token.kind === 'end') {
      stack.pop();
      continue;
    }
    const child: Element = {
      name: named(token.name),
      attributes: new Map(token.attributes.map((a): [string, string] => [named(a.name), a.value])),
      children: [],
      text: '',
    };
    top.children.push(child);
    if (!token.selfClosing) {
      stack.push(child);
    }
  }

  return root.children[0] ?? root;
};

export const childOf = (parent: Element | null, name: string): Element | null =>
  parent === null ? null : (parent.children.find((child) => child.name === name) ?? null);

export const childrenOf = (parent: Element | null, name: string): Element[] =>
  parent === null ? [] : parent.children.filter((child) => child.name === name);

export const attrOf = (owner: Element | null, name: string): string | null =>
  owner === null ? null : (owner.attributes.get(name) ?? null);

const OFF = new Set(['0', 'false', 'off']);

export const onOff = (owner: Element | null): boolean | null => {
  if (owner === null) {
    return null;
  }
  const value = owner.attributes.get('w:val');
  return value === undefined ? true : !OFF.has(value.toLowerCase());
};

const decoder = new TextDecoder();

export const textOf = (part: ZipEntry): string => decoder.decode(part.bytes);

export const dirOf = (name: string): string => name.slice(0, name.lastIndexOf('/') + 1);
