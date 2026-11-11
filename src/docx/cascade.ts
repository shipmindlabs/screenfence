import { RULESET_V1, classifyRun } from '../layers.ts';
import type { SourceSpan, Style, StyledRun } from '../runs.ts';
import { WORDPROCESSINGML_NAMESPACES, readXml } from './xml.ts';
import type { QName } from './xml.ts';
import { findPart } from './zip.ts';
import type { ZipEntry } from './zip.ts';

export const CASCADE_REFUSAL_CODES = ['no-package-rels', 'no-main-part', 'style-cycle'] as const;

export type CascadeRefusalCode = (typeof CASCADE_REFUSAL_CODES)[number];

export class CascadeRefusal extends Error {
  readonly code: CascadeRefusalCode;
  readonly part: string | null;

  constructor(code: CascadeRefusalCode, detail: string, part: string | null = null) {
    super(part === null ? `${code}: ${detail}` : `${code}: ${detail} (${part})`);
    this.name = 'CascadeRefusal';
    this.code = code;
    this.part = part;
  }
}

const refuse = (code: CascadeRefusalCode, detail: string, part: string | null = null): never => {
  throw new CascadeRefusal(code, detail, part);
};

export const UNKNOWN_REASONS = [
  'theme-part-missing',
  'unreadable-color',
  'unreadable-size',
  'unreadable-shading',
  'unreadable-highlight',
  'vanish-toggle-disagreement',
  'background-shape-dependent',
  'narrow-character-scaling',
  'condensed-spacing',
  'raised-text',
] as const;

export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export const CASCADE_LEVELS = ['docDefaults', 'paragraph', 'character', 'direct'] as const;

export type CascadeLevel = (typeof CASCADE_LEVELS)[number];

export type ResolvedRun = {
  id: string;
  text: string;
  source: SourceSpan;
  style: Style;
  unknown: UnknownReason[];
};

// A run the cascade could not read carries a colour no ruleset parses, so it lands in the unknown
// layer instead of being trusted as visible.
export const UNRESOLVED_COLOR = 'unresolved';

const DEFAULT_SIZE_PT = 10;

const NS_PACKAGE_RELS = [
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
] as const;

const NS_OFFICE_RELS = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
] as const;

const NS_DRAWING = [
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
] as const;

const PREFIXES = new Map<string, string>([
  ...WORDPROCESSINGML_NAMESPACES.map((uri): [string, string] => [uri, 'w']),
  ...NS_DRAWING.map((uri): [string, string] => [uri, 'a']),
  ...NS_OFFICE_RELS.map((uri): [string, string] => [uri, 'r']),
  ...NS_PACKAGE_RELS.map((uri): [string, string] => [uri, 'rel']),
]);

const named = (name: QName): string => {
  if (name.ns === null) {
    return name.local;
  }
  const prefix = PREFIXES.get(name.ns);
  return prefix === undefined ? `{${name.ns}}${name.local}` : `${prefix}:${name.local}`;
};

type Element = { name: string; attributes: Map<string, string>; children: Element[]; text: string };

