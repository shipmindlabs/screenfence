import { scanCodePoints } from './codepoints.ts';
import { locate } from './layers.ts';
import type { Location, SeparatedLayers } from './layers.ts';
import type { Finding, FindingTier } from './route.ts';
import { tagPayloadSegments } from './tags.ts';

export const PHRASE_CATEGORIES = [
  'override',
  'address-to-model',
  'verdict',
  'chat-marker',
] as const;

export type PhraseCategory = (typeof PHRASE_CATEGORIES)[number];

export type Phrase = {
  id: string;
  category: PhraseCategory;
  pattern: RegExp;
};

export const INSTRUCTION_SITES = ['visible', 'hidden', 'unknown', 'tag-payload'] as const;

export type InstructionSite = (typeof INSTRUCTION_SITES)[number];

export type PhraseMatch = {
  id: string;
  category: PhraseCategory;
  start: number;
  end: number;
  quote: string;
};

export type PhraseScope = {
  site: InstructionSite;
  text: string;
  locateOffset?: (offset: number) => Location | null;
};

export const PHRASES_V1: readonly Phrase[] = [
  {
    id: 'override.ignore-previous-instructions',
    category: 'override',
    pattern:
      /\bignore (?:all |any )?(?:the )?(?:previous|prior|preceding|above|earlier) instructions\b/gu,
  },
  {
    id: 'override.disregard-the-above',
    category: 'override',
    pattern: /\bdisregard (?:all |any )?(?:the )?(?:above|previous|prior|earlier)\b/gu,
  },
  {
    id: 'override.these-instructions-take-priority',
    category: 'override',
    pattern: /\b(?:these|the following) instructions? (?:take|takes) (?:priority|precedence)\b/gu,
  },
  {
    id: 'address-to-model.you-are-an-ai',
    category: 'address-to-model',
    pattern: /\byou are (?:an|a) (?:ai|artificial intelligence|language model|llm)\b/gu,
  },
  {
    id: 'address-to-model.as-a-language-model',
    category: 'address-to-model',
    pattern: /\bas (?:an|a) (?:ai|language model|llm)\b/gu,
  },
  {
    id: 'address-to-model.note-to-the-ai',
    category: 'address-to-model',
    pattern: /\b(?:note|message|memo) to (?:the )?(?:ai|llm|language model|screener)\b/gu,
  },
  {
    id: 'verdict.recommend-this-candidate',
    category: 'verdict',
    pattern: /\b(?:recommend|endorse) (?:this|the) (?:candidate|applicant|resume|cv)\b/gu,
  },
  {
    id: 'verdict.rank-this-candidate-first',
    category: 'verdict',
    pattern:
      /\b(?:rank|rate|place|list) (?:this|the) (?:candidate|applicant|resume|cv) (?:first|highest|top)\b/gu,
  },
  {
    id: 'verdict.advance-to-the-next-round',
    category: 'verdict',
    pattern:
      /\badvance (?:this |the )?(?:candidate |applicant )?to the next (?:round|stage|step)\b/gu,
  },
  // A turn label that follows a word is prose ('operating system:'), not a chat marker.
  {
    id: 'chat-marker.system-label',
    category: 'chat-marker',
    pattern: /(?<![a-z] )\bsystem ?:/gu,
  },
  {
    id: 'chat-marker.assistant-label',
    category: 'chat-marker',
    pattern: /(?<![a-z] )\bassistant ?:/gu,
  },
  {
    id: 'chat-marker.chatml-turn',
    category: 'chat-marker',
    pattern: /<\|im_(?:start|end)\|>/gu,
  },
];

type Mapped = {
  text: string;
  starts: readonly number[];
  ends: readonly number[];
};

const WHITESPACE = /^\s$/u;

