import { coverageOf } from '../route.ts';
import type { Coverage } from '../route.ts';
import type { SourceSpan, Style, StyledRun } from '../runs.ts';
import {
  UNRESOLVED_COLOR,
  cascadeContextOf,
  relationshipsOf,
  relsNameFor,
  resolveRunsIn,
} from './cascade.ts';
import type { UnknownReason } from './cascade.ts';
import { attrOf, childOf, dirOf, parseTree, textOf } from './tree.ts';
import type { Element } from './tree.ts';
import { WORDPROCESSINGML_NAMESPACES } from './xml.ts';
import { findPart, readZip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

export const RUN_ORIGINS = ['rendered', 'not-rendered', 'textbox', 'alternate-content'] as const;

export type RunOrigin = (typeof RUN_ORIGINS)[number];

export const PART_UNKNOWN_REASONS = ['textbox-content', 'alternate-content-differs'] as const;

export type PartUnknownReason = (typeof PART_UNKNOWN_REASONS)[number];

export const NOT_CHECKED_KINDS = ['image', 'embedded-object', 'alt-chunk'] as const;

export type NotCheckedKind = (typeof NOT_CHECKED_KINDS)[number];

export type NotCheckedItem = { kind: NotCheckedKind; part: string; name: string };

export type DocxRun = {
  id: string;
  text: string;
  source: SourceSpan;
  style: Style;
  origin: RunOrigin;
  unknown: Array<UnknownReason | PartUnknownReason>;
};

export type DocxCoverage = Coverage & { notChecked: NotCheckedItem[] };

export type DocxReading = { runs: DocxRun[]; coverage: DocxCoverage };

export const styledPartRuns = (runs: readonly DocxRun[]): StyledRun[] =>
  runs.map((run) => ({
    id: run.id,
    text: run.text,
    source: run.source,
    style: run.unknown.length > 0 ? { color: UNRESOLVED_COLOR } : run.style,
  }));

type Role = 'cascade' | 'hidden-wml' | 'hidden-any';

const CASCADE_SUFFIXES = new Set(['header', 'footer', 'footnotes', 'endnotes']);

const HIDDEN_WML_SUFFIXES = new Set(['comments', 'glossaryDocument']);

const HIDDEN_ANY_SUFFIXES = new Set(['customXml', 'core-properties', 'extended-properties']);

const NOT_CHECKED_SUFFIXES = new Map<string, NotCheckedKind>([
  ['image', 'image'],
  ['thumbnail', 'image'],
  ['oleObject', 'embedded-object'],
  ['package', 'embedded-object'],
  ['aFChunk', 'alt-chunk'],
]);

const roleFor = (suffix: string): Role | null => {
  if (CASCADE_SUFFIXES.has(suffix)) {
    return 'cascade';
  }
  if (HIDDEN_WML_SUFFIXES.has(suffix)) {
    return 'hidden-wml';
  }
  return HIDDEN_ANY_SUFFIXES.has(suffix) ? 'hidden-any' : null;
};

const suffixOf = (type: string): string => type.slice(type.lastIndexOf('/') + 1);

const normalise = (target: string): string => {
  const segments: string[] = [];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
};

const XMLNS = /xmlns(?::[A-Za-z0-9_.-]+)?[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/g;

// A custom XML item carries whichever namespace its author chose, so the part's own declarations
// are the root namespaces it is allowed to use; an undeclared prefix is still refused.
const declaredNamespaces = (xml: string): string[] => {
  const found: string[] = [];
  for (const match of xml.matchAll(XMLNS)) {
    const uri = match[1] ?? match[2] ?? '';
    if (uri !== '') {
      found.push(uri);
    }
  }
  return found;
};

const WML_TEXT = new Set(['w:t', 'w:delText', 'w:instrText']);

const wmlText = (element: Element): string => {
  let text = '';

  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (WML_TEXT.has(child.name)) {
        text += child.text;
      } else if (child.name === 'w:tab') {
        text += '\t';
      } else if (child.name === 'w:br' || child.name === 'w:cr') {
        text += '\n';
      } else {
        walk(child);
      }
    }
  };

  walk(element);
  return text;
};

const paragraphsOf = (root: Element): Element[] => {
  const found: Element[] = [];

  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (child.name === 'w:p') {
        found.push(child);
      } else {
        walk(child);
      }
    }
  };

  walk(root);
  return found;
};

const leafTextsOf = (root: Element): string[] => {
  const found: string[] = [];

  const walk = (node: Element): void => {
    const text = node.text.trim();
    if (text !== '') {
      found.push(text);
    }
    for (const child of node.children) {
      walk(child);
    }
  };

  walk(root);
  return found;
};

type Cursor = { part: string; prefix: string; at: number; index: number };

type Collector = {
  runs: DocxRun[];
  cursor: Cursor;
  note: (kind: NotCheckedKind, part: string, name: string) => void;
};

const push = (
  collector: Collector,
  text: string,
  origin: RunOrigin,
  reason: PartUnknownReason | null,
): void => {
  if (text === '') {
    return;
  }

  const cursor = collector.cursor;
  cursor.index += 1;
  const source: SourceSpan = { part: cursor.part, start: cursor.at, end: cursor.at + text.length };
  cursor.at += text.length;

  collector.runs.push({
    id: `${cursor.prefix}${cursor.index}`,
    text,
    source,
    style: reason === null ? { hidden: true } : {},
    origin,
    unknown: reason === null ? [] : [reason],
  });
};

