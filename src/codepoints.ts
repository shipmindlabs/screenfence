import type { Location } from './layers.ts';
import type { Finding } from './route.ts';

export const CODE_POINT_TIERS = ['flag', 'info'] as const;

export type CodePointTier = (typeof CODE_POINT_TIERS)[number];

export type CodePointFinding = {
  offset: number;
  codePoint: number;
  name: string;
  tier: CodePointTier;
};

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const BOM = 0xfeff;
const VS1 = 0xfe00;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const VS17 = 0xe0100;
const VS256 = 0xe01ef;
const KEYCAP = 0x20e3;

const FLAG_NAMES = new Map<number, string>([
  [0x034f, 'combining-grapheme-joiner'],
  [0x115f, 'hangul-choseong-filler'],
  [0x1160, 'hangul-jungseong-filler'],
  [0x200b, 'zero-width-space'],
  [0x202a, 'left-to-right-embedding'],
  [0x202b, 'right-to-left-embedding'],
  [0x202c, 'pop-directional-formatting'],
  [0x202d, 'left-to-right-override'],
  [0x202e, 'right-to-left-override'],
  [0x2060, 'word-joiner'],
  [0x2061, 'function-application'],
  [0x2062, 'invisible-times'],
  [0x2063, 'invisible-separator'],
  [0x2064, 'invisible-plus'],
  [0x2066, 'left-to-right-isolate'],
  [0x2067, 'right-to-left-isolate'],
  [0x2068, 'first-strong-isolate'],
  [0x2069, 'pop-directional-isolate'],
  [0x3164, 'hangul-filler'],
  [0xffa0, 'halfwidth-hangul-filler'],
]);

const INFO_NAMES = new Map<number, string>([
  [0x00a0, 'no-break-space'],
  [0x00ad, 'soft-hyphen'],
  [0x2009, 'thin-space'],
  [0x2013, 'en-dash'],
  [0x2014, 'em-dash'],
  [0x2018, 'left-single-quotation-mark'],
  [0x2019, 'right-single-quotation-mark'],
  [0x201c, 'left-double-quotation-mark'],
  [0x201d, 'right-double-quotation-mark'],
  [0x2026, 'horizontal-ellipsis'],
  [0x202f, 'narrow-no-break-space'],
]);

const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const EMOJI_SEQUENCE_FILLER = /^(?:\p{Emoji_Modifier}|\ufe0f)$/u;
const HAN = /^\p{Script=Han}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;

const SPELLING_SCRIPTS: readonly RegExp[] = [
  /^\p{Script=Arabic}$/u,
  /^\p{Script=Devanagari}$/u,
  /^\p{Script=Bengali}$/u,
  /^\p{Script=Gurmukhi}$/u,
  /^\p{Script=Gujarati}$/u,
  /^\p{Script=Tamil}$/u,
  /^\p{Script=Telugu}$/u,
  /^\p{Script=Kannada}$/u,
  /^\p{Script=Malayalam}$/u,
  /^\p{Script=Sinhala}$/u,
];

type Unit = { char: string; codePoint: number; offset: number };

const unitsOf = (text: string): Unit[] => {
  const units: Unit[] = [];
  let offset = 0;
  for (const char of text) {
    units.push({ char, codePoint: char.codePointAt(0)!, offset });
    offset += char.length;
  }
  return units;
};

const charAt = (units: readonly Unit[], index: number): string => units[index]?.char ?? '';

const neighbour = (units: readonly Unit[], index: number, step: -1 | 1, skip: RegExp): string => {
  for (let i = index + step; i >= 0 && i < units.length; i += step) {
    const char = charAt(units, i);
    if (!skip.test(char)) {
      return char;
    }
  }
  return '';
};

