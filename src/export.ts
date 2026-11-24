import { classifyRun } from './layers.ts';
import type { SourceSpan, StyledRun } from './runs.ts';

export const VISIBILITY_VERDICTS = ['visible', 'hidden'] as const;

export type VisibilityVerdict = (typeof VISIBILITY_VERDICTS)[number];

export type VisibilityDecision = {
  runId: string;
  as: VisibilityVerdict;
  by: string;
  at: string;
};

export type VisibilityDocument = {
  runs: readonly StyledRun[];
  decisions: readonly VisibilityDecision[];
};

export type ExportSegment = {
  runId: string;
  text: string;
  source: SourceSpan;
  start: number;
  end: number;
  decision: VisibilityDecision | null;
};

export type VisibleExport = {
  text: string;
  segments: ExportSegment[];
};

export const RESOLUTION_REFUSAL_CODES = [
  'no-such-run',
  'not-unknown-run',
  'no-decider',
  'already-decided',
] as const;

export type ResolutionRefusalCode = (typeof RESOLUTION_REFUSAL_CODES)[number];

export class ResolutionRefusal extends Error {
  code: ResolutionRefusalCode;
  runId: string;

  constructor(code: ResolutionRefusalCode, runId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ResolutionRefusal';
    this.code = code;
    this.runId = runId;
  }
}

export class UnresolvedVisibilityError extends Error {
  runIds: string[];

  constructor(runIds: readonly string[]) {
    super(`unresolved-visibility: ${runIds.join(', ')} await a decision`);
    this.name = 'UnresolvedVisibilityError';
    this.runIds = [...runIds];
  }
}

const isUnknown = (run: StyledRun): boolean => classifyRun(run).layer === 'unknown';

const decisionsById = (doc: VisibilityDocument): Map<string, VisibilityDecision> =>
  new Map(doc.decisions.map((decision): [string, VisibilityDecision] => [decision.runId, decision]));

export const documentOf = (runs: readonly StyledRun[]): VisibilityDocument => ({
  runs: [...runs],
  decisions: [],
});

export const unresolvedRunIds = (doc: VisibilityDocument): string[] => {
  const decided = decisionsById(doc);
  return doc.runs.filter((run) => isUnknown(run) && !decided.has(run.id)).map((run) => run.id);
};

export const exportVisible = (doc: VisibilityDocument): VisibleExport => {
  const waiting = unresolvedRunIds(doc);

  if (waiting.length > 0) {
    throw new UnresolvedVisibilityError(waiting);
  }

  const decided = decisionsById(doc);
  const chunks: string[] = [];
  const segments: ExportSegment[] = [];
  let length = 0;

  for (const run of doc.runs) {
    const decision = decided.get(run.id) ?? null;
    const shows =
      decision === null ? classifyRun(run).layer === 'visible' : decision.as === 'visible';

    if (!shows) {
      continue;
    }

    const start = length;
    chunks.push(run.text);
    length = start + run.text.length;
    segments.push({
      runId: run.id,
      text: run.text,
      source: { part: run.source.part, start: run.source.start, end: run.source.end },
      start,
      end: length,
      decision,
    });
  }

  return { text: chunks.join(''), segments };
};

// Every refusal is raised before the new document is built, so a refused call resolves nothing.
export const resolveUnknown = (
  doc: VisibilityDocument,
  decisions: readonly VisibilityDecision[],
): VisibilityDocument => {
  const runs = new Map(doc.runs.map((run): [string, StyledRun] => [run.id, run]));
  const decided = decisionsById(doc);
  const added: VisibilityDecision[] = [];

  for (const decision of decisions) {
    const run = runs.get(decision.runId);

    if (run === undefined) {
      throw new ResolutionRefusal(
        'no-such-run',
        decision.runId,
        `the document carries no run ${decision.runId}`,
      );
    }

    if (!isUnknown(run)) {
      throw new ResolutionRefusal(
        'not-unknown-run',
        decision.runId,
        `run ${decision.runId} is not in the unknown layer`,
      );
    }

    if (decision.by.trim() === '') {
      throw new ResolutionRefusal(
        'no-decider',
        decision.runId,
        `the decision on run ${decision.runId} names nobody`,
      );
    }

    if (decided.has(decision.runId)) {
      throw new ResolutionRefusal(
        'already-decided',
        decision.runId,
        `run ${decision.runId} is already resolved`,
      );
    }

    const recorded: VisibilityDecision = {
      runId: decision.runId,
      as: decision.as,
      by: decision.by,
      at: decision.at,
    };
    decided.set(recorded.runId, recorded);
    added.push(recorded);
  }

  return { runs: [...doc.runs], decisions: [...doc.decisions, ...added] };
};
