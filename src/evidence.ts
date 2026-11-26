import { unresolvedRunIds } from './export.ts';
import type { VisibilityDecision } from './export.ts';
import { RULESET_V1, separateLayers } from './layers.ts';
import type { Construct, Finding, FindingTier, ReviewPriority, Route, RouteKind } from './route.ts';
import type { StyledRun } from './runs.ts';

export const EVIDENCE_SCHEMA = 'screenfence.evidence/1';

export const CODE_POINTS_RULESET = 'codepoints-v1';

export const PHRASES_RULESET = 'phrases-v1';

export const INPUT_KINDS = ['docx', 'text'] as const;

export type InputKind = (typeof INPUT_KINDS)[number];

export type InspectedDocument = {
  kind: InputKind;
  runs: readonly StyledRun[];
  decisions: readonly VisibilityDecision[];
  findings: readonly Finding[];
};

export type EvidenceFinding = {
  construct: Construct;
  offset: number | null;
  part: string | null;
  runId: string | null;
  summary: string;
  tier: FindingTier;
};

export type EvidenceRoute = {
  causes: number;
  checked: Construct[];
  kind: RouteKind;
  notChecked: Construct[];
  priority: ReviewPriority | null;
};

export type EvidenceRulesets = {
  codePoints: string;
  contrastThreshold: number;
  layers: string;
  phrases: string;
};

export type EvidenceCounts = {
  characters: { hidden: number; unknown: number; visible: number };
  findings: { info: number; notice: number; review: number; total: number };
  runs: { hidden: number; total: number; unknown: number; visible: number };
};

export type EvidenceRecord = {
  at: string;
  counts: EvidenceCounts;
  decisions: VisibilityDecision[];
  findings: EvidenceFinding[];
  input: { kind: InputKind; parts: string[] };
  route: EvidenceRoute;
  rulesets: EvidenceRulesets;
  schema: typeof EVIDENCE_SCHEMA;
  undecided: string[];
  visibleText: { characters: number; sha256: string };
};

const encoder = new TextEncoder();

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const canonical = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => canonical(item)) as unknown as T;
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      ordered[key] = canonical(source[key]);
    }
    return ordered as unknown as T;
  }
  return value;
};

// Code-unit order rather than localeCompare, so the record does not depend on the host locale.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const findingOf = (finding: Finding): EvidenceFinding => ({
  construct: finding.construct,
  offset: finding.where?.offset ?? null,
  part: finding.where?.part ?? null,
  runId: finding.where?.runId ?? null,
  summary: finding.summary,
  tier: finding.tier,
});

const countsOf = (
  doc: InspectedDocument,
  characters: { hidden: number; unknown: number; visible: number },
  runs: { hidden: number; unknown: number; visible: number },
): EvidenceCounts => {
  const tier = (name: FindingTier): number =>
    doc.findings.filter((finding) => finding.tier === name).length;

  return {
    characters,
    findings: {
      info: tier('info'),
      notice: tier('notice'),
      review: tier('review'),
      total: doc.findings.length,
    },
    runs: { ...runs, total: doc.runs.length },
  };
};

export const buildEvidence = async (
  doc: InspectedDocument,
  decision: Route,
  options: { at: string },
): Promise<EvidenceRecord> => {
  const layers = separateLayers(doc.runs, RULESET_V1);

  const record: EvidenceRecord = {
    at: options.at,
    counts: countsOf(
      doc,
      {
        hidden: layers.hidden.text.length,
        unknown: layers.unknown.text.length,
        visible: layers.visible.text.length,
      },
      {
        hidden: layers.hidden.segments.length,
        unknown: layers.unknown.segments.length,
        visible: layers.visible.segments.length,
      },
    ),
    decisions: [...doc.decisions].sort((a, b) => byText(a.runId, b.runId) || byText(a.at, b.at)),
    findings: doc.findings.map(findingOf),
    input: {
      kind: doc.kind,
      parts: [...new Set(doc.runs.map((run) => run.source.part))].sort(byText),
    },
    route: {
      causes: decision.kind === 'human-review' ? decision.findings.length : 0,
      checked: decision.kind === 'no-findings' ? [...decision.checked] : [],
      kind: decision.kind,
      notChecked: decision.kind === 'no-findings' ? [...decision.notChecked] : [],
      priority: decision.kind === 'human-review' ? decision.priority : null,
    },
    rulesets: {
      codePoints: CODE_POINTS_RULESET,
      contrastThreshold: RULESET_V1.minContrast,
      layers: RULESET_V1.name,
      phrases: PHRASES_RULESET,
    },
    schema: EVIDENCE_SCHEMA,
    undecided: unresolvedRunIds({ runs: doc.runs, decisions: doc.decisions }),
    visibleText: {
      characters: layers.visible.text.length,
      sha256: await sha256Hex(layers.visible.text),
    },
  };

  return canonical(record);
};

const CONSTRUCT_WORDS: Record<Construct, string> = {
  'layer-separation': 'text held apart from the visible page',
  'invisible-code-points': 'characters a reader cannot see',
  'tag-characters': 'invisible tag characters carrying text',
  'instruction-text': 'text written as an instruction',
  'text-behind-image': 'text behind an image',
  'off-page-frame': 'a frame outside the page',
  'image-colour-match': 'text the colour of the image behind it',
  'overpainted-shape': 'text painted over by a shape',
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const locationOf = (finding: EvidenceFinding): string => {
  if (finding.part === null) {
    return 'with no place recorded';
  }
  const where = [`in ${finding.part}`];
  if (finding.runId !== null) {
    where.push(`run ${finding.runId}`);
  }
  if (finding.offset !== null) {
    where.push(`at offset ${finding.offset}`);
  }
  return where.join(', ');
};

export const explainForCandidate = (record: EvidenceRecord): string => {
  const lines: string[] = [
    `This is the record of an automated check of your document, made at ${record.at}.`,
    '',
    'The check reads the page the way a reader sees it, separates text that was made invisible, ' +
      'and reports what it found.',
    '',
  ];

  if (record.findings.length === 0) {
    lines.push('The check found nothing to report.');
  } else {
    lines.push(`The check found ${plural(record.findings.length, 'thing', 'things')}:`);
    record.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${CONSTRUCT_WORDS[finding.construct]}, ${locationOf(finding)}.`);
      lines.push(`   Recorded as: ${finding.summary}`);
    });
  }

  lines.push('');
  lines.push(
    `The document holds ${record.counts.characters.visible} characters of visible text, ` +
      `${record.counts.characters.hidden} characters of text hidden on the page and ` +
      `${record.counts.characters.unknown} characters the check could not read with confidence.`,
  );

  if (record.undecided.length > 0) {
    lines.push(
      `${plural(record.undecided.length, 'run', 'runs')} of text could not be read with ` +
        `confidence and are waiting for a person: ${record.undecided.join(', ')}.`,
    );
  }

  if (record.decisions.length > 0) {
    lines.push(
      `A person has recorded a reading for ${plural(record.decisions.length, 'run', 'runs')}:`,
    );
    for (const decision of record.decisions) {
      lines.push(
        `- run ${decision.runId} read as ${decision.as}, by ${decision.by}, at ${decision.at}`,
      );
    }
  }

  lines.push('');
  lines.push(
    record.route.kind === 'human-review'
      ? `This document was sent to a person to read it (priority: ${record.route.priority}).`
      : 'Nothing here needed a person, so this document was not sent on for review.',
  );
  lines.push(
    'This check never rejects a document: it only separates what can be seen from what cannot, ' +
      'and hands anything doubtful to a person.',
  );

  return lines.join('\n');
};