const DOCPR_KEYS = ['descr', 'title'] as const;

// The cascade reads what the page renders. Everything a reader never sees but a screener still
// parses is collected here: deleted text, field instructions, drawing alt text, textbox bodies and
// the two readings of an mc:AlternateContent.
const scanPart = (root: Element, collector: Collector): void => {
  const part = collector.cursor.part;

  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (child.name === 'mc:AlternateContent') {
        const choice = childOf(child, 'mc:Choice');
        const fallback = childOf(child, 'mc:Fallback');
        const chosen = choice === null ? '' : wmlText(choice);
        const spare = fallback === null ? '' : wmlText(fallback);

        if (chosen !== spare) {
          push(collector, chosen, 'alternate-content', 'alternate-content-differs');
          push(collector, spare, 'alternate-content', 'alternate-content-differs');
          continue;
        }
        walk(choice ?? child);
        continue;
      }
      if (child.name === 'w:txbxContent') {
        push(collector, wmlText(child), 'textbox', 'textbox-content');
        continue;
      }
      if (child.name === 'w:delText' || child.name === 'w:instrText') {
        push(collector, child.text, 'not-rendered', null);
        continue;
      }
      if (child.name === 'wp:docPr') {
        for (const key of DOCPR_KEYS) {
          push(collector, attrOf(child, key) ?? '', 'not-rendered', null);
        }
        continue;
      }
      if (child.name === 'w:altChunk') {
        collector.note('alt-chunk', part, attrOf(child, 'r:id') ?? child.name);
        continue;
      }
      if (child.name === 'w:object' || child.name === 'w:embedObject') {
        collector.note('embedded-object', part, attrOf(child, 'r:id') ?? child.name);
        continue;
      }
      if (child.name === 'a:blip' || child.name === 'v:imagedata') {
        collector.note(
          'image',
          part,
          attrOf(child, 'r:embed') ?? attrOf(child, 'r:id') ?? child.name,
        );
        continue;
      }
      walk(child);
    }
  };

  walk(root);
};

export const readParts = (parts: readonly ZipEntry[]): DocxReading => {
  const context = cascadeContextOf(parts);
  const runs: DocxRun[] = [];
  const notChecked: NotCheckedItem[] = [];
  const noted = new Set<string>();

  const note = (kind: NotCheckedKind, part: string, name: string): void => {
    const key = `${kind}|${part}|${name}`;
    if (noted.has(key)) {
      return;
    }
    noted.add(key);
    notChecked.push({ kind, part, name });
  };

  const collectorFor = (part: string, prefix: string, at: number): Collector => ({
    runs,
    cursor: { part, prefix, at, index: 0 },
    note,
  });

  const cascadePart = (name: string, root: Element, prefix: string): void => {
    let at = 0;
    for (const run of resolveRunsIn(context, name, root, prefix)) {
      at = Math.max(at, run.source.end);
      runs.push({ ...run, origin: 'rendered' });
    }
    scanPart(root, collectorFor(name, `${prefix}x`, at));
  };

  cascadePart(context.mainName, context.document, 'r');

  const visited = new Set<string>([context.mainName.toLowerCase()]);
  const plans: Array<{ role: Role; name: string }> = [];

  const consider = (relsName: string, base: string, owner: string): void => {
    for (const relationship of relationshipsOf(parts, relsName, base)) {
      if (relationship.external) {
        continue;
      }
      const suffix = suffixOf(relationship.type);
      const name = normalise(relationship.target);
      const kind = NOT_CHECKED_SUFFIXES.get(suffix);

      if (kind !== undefined) {
        note(kind, owner, name);
        continue;
      }

      const role = roleFor(suffix);
      if (role === null || visited.has(name.toLowerCase()) || findPart(parts, name) === null) {
        continue;
      }
      visited.add(name.toLowerCase());
      plans.push({ role, name });
    }
  };

  consider('_rels/.rels', '', '_rels/.rels');
  consider(relsNameFor(context.mainName), dirOf(context.mainName), context.mainName);

  let index = 0;

  for (const plan of plans) {
    const entry = findPart(parts, plan.name);
    if (entry === null) {
      continue;
    }

    index += 1;
    const prefix = `p${index}r`;
    const xml = textOf(entry);

    if (plan.role === 'cascade') {
      cascadePart(plan.name, parseTree(xml, WORDPROCESSINGML_NAMESPACES), prefix);
      continue;
    }

    const collector = collectorFor(plan.name, prefix, 0);

    if (plan.role === 'hidden-wml') {
      const root = parseTree(xml, WORDPROCESSINGML_NAMESPACES);
      const paragraphs = paragraphsOf(root);
      const texts = paragraphs.length > 0 ? paragraphs.map(wmlText) : [wmlText(root)];
      for (const text of texts) {
        push(collector, text, 'not-rendered', null);
      }
      continue;
    }

    for (const text of leafTextsOf(parseTree(xml, declaredNamespaces(xml)))) {
      push(collector, text, 'not-rendered', null);
    }
  }

  return { runs, coverage: { ...coverageOf(styledPartRuns(runs)), notChecked } };
};

export const readDocx = async (bytes: Uint8Array): Promise<DocxReading> =>
  readParts(await readZip(bytes));
