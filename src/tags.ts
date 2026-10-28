import type { Location } from './layers.ts';
import type { Finding } from './route.ts';

const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;
const TAG_PRINTABLE_FIRST = 0xe0020;
const TAG_PRINTABLE_LAST = 0xe007e;
const TAG_DIGIT_FIRST = 0xe0030;
const TAG_DIGIT_LAST = 0xe0039;
const TAG_LETTER_FIRST = 0xe0061;
const TAG_LETTER_LAST = 0xe007a;
const LANGUAGE_TAG = 0xe0001;
const CANCEL_TAG = 0xe007f;
const WAVING_BLACK_FLAG = 0x1f3f4;
const ASCII_SHIFT = TAG_FIRST;

export type TagChar = {
  codePoint: number;
  offset: number;
};

export type TagRun = {
  start: number;
  end: number;
  chars: TagChar[];
  payload: string;
  subdivisionFlag: boolean;
};

export type TagPayloadSegment = {
  text: string;
  start: number;
  end: number;
};

const NAMED_TAGS = new Map<number, string>([
  [LANGUAGE_TAG, 'language-tag'],
  [CANCEL_TAG, 'cancel-tag'],
]);

const isTag = (codePoint: number): boolean => codePoint >= TAG_FIRST && codePoint <= TAG_LAST;

const isPrintableTag = (codePoint: number): boolean =>
  codePoint >= TAG_PRINTABLE_FIRST && codePoint <= TAG_PRINTABLE_LAST;

const isSubdivisionTag = (codePoint: number): boolean =>
  (codePoint >= TAG_LETTER_FIRST && codePoint <= TAG_LETTER_LAST) ||
  (codePoint >= TAG_DIGIT_FIRST && codePoint <= TAG_DIGIT_LAST);

const decode = (chars: readonly TagChar[]): string =>
  chars
    .filter((char) => isPrintableTag(char.codePoint))
    .map((char) => String.fromCodePoint(char.codePoint - ASCII_SHIFT))
    .join('');

const spellsASubdivision = (chars: readonly TagChar[]): boolean => {
  const last = chars[chars.length - 1];
  if (chars.length < 2 || last === undefined || last.codePoint !== CANCEL_TAG) {
    return false;
  }
  return chars.slice(0, -1).every((char) => isSubdivisionTag(char.codePoint));
};

const tagName = (codePoint: number): string | null => {
  const named = NAMED_TAGS.get(codePoint);
  if (named !== undefined) {
    return named;
  }
  return isPrintableTag(codePoint) ? null : 'reserved-tag-character';
};

const label = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

type Unit = { codePoint: number; offset: number; length: number };

const unitsOf = (text: string): Unit[] => {
  const units: Unit[] = [];
  let offset = 0;
  for (const char of text) {
    units.push({ codePoint: char.codePointAt(0)!, offset, length: char.length });
    offset += char.length;
  }
  return units;
};

// Runs are found on the layer text, not per styled run, so a payload a parser splits across two
// DOCX runs still decodes as one payload.
export const scanTags = (text: string): TagRun[] => {
  const units = unitsOf(text);
  const runs: TagRun[] = [];
  let index = 0;

  while (index < units.length) {
    const unit = units[index];
    if (unit === undefined) {
      break;
    }
    if (!isTag(unit.codePoint)) {
      index += 1;
      continue;
    }

    const before = units[index - 1]?.codePoint;
    const chars: TagChar[] = [];
    let end = unit.offset;

    while (index < units.length) {
      const next = units[index];
      if (next === undefined || !isTag(next.codePoint)) {
        break;
      }
      chars.push({ codePoint: next.codePoint, offset: next.offset });
      end = next.offset + next.length;
      index += 1;
    }

    runs.push({
      start: unit.offset,
      end,
      chars,
      payload: decode(chars),
      subdivisionFlag: before === WAVING_BLACK_FLAG && spellsASubdivision(chars),
    });
  }

  return runs;
};

export const tagPayloadSegments = (text: string): TagPayloadSegment[] =>
  scanTags(text)
    .filter((run) => !run.subdivisionFlag && run.payload !== '')
    .map((run) => ({ text: run.payload, start: run.start, end: run.end }));

export const tagFindings = (
  text: string,
  locateOffset?: (offset: number) => Location | null,
): Finding[] => {
  const findings: Finding[] = [];

  const report = (summary: string, offset: number): void => {
    const finding: Finding = { construct: 'tag-characters', tier: 'review', summary };
    const where = locateOffset?.(offset) ?? null;
    if (where !== null) {
      finding.where = where;
    }
    findings.push(finding);
  };

  for (const run of scanTags(text)) {
    if (run.subdivisionFlag) {
      continue;
    }

    if (run.payload !== '') {
      report(`tag-payload "${run.payload}" at offsets ${run.start}-${run.end}`, run.start);
    }

    for (const char of run.chars) {
      const name = tagName(char.codePoint);
      if (name !== null) {
        report(`${name} (${label(char.codePoint)}) at offset ${char.offset}`, char.offset);
      }
    }
  }

  return findings;
};