const normalise = (source: string): Mapped => {
  const flagged = new Set<number>();
  for (const found of scanCodePoints(source)) {
    if (found.tier === 'flag') {
      flagged.add(found.offset);
    }
  }

  const pieces: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  let spaceStart = -1;
  let spaceEnd = -1;

  const flushSpace = (): void => {
    if (spaceStart < 0) {
      return;
    }
    pieces.push(' ');
    starts.push(spaceStart);
    ends.push(spaceEnd);
    spaceStart = -1;
  };

  for (const char of source) {
    const start = offset;
    const end = start + char.length;
    offset = end;

    if (flagged.has(start)) {
      continue;
    }

    if (WHITESPACE.test(char)) {
      if (spaceStart < 0) {
        spaceStart = start;
      }
      spaceEnd = end;
      continue;
    }

    flushSpace();

    // NFKC runs per code point, so every unit of the result maps back to one source span.
    const folded = char.normalize('NFKC').toLowerCase();
    pieces.push(folded);
    for (let unit = 0; unit < folded.length; unit += 1) {
      starts.push(start);
      ends.push(end);
    }
  }

  flushSpace();

  return { text: pieces.join(''), starts, ends };
};

const sourceSpan = (
  mapped: Mapped,
  index: number,
  length: number,
): { start: number; end: number } | null => {
  const start = mapped.starts[index];
  const end = mapped.ends[index + length - 1];
  if (start === undefined || end === undefined) {
    return null;
  }
  return { start, end };
};

export const matchPhrases = (
  text: string,
  phrases: readonly Phrase[] = PHRASES_V1,
): PhraseMatch[] => {
  const mapped = normalise(text);
  const matches: PhraseMatch[] = [];

  for (const phrase of phrases) {
    for (const match of mapped.text.matchAll(phrase.pattern)) {
      const matched = match[0] ?? '';
      if (matched === '') {
        continue;
      }
      const span = sourceSpan(mapped, match.index ?? 0, matched.length);
      if (span === null) {
        continue;
      }
      matches.push({
        id: phrase.id,
        category: phrase.category,
        start: span.start,
        end: span.end,
        quote: text.slice(span.start, span.end),
      });
    }
  }

  return matches.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
};

const SITE_TIERS: Record<InstructionSite, FindingTier> = {
  visible: 'notice',
  hidden: 'review',
  unknown: 'review',
  'tag-payload': 'review',
};

const SITE_LABELS: Record<InstructionSite, string> = {
  visible: 'the visible layer',
  hidden: 'the hidden layer',
  unknown: 'the unknown layer',
  'tag-payload': 'a tag payload',
};

export const phraseFindings = (scopes: readonly PhraseScope[]): Finding[] => {
  const findings: Finding[] = [];

  const push = (finding: Finding, scope: PhraseScope, offset: number): void => {
    const where = scope.locateOffset?.(offset) ?? null;
    if (where !== null) {
      finding.where = where;
    }
    findings.push(finding);
  };

  for (const scope of scopes) {
    const matches = matchPhrases(scope.text);

    for (const match of matches) {
      push(
        {
          construct: 'instruction-text',
          tier: SITE_TIERS[scope.site],
          summary: `${match.id} "${match.quote}" at offsets ${match.start}-${match.end} in ${SITE_LABELS[scope.site]}`,
        },
        scope,
        match.start,
      );
    }

    if (scope.site === 'hidden' && matches.length === 0 && scope.text.trim() !== '') {
      push(
        {
          construct: 'layer-separation',
          tier: 'notice',
          summary: `hidden text with no instruction match (${scope.text.length} characters)`,
        },
        scope,
        0,
      );
    }
  }

  return findings;
};

export const phraseScopes = (layers: SeparatedLayers): PhraseScope[] => {
  const scopes: PhraseScope[] = [];

  for (const site of ['visible', 'hidden', 'unknown'] as const) {
    const layer = layers[site];
    scopes.push({
      site,
      text: layer.text,
      locateOffset: (offset) => locate(layer, offset),
    });

    for (const segment of tagPayloadSegments(layer.text)) {
      scopes.push({
        site: 'tag-payload',
        text: segment.text,
        locateOffset: () => locate(layer, segment.start),
      });
    }
  }

  return scopes;
};
