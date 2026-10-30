import { RULESET_V1, classifyRun } from './layers.ts';
import type { Location, Ruleset } from './layers.ts';
import type { Style, StyledRun } from './runs.ts';

export const ROUTE_KINDS = ['human-review', 'no-findings'] as const;

export type RouteKind = (typeof ROUTE_KINDS)[number];

export const CONSTRUCTS = [
  'layer-separation',
  'invisible-code-points',
  'tag-characters',
  'instruction-text',
  'text-behind-image',
  'off-page-frame',
  'image-colour-match',
  'overpainted-shape',
] as const;

export type Construct = (typeof CONSTRUCTS)[number];

const UNCHECKED_CONSTRUCTS: readonly Construct[] = [
  'text-behind-image',
  'off-page-frame',
  'image-colour-match',
  'overpainted-shape',
];

export const FINDING_TIERS = ['info', 'notice', 'review'] as const;

export type FindingTier = (typeof FINDING_TIERS)[number];

export type Finding = {
  construct: Construct;
  tier: FindingTier;
  summary: string;
  where?: Location;
};

export type Coverage = {
  styled: boolean;
  unknownRuns: number;
};

export type ReviewPriority = 'standard' | 'high';

export type HumanReviewRoute = {
  kind: 'human-review';
  priority: ReviewPriority;
  findings: Finding[];
};

export type NoFindingsRoute = {
  kind: 'no-findings';
  checked: Construct[];
  notChecked: Construct[];
};

export type Route = HumanReviewRoute | NoFindingsRoute;

const carriesStyle = (style: Style): boolean =>
  style.color !== undefined ||
  style.background !== undefined ||
  style.sizePt !== undefined ||
  style.hidden !== undefined;

export const coverageOf = (
  runs: readonly StyledRun[],
  ruleset: Ruleset = RULESET_V1,
): Coverage => {
  let styled = false;
  let unknownRuns = 0;

  for (const run of runs) {
    if (carriesStyle(run.style)) {
      styled = true;
    }
    if (classifyRun(run, ruleset).layer === 'unknown') {
      unknownRuns += 1;
    }
  }

  return { styled, unknownRuns };
};

const notCheckedFor = (coverage: Coverage): Construct[] =>
  CONSTRUCTS.filter(
    (construct) =>
      UNCHECKED_CONSTRUCTS.includes(construct) ||
      (construct === 'layer-separation' && !coverage.styled),
  );

export const route = (findings: readonly Finding[], coverage: Coverage): Route => {
  const causes = findings.filter((finding) => finding.tier === 'review');

  if (causes.length > 0) {
    return { kind: 'human-review', priority: 'high', findings: causes };
  }

  const notices = findings.filter((finding) => finding.tier === 'notice');

  if (notices.length > 0) {
    return { kind: 'human-review', priority: 'standard', findings: notices };
  }

  if (coverage.unknownRuns > 0) {
    return { kind: 'human-review', priority: 'standard', findings: [] };
  }

  const notChecked = notCheckedFor(coverage);

  return {
    kind: 'no-findings',
    checked: CONSTRUCTS.filter((construct) => !notChecked.includes(construct)),
    notChecked,
  };
};