// An Indic joiner sits after a virama or another mark, so the letters are not the direct neighbours.
const spellsAWord = (units: readonly Unit[], index: number): boolean => {
  const before = neighbour(units, index, -1, MARK);
  const after = neighbour(units, index, 1, MARK);
  if (!LETTER.test(before) || !LETTER.test(after)) {
    return false;
  }
  return SPELLING_SCRIPTS.some((script) => script.test(before) && script.test(after));
};

const joinsPictographs = (units: readonly Unit[], index: number): boolean =>
  PICTOGRAPH.test(neighbour(units, index, -1, EMOJI_SEQUENCE_FILLER)) &&
  PICTOGRAPH.test(charAt(units, index + 1));

const isVariationSelector = (codePoint: number): boolean =>
  (codePoint >= VS1 && codePoint <= VS16) || (codePoint >= VS17 && codePoint <= VS256);

const variationSelectorName = (codePoint: number): string =>
  `variation-selector-${codePoint <= VS16 ? codePoint - VS1 + 1 : codePoint - VS17 + 17}`;

const inAValidSequence = (units: readonly Unit[], index: number, codePoint: number): boolean => {
  const before = charAt(units, index - 1);

  if (codePoint === VS16 && KEYCAP_BASE.test(before) && units[index + 1]?.codePoint === KEYCAP) {
    return true;
  }

  if ((codePoint === VS15 || codePoint === VS16) && PICTOGRAPH.test(before)) {
    return true;
  }

  return HAN.test(before);
};

const nfcDifference = (units: readonly Unit[], index: number, unit: Unit): string | null => {
  if (unit.char.normalize('NFC') !== unit.char) {
    return 'nfc-singleton-difference';
  }

  if (!MARK.test(unit.char)) {
    return null;
  }

  const before = charAt(units, index - 1);
  const pair = before + unit.char;

  return before !== '' && pair.normalize('NFC') !== pair ? 'nfc-decomposed-sequence' : null;
};

export const scanCodePoints = (text: string): CodePointFinding[] => {
  const units = unitsOf(text);
  const found: CodePointFinding[] = [];

  const report = (unit: Unit, name: string, tier: CodePointTier): void => {
    found.push({ offset: unit.offset, codePoint: unit.codePoint, name, tier });
  };

  units.forEach((unit, index) => {
    const flagged = FLAG_NAMES.get(unit.codePoint);
    if (flagged !== undefined) {
      report(unit, flagged, 'flag');
      return;
    }

    if (unit.codePoint === BOM) {
      if (unit.offset > 0) {
        report(unit, 'byte-order-mark', 'flag');
      }
      return;
    }

    if (unit.codePoint === ZWNJ || unit.codePoint === ZWJ) {
      const exempt =
        spellsAWord(units, index) || (unit.codePoint === ZWJ && joinsPictographs(units, index));
      if (!exempt) {
        const name = unit.codePoint === ZWNJ ? 'zero-width-non-joiner' : 'zero-width-joiner';
        report(unit, name, 'flag');
      }
      return;
    }

    if (isVariationSelector(unit.codePoint)) {
      if (!inAValidSequence(units, index, unit.codePoint)) {
        report(unit, variationSelectorName(unit.codePoint), 'flag');
      }
      return;
    }

    const typography = INFO_NAMES.get(unit.codePoint);
    if (typography !== undefined) {
      report(unit, typography, 'info');
      return;
    }

    const nfc = nfcDifference(units, index, unit);
    if (nfc !== null) {
      report(unit, nfc, 'info');
    }
  });

  return found;
};

const label = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

export const codePointFindings = (
  text: string,
  locateOffset?: (offset: number) => Location | null,
): Finding[] =>
  scanCodePoints(text).map((found) => {
    const finding: Finding = {
      construct: 'invisible-code-points',
      tier: found.tier === 'flag' ? 'review' : 'info',
      summary: `${found.name} (${label(found.codePoint)}) at offset ${found.offset}`,
    };

    const where = locateOffset?.(found.offset) ?? null;
    if (where !== null) {
      finding.where = where;
    }

    return finding;
  });