const parseTree = (xml: string, roots: readonly string[]): Element => {
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

const childOf = (parent: Element | null, name: string): Element | null =>
  parent === null ? null : (parent.children.find((child) => child.name === name) ?? null);

const childrenOf = (parent: Element | null, name: string): Element[] =>
  parent === null ? [] : parent.children.filter((child) => child.name === name);

const attrOf = (owner: Element | null, name: string): string | null =>
  owner === null ? null : (owner.attributes.get(name) ?? null);

const OFF = new Set(['0', 'false', 'off']);

const onOff = (owner: Element | null): boolean | null => {
  if (owner === null) {
    return null;
  }
  const value = owner.attributes.get('w:val');
  return value === undefined ? true : !OFF.has(value.toLowerCase());
};

const decoder = new TextDecoder();

const textOf = (part: ZipEntry): string => decoder.decode(part.bytes);

const dirOf = (name: string): string => name.slice(0, name.lastIndexOf('/') + 1);

const relationshipTarget = (
  parts: readonly ZipEntry[],
  relsName: string,
  base: string,
  suffix: string,
): string | null => {
  const rels = findPart(parts, relsName);
  if (rels === null) {
    return null;
  }

  const root = parseTree(textOf(rels), NS_PACKAGE_RELS);

  for (const relationship of childrenOf(root, 'rel:Relationship')) {
    const type = relationship.attributes.get('Type') ?? '';
    const target = relationship.attributes.get('Target');
    const mode = relationship.attributes.get('TargetMode') ?? 'Internal';
    if (type.endsWith(`/${suffix}`) && target !== undefined && mode === 'Internal') {
      return target.startsWith('/') ? target.slice(1) : `${base}${target}`;
    }
  }

  return null;
};

const HEX = /^[0-9a-f]{6}$/;
const PERCENT = /^pct([0-9]+)$/;
const DIGITS = /^[0-9]+$/;

type Rgb = { r: number; g: number; b: number };

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

const parseHex = (value: string): Rgb | null => {
  const digits = value.toLowerCase();
  if (!HEX.test(digits)) {
    return null;
  }
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
};

const toCss = (colour: Rgb): string => {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`;
};

const mix = (over: Rgb, under: Rgb, share: number): Rgb => ({
  r: over.r * share + under.r * (1 - share),
  g: over.g * share + under.g * (1 - share),
  b: over.b * share + under.b * (1 - share),
});

// themeTint and themeShade are hex fractions of 255: a tint blends towards white, a shade darkens.
const applyTintShade = (colour: Rgb, tint: string | null, shade: string | null): Rgb => {
  const fraction = (raw: string): number | null => {
    const value = Number.parseInt(raw, 16);
    return Number.isFinite(value) ? Math.max(0, Math.min(255, value)) / 255 : null;
  };

  const tinted = tint === null ? null : fraction(tint);
  if (tinted !== null) {
    return mix(colour, WHITE, tinted);
  }
  const shaded = shade === null ? null : fraction(shade);
  return shaded === null ? colour : mix(colour, BLACK, shaded);
};

const SCHEME_ELEMENTS = new Map<string, string>([
  ['dark1', 'a:dk1'],
  ['light1', 'a:lt1'],
  ['dark2', 'a:dk2'],
  ['light2', 'a:lt2'],
  ['accent1', 'a:accent1'],
  ['accent2', 'a:accent2'],
  ['accent3', 'a:accent3'],
  ['accent4', 'a:accent4'],
  ['accent5', 'a:accent5'],
  ['accent6', 'a:accent6'],
  ['hyperlink', 'a:hlink'],
  ['followedHyperlink', 'a:folHlink'],
]);

// w:themeColor names a Word slot; w:clrSchemeMapping says which scheme colour that slot reads.
const WORD_SLOTS = new Map<string, string>([
  ['text1', 'w:t1'],
  ['text2', 'w:t2'],
  ['background1', 'w:bg1'],
  ['background2', 'w:bg2'],
  ['accent1', 'w:accent1'],
  ['accent2', 'w:accent2'],
  ['accent3', 'w:accent3'],
  ['accent4', 'w:accent4'],
  ['accent5', 'w:accent5'],
  ['accent6', 'w:accent6'],
  ['hyperlink', 'w:hyperlink'],
  ['followedHyperlink', 'w:followedHyperlink'],
]);

const DEFAULT_MAPPING = new Map<string, string>([
  ['w:bg1', 'light1'],
  ['w:t1', 'dark1'],
  ['w:bg2', 'light2'],
  ['w:t2', 'dark2'],
  ['w:accent1', 'accent1'],
  ['w:accent2', 'accent2'],
  ['w:accent3', 'accent3'],
  ['w:accent4', 'accent4'],
  ['w:accent5', 'accent5'],
  ['w:accent6', 'accent6'],
  ['w:hyperlink', 'hyperlink'],
  ['w:followedHyperlink', 'followedHyperlink'],
]);

const DIRECT_SCHEME = new Set(['dark1', 'light1', 'dark2', 'light2']);

type Theme = { colours: Map<string, string>; mapping: Map<string, string> } | null;

const themeColoursOf = (xml: string): Map<string, string> => {
  const scheme = childOf(childOf(parseTree(xml, NS_DRAWING), 'a:themeElements'), 'a:clrScheme');
  const colours = new Map<string, string>();

  for (const slot of scheme?.children ?? []) {
    const hex =
      attrOf(childOf(slot, 'a:srgbClr'), 'val') ?? attrOf(childOf(slot, 'a:sysClr'), 'lastClr');
    if (hex !== null) {
      colours.set(slot.name, hex);
    }
  }

  return colours;
};

const mappingOf = (settings: Element | null): Map<string, string> =>
  new Map(childOf(settings, 'w:clrSchemeMapping')?.attributes ?? []);

const schemeIndexOf = (theme: NonNullable<Theme>, themeColor: string): string | null => {
  if (DIRECT_SCHEME.has(themeColor)) {
    return themeColor;
  }
  const slot = WORD_SLOTS.get(themeColor);
  if (slot === undefined) {
    return null;
  }
  return theme.mapping.get(slot) ?? DEFAULT_MAPPING.get(slot) ?? null;
};

const themeHex = (theme: Theme, themeColor: string): string | null => {
  if (theme === null) {
    return null;
  }
  const index = schemeIndexOf(theme, themeColor);
  const slotElement = index === null ? undefined : SCHEME_ELEMENTS.get(index);
  return slotElement === undefined ? null : (theme.colours.get(slotElement) ?? null);
};

type ColourKeys = { val: string; theme: string; tint: string; shade: string };

const COLOR_KEYS: ColourKeys = {
  val: 'w:val',
  theme: 'w:themeColor',
  tint: 'w:themeTint',
  shade: 'w:themeShade',
};

const FILL_KEYS: ColourKeys = {
  val: 'w:fill',
  theme: 'w:themeFill',
  tint: 'w:themeFillTint',
  shade: 'w:themeFillShade',
};

const BACKGROUND_KEYS: ColourKeys = { ...COLOR_KEYS, val: 'w:color' };

type Colour =
  | { kind: 'value'; rgb: Rgb }
  | { kind: 'auto' }
  | { kind: 'unknown'; themeMissing: boolean }
  | null;

// A w:themeColor supersedes w:val, so a run pointing at a theme that is not in the package has no
// colour even when its w:val says black.
const colourOf = (owner: Element | null, theme: Theme, keys: ColourKeys): Colour => {
  if (owner === null) {
    return null;
  }

  const themeColor = owner.attributes.get(keys.theme);
  if (themeColor !== undefined && themeColor !== 'none') {
    const hex = themeHex(theme, themeColor);
    const parsed = hex === null ? null : parseHex(hex);
    if (parsed === null) {
      return { kind: 'unknown', themeMissing: theme === null };
    }
    return {
      kind: 'value',
      rgb: applyTintShade(
        parsed,
        owner.attributes.get(keys.tint) ?? null,
        owner.attributes.get(keys.shade) ?? null,
      ),
    };
  }

  const val = owner.attributes.get(keys.val);
  if (val === undefined) {
    return null;
  }
  if (val.toLowerCase() === 'auto') {
    return { kind: 'auto' };
  }
  const parsed = parseHex(val);
  return parsed === null ? { kind: 'unknown', themeMissing: false } : { kind: 'value', rgb: parsed };
};

type Fill =
  | { kind: 'value'; rgb: Rgb }
  | { kind: 'transparent' }
  | { kind: 'unknown'; themeMissing: boolean };

const TRANSPARENT: Fill = { kind: 'transparent' };

const fillOf = (colour: Colour): Fill => {
  if (colour === null || colour.kind === 'auto') {
    return TRANSPARENT;
  }
  return colour.kind === 'unknown'
    ? { kind: 'unknown', themeMissing: colour.themeMissing }
    : { kind: 'value', rgb: colour.rgb };
};

const shadingOf = (shd: Element | null, theme: Theme): Fill => {
  if (shd === null) {
    return TRANSPARENT;
  }

  const pattern = (shd.attributes.get('w:val') ?? 'nil').toLowerCase();

  if (pattern === 'nil' || pattern === 'none') {
    return TRANSPARENT;
  }
  if (pattern === 'clear') {
    return fillOf(colourOf(shd, theme, FILL_KEYS));
  }
  if (pattern === 'solid') {
    return fillOf(colourOf(shd, theme, COLOR_KEYS));
  }

  const percent = PERCENT.exec(pattern);
  const share = percent === null ? Number.NaN : Number(percent[1] ?? '');
  if (!Number.isFinite(share) || share > 100) {
    return { kind: 'unknown', themeMissing: false };
  }

  const over = colourOf(shd, theme, COLOR_KEYS);
  const under = colourOf(shd, theme, FILL_KEYS);
  for (const side of [over, under]) {
    if (side !== null && side.kind === 'unknown') {
      return { kind: 'unknown', themeMissing: side.themeMissing };
    }
  }

  return {
    kind: 'value',
    rgb: mix(
      over !== null && over.kind === 'value' ? over.rgb : BLACK,
      under !== null && under.kind === 'value' ? under.rgb : WHITE,
      share / 100,
    ),
  };
};

const HIGHLIGHTS = new Map<string, Rgb>([
  ['yellow', { r: 255, g: 255, b: 0 }],
  ['green', { r: 0, g: 255, b: 0 }],
  ['cyan', { r: 0, g: 255, b: 255 }],
  ['magenta', { r: 255, g: 0, b: 255 }],
  ['blue', { r: 0, g: 0, b: 255 }],
  ['red', { r: 255, g: 0, b: 0 }],
  ['darkblue', { r: 0, g: 0, b: 128 }],
  ['darkcyan', { r: 0, g: 128, b: 128 }],
  ['darkgreen', { r: 0, g: 128, b: 0 }],
  ['darkmagenta', { r: 128, g: 0, b: 128 }],
  ['darkred', { r: 128, g: 0, b: 0 }],
  ['darkyellow', { r: 128, g: 128, b: 0 }],
  ['darkgray', { r: 128, g: 128, b: 128 }],
  ['lightgray', { r: 192, g: 192, b: 192 }],
  ['black', { r: 0, g: 0, b: 0 }],
  ['white', { r: 255, g: 255, b: 255 }],
]);

const highlightOf = (highlight: Element | null): Fill => {
  if (highlight === null) {
    return TRANSPARENT;
  }
  const name = (highlight.attributes.get('w:val') ?? 'none').toLowerCase();
  if (name === 'none') {
    return TRANSPARENT;
  }
  const colour = HIGHLIGHTS.get(name);
  return colour === undefined
    ? { kind: 'unknown', themeMissing: false }
    : { kind: 'value', rgb: colour };
};

type StyleDef = { basedOn: string | null; rPr: Element | null };

type Styles = { docDefaults: Element | null; byId: Map<string, StyleDef> };

const stylesOf = (root: Element | null): Styles => {
  const byId = new Map<string, StyleDef>();

  for (const style of childrenOf(root, 'w:style')) {
    const id = style.attributes.get('w:styleId');
    if (id !== undefined) {
      byId.set(id, {
        basedOn: attrOf(childOf(style, 'w:basedOn'), 'w:val'),
        rPr: childOf(style, 'w:rPr'),
      });
    }
  }

  return {
    docDefaults: childOf(childOf(childOf(root, 'w:docDefaults'), 'w:rPrDefault'), 'w:rPr'),
    byId,
  };
};

// A basedOn chain that returns to a style it already visited has no reading at all, so it is
// refused rather than cut short at an arbitrary depth.
const chainRPr = (styles: Styles, id: string | null): Element[] => {
  const chain: Element[] = [];
  const seen = new Set<string>();
  let current = id;

  while (current !== null) {
    if (seen.has(current)) {
      refuse('style-cycle', `the basedOn chain returns to ${current}`);
    }
    seen.add(current);
    const def = styles.byId.get(current);
    if (def === undefined) {
      break;
    }
    if (def.rPr !== null) {
      chain.push(def.rPr);
    }
    current = def.basedOn;
  }

  return chain.reverse();
};

type Layer = { level: CascadeLevel; rPr: Element };

const layersFor = (styles: Styles, paragraphStyle: string | null, run: Element): Layer[] => {
  const layers: Layer[] = [];
  const direct = childOf(run, 'w:rPr');

  if (styles.docDefaults !== null) {
    layers.push({ level: 'docDefaults', rPr: styles.docDefaults });
  }
  for (const rPr of chainRPr(styles, paragraphStyle)) {
    layers.push({ level: 'paragraph', rPr });
  }
  for (const rPr of chainRPr(styles, attrOf(childOf(direct, 'w:rStyle'), 'w:val'))) {
    layers.push({ level: 'character', rPr });
  }
  if (direct !== null) {
    layers.push({ level: 'direct', rPr: direct });
  }

  return layers;
};

const pick = (layers: readonly Layer[], name: string): Element | null => {
  let found: Element | null = null;
  for (const layer of layers) {
    const property = childOf(layer.rPr, name);
    if (property !== null) {
      found = property;
    }
  }
  return found;
};

// ECMA-376 reads w:vanish as a toggle, so two style levels cancel each other; [MS-OI29500]
// records Word as letting the character style win. Where the readings part company the run has no
// verdict and goes to a person.
const vanishOf = (layers: readonly Layer[]): { hidden: boolean; ambiguous: boolean } => {
  const byLevel = new Map<CascadeLevel, boolean>();

  for (const layer of layers) {
    const vanish = childOf(layer.rPr, 'w:vanish');
    if (vanish !== null) {
      byLevel.set(layer.level, onOff(vanish) ?? true);
    }
  }

  const direct = byLevel.get('direct');
  if (direct !== undefined) {
    return { hidden: direct, ambiguous: false };
  }

  const paragraph = byLevel.get('paragraph');
  const character = byLevel.get('character');

  if (paragraph !== undefined && character !== undefined) {
    const toggled = paragraph !== character;
    return { hidden: character, ambiguous: toggled !== character };
  }

  return {
    hidden: character ?? paragraph ?? byLevel.get('docDefaults') ?? false,
    ambiguous: false,
  };
};

const RUN_CONTAINERS = new Set([
  'w:hyperlink',
  'w:ins',
  'w:smartTag',
  'w:sdt',
  'w:sdtContent',
  'w:bdo',
  'w:dir',
]);

const BODY_CONTAINERS = new Set(['w:sdt', 'w:sdtContent', 'w:customXml']);

const eachParagraph = (
  parent: Element,
  cellShd: Element | null,
  visit: (paragraph: Element, cellShd: Element | null) => void,
): void => {
  for (const child of parent.children) {
    if (child.name === 'w:p') {
      visit(child, cellShd);
    } else if (child.name === 'w:tbl') {
      for (const row of childrenOf(child, 'w:tr')) {
        for (const cell of childrenOf(row, 'w:tc')) {
          const shd = childOf(childOf(cell, 'w:tcPr'), 'w:shd') ?? cellShd;
          eachParagraph(cell, shd, visit);
        }
      }
    } else if (BODY_CONTAINERS.has(child.name)) {
      eachParagraph(child, cellShd, visit);
    }
  }
};

const eachRun = (parent: Element, visit: (run: Element) => void): void => {
  for (const child of parent.children) {
    if (child.name === 'w:r') {
      visit(child);
    } else if (RUN_CONTAINERS.has(child.name)) {
      eachRun(child, visit);
    }
  }
};

const runText = (run: Element): string => {
  let text = '';
  for (const child of run.children) {
    if (child.name === 'w:t') {
      text += child.text;
    } else if (child.name === 'w:tab') {
      text += '\t';
    } else if (child.name === 'w:br' || child.name === 'w:cr') {
      text += '\n';
    } else if (child.name === 'w:noBreakHyphen') {
      text += '-';
    } else if (child.name === 'w:softHyphen') {
      text += '\u00ad';
    }
  }
  return text;
};

type RunInput = {
  id: string;
  text: string;
  source: SourceSpan;
  layers: readonly Layer[];
  paragraphShd: Element | null;
  cellShd: Element | null;
  theme: Theme;
  pageBackground: Colour;
  showsBackgroundShape: boolean;
};

const resolveRun = (input: RunInput): ResolvedRun => {
  const { layers, theme } = input;
  const unknown: UnknownReason[] = [];

  const note = (reason: UnknownReason): void => {
    if (!unknown.includes(reason)) {
      unknown.push(reason);
    }
  };

  const colour = colourOf(pick(layers, 'w:color'), theme, COLOR_KEYS);
  if (colour !== null && colour.kind === 'unknown') {
    note(colour.themeMissing ? 'theme-part-missing' : 'unreadable-color');
  }

  const sz = pick(layers, 'w:sz');
  let sizePt: number | null = null;
  if (sz !== null) {
    const halfPoints = Number(attrOf(sz, 'w:val') ?? '');
    if (!Number.isFinite(halfPoints) || halfPoints <= 0) {
      note('unreadable-size');
    } else {
      sizePt = halfPoints / 2;
    }
  }
  const fontPt = sizePt ?? DEFAULT_SIZE_PT;

  const scaling = pick(layers, 'w:w');
  if (scaling !== null) {
    const raw = (attrOf(scaling, 'w:val') ?? '').replace('%', '');
    if (!DIGITS.test(raw) || Number(raw) < 25) {
      note('narrow-character-scaling');
    }
  }

  const spacing = pick(layers, 'w:spacing');
  if (spacing !== null) {
    const twips = Number(attrOf(spacing, 'w:val') ?? '');
    if (!Number.isFinite(twips) || -twips / 20 > fontPt / 2) {
      note('condensed-spacing');
    }
  }

  const position = pick(layers, 'w:position');
  if (position !== null) {
    const halfPoints = Number(attrOf(position, 'w:val') ?? '');
    if (!Number.isFinite(halfPoints) || Math.abs(halfPoints) / 2 > 2 * fontPt) {
      note('raised-text');
    }
  }

  const vanish = vanishOf(layers);
  if (vanish.ambiguous) {
    note('vanish-toggle-disagreement');
  }

  const background = (usePage: boolean, report: boolean): Fill => {
    const steps: Array<[UnknownReason, Fill]> = [
      ['unreadable-shading', shadingOf(pick(layers, 'w:shd'), theme)],
      ['unreadable-highlight', highlightOf(pick(layers, 'w:highlight'))],
      ['unreadable-shading', shadingOf(input.paragraphShd, theme)],
      ['unreadable-shading', shadingOf(input.cellShd, theme)],
      ['unreadable-shading', usePage ? fillOf(input.pageBackground) : TRANSPARENT],
    ];

    for (const [reason, fill] of steps) {
      if (fill.kind === 'unknown') {
        if (report) {
          note(fill.themeMissing ? 'theme-part-missing' : reason);
        }
        return fill;
      }
      if (fill.kind === 'value') {
        return fill;
      }
    }

    return TRANSPARENT;
  };

  const styleWith = (usePage: boolean, report: boolean): Style => {
    const style: Style = {};
    if (colour !== null && colour.kind === 'value') {
      style.color = toCss(colour.rgb);
    }
    if (colour !== null && colour.kind === 'auto') {
      style.color = 'auto';
    }
    const fill = background(usePage, report);
    if (fill.kind === 'value') {
      style.background = toCss(fill.rgb);
    }
    if (sizePt !== null) {
      style.sizePt = sizePt;
    }
    if (vanish.hidden && !vanish.ambiguous) {
      style.hidden = true;
    }
    return style;
  };

  const style = styleWith(input.showsBackgroundShape, true);
  const layerFor = (candidate: Style): string =>
    classifyRun(
      { id: input.id, text: input.text, source: input.source, style: candidate },
      RULESET_V1,
    ).layer;

  if (layerFor(styleWith(true, false)) !== layerFor(styleWith(false, false))) {
    note('background-shape-dependent');
  }

  return { id: input.id, text: input.text, source: input.source, style, unknown };
};

export const mainPartName = (parts: readonly ZipEntry[]): string => {
  if (findPart(parts, '_rels/.rels') === null) {
    return refuse('no-package-rels', 'the package carries no _rels/.rels');
  }
  const target = relationshipTarget(parts, '_rels/.rels', '', 'officeDocument');
  if (target === null) {
    return refuse('no-main-part', 'no relationship names the main document part', '_rels/.rels');
  }
  return target;
};

export const resolveRuns = (parts: readonly ZipEntry[]): ResolvedRun[] => {
  const mainName = mainPartName(parts);
  const main = findPart(parts, mainName);
  if (main === null) {
    return refuse('no-main-part', 'the relationship names a part that is not here', mainName);
  }

  const base = dirOf(mainName);
  const relsName = `${base}_rels/${mainName.slice(base.length)}.rels`;
  const related = (suffix: string, fallback: string): ZipEntry | null =>
    findPart(parts, relationshipTarget(parts, relsName, base, suffix) ?? fallback);

  const read = (part: ZipEntry | null): Element | null =>
    part === null ? null : parseTree(textOf(part), WORDPROCESSINGML_NAMESPACES);

  const settings = read(related('settings', `${base}settings.xml`));
  const themePart = related('theme', `${base}theme/theme1.xml`);
  const theme: Theme =
    themePart === null
      ? null
      : { colours: themeColoursOf(textOf(themePart)), mapping: mappingOf(settings) };
  const styles = stylesOf(read(related('styles', `${base}styles.xml`)));
  const showsBackgroundShape = onOff(childOf(settings, 'w:displayBackgroundShape')) ?? false;

  const document = parseTree(textOf(main), WORDPROCESSINGML_NAMESPACES);
  const pageBackground = colourOf(childOf(document, 'w:background'), theme, BACKGROUND_KEYS);
  const body = childOf(document, 'w:body') ?? document;

  const runs: ResolvedRun[] = [];
  let offset = 0;
  let index = 0;

  eachParagraph(body, null, (paragraph, cellShd) => {
    const pPr = childOf(paragraph, 'w:pPr');
    const paragraphShd = childOf(pPr, 'w:shd');
    const paragraphStyle = attrOf(childOf(pPr, 'w:pStyle'), 'w:val');

    eachRun(paragraph, (run) => {
      const text = runText(run);
      if (text === '') {
        return;
      }
      index += 1;
      const source: SourceSpan = { part: mainName, start: offset, end: offset + text.length };
      offset += text.length;

      runs.push(
        resolveRun({
          id: `r${index}`,
          text,
          source,
          layers: layersFor(styles, paragraphStyle, run),
          paragraphShd,
          cellShd,
          theme,
          pageBackground,
          showsBackgroundShape,
        }),
      );
    });
  });

  return runs;
};

export const styledRunsOf = (runs: readonly ResolvedRun[]): StyledRun[] =>
  runs.map((run) => ({
    id: run.id,
    text: run.text,
    source: run.source,
    style: run.unknown.length > 0 ? { color: UNRESOLVED_COLOR } : run.style,
  }));
