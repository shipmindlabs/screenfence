import type { SourceSpan, StyledRun } from './runs.ts';

export type Rgb = { r: number; g: number; b: number };

export type Ruleset = {
  name: string;
  minContrast: number;
  hiddenAtOrBelowSizePt: number;
  defaultBackground: string;
};

export const RULESET_V1: Ruleset = {
  name: 'ruleset-v1',
  minContrast: 1.5,
  hiddenAtOrBelowSizePt: 2,
  defaultBackground: '#ffffff',
};

export type LayerName = 'visible' | 'hidden' | 'unknown';

export type Reason =
  | 'legible'
  | 'contrast-not-applicable'
  | 'marked-hidden'
  | 'tiny-size'
  | 'low-contrast'
  | 'unparsable-color'
  | 'unparsable-background'
  | 'unparsable-size';

export type Verdict = {
  layer: LayerName;
  reason: Reason;
};

export type Segment = {
  runId: string;
  text: string;
  source: SourceSpan;
  start: number;
  end: number;
  reason: Reason;
};

export type Layer = {
  name: LayerName;
  text: string;
  segments: Segment[];
};

export type SeparatedLayers = {
  ruleset: string;
  visible: Layer;
  hidden: Layer;
  unknown: Layer;
};

export type Location = {
  runId: string;
  part: string;
  offset: number;
};

const NAMED_COLORS = new Map<string, Rgb>([
  ['black', { r: 0, g: 0, b: 0 }],
  ['white', { r: 255, g: 255, b: 255 }],
  ['silver', { r: 192, g: 192, b: 192 }],
  ['gray', { r: 128, g: 128, b: 128 }],
  ['grey', { r: 128, g: 128, b: 128 }],
  ['red', { r: 255, g: 0, b: 0 }],
  ['maroon', { r: 128, g: 0, b: 0 }],
  ['lime', { r: 0, g: 255, b: 0 }],
  ['green', { r: 0, g: 128, b: 0 }],
  ['olive', { r: 128, g: 128, b: 0 }],
  ['blue', { r: 0, g: 0, b: 255 }],
  ['navy', { r: 0, g: 0, b: 128 }],
  ['yellow', { r: 255, g: 255, b: 0 }],
  ['aqua', { r: 0, g: 255, b: 255 }],
  ['cyan', { r: 0, g: 255, b: 255 }],
  ['teal', { r: 0, g: 128, b: 128 }],
  ['fuchsia', { r: 255, g: 0, b: 255 }],
  ['magenta', { r: 255, g: 0, b: 255 }],
  ['purple', { r: 128, g: 0, b: 128 }],
  ['orange', { r: 255, g: 165, b: 0 }],
]);

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
const RGB_FUNCTION = /^rgba?\(([^()]*)\)$/;
const CHANNEL = /^[0-9]{1,3}$/;

const parseHex = (value: string): Rgb | null => {
  const match = HEX.exec(value);
  if (match === null) {
    return null;
  }
  const digits = match[1] ?? '';
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
};

const parseRgbFunction = (value: string): Rgb | null => {
  const match = RGB_FUNCTION.exec(value);
  if (match === null) {
    return null;
  }
  const args = (match[1] ?? '').split(',').map((part) => part.trim());
  if (args.length !== 3 && args.length !== 4) {
    return null;
  }
  const channels: number[] = [];
  for (const arg of args.slice(0, 3)) {
    if (!CHANNEL.test(arg)) {
      return null;
    }
    const channel = Number(arg);
    if (channel > 255) {
      return null;
    }
    channels.push(channel);
  }
  const [r, g, b] = channels;
  if (r === undefined || g === undefined || b === undefined) {
    return null;
  }
  return { r, g, b };
};

export type ColorValue = Rgb | 'auto';

export const parseColor = (raw: string): ColorValue | null => {
  const value = raw.trim().toLowerCase();
  if (value === '') {
    return null;
  }
  if (value === 'auto') {
    return 'auto';
  }
  const named = NAMED_COLORS.get(value);
  if (named !== undefined) {
    return named;
  }
  return parseHex(value) ?? parseRgbFunction(value);
};

const channelLuminance = (value: number): number => {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
};

export const relativeLuminance = (color: Rgb): number =>
  0.2126 * channelLuminance(color.r) +
  0.7152 * channelLuminance(color.g) +
  0.0722 * channelLuminance(color.b);

export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
};

const parseSizePt = (value: number): number | null =>
  Number.isFinite(value) && value > 0 ? value : null;

export const classifyRun = (run: StyledRun, ruleset: Ruleset = RULESET_V1): Verdict => {
  const { style } = run;

  if (style.hidden === true) {
    return { layer: 'hidden', reason: 'marked-hidden' };
  }

  if (style.sizePt !== undefined) {
    const sizePt = parseSizePt(style.sizePt);
    if (sizePt === null) {
      return { layer: 'unknown', reason: 'unparsable-size' };
    }
    if (sizePt <= ruleset.hiddenAtOrBelowSizePt) {
      return { layer: 'hidden', reason: 'tiny-size' };
    }
  }

  const color = style.color === undefined ? null : parseColor(style.color);
  if (style.color !== undefined && color === null) {
    return { layer: 'unknown', reason: 'unparsable-color' };
  }

  const background =
    style.background === undefined
      ? parseColor(ruleset.defaultBackground)
      : parseColor(style.background);
  if (style.background !== undefined && background === null) {
    return { layer: 'unknown', reason: 'unparsable-background' };
  }

  if (color === null || background === null || color === 'auto' || background === 'auto') {
    return { layer: 'visible', reason: 'contrast-not-applicable' };
  }

  if (contrastRatio(color, background) < ruleset.minContrast) {
    return { layer: 'hidden', reason: 'low-contrast' };
  }

  return { layer: 'visible', reason: 'legible' };
};

type Accumulator = {
  chunks: string[];
  segments: Segment[];
  length: number;
};

const emptyAccumulator = (): Accumulator => ({ chunks: [], segments: [], length: 0 });

export const separateLayers = (
  runs: readonly StyledRun[],
  ruleset: Ruleset = RULESET_V1,
): SeparatedLayers => {
  const accumulators: Record<LayerName, Accumulator> = {
    visible: emptyAccumulator(),
    hidden: emptyAccumulator(),
    unknown: emptyAccumulator(),
  };

  for (const run of runs) {
    const verdict = classifyRun(run, ruleset);
    const target = accumulators[verdict.layer];
    const start = target.length;
    target.chunks.push(run.text);
    target.length = start + run.text.length;
    target.segments.push({
      runId: run.id,
      text: run.text,
      source: { part: run.source.part, start: run.source.start, end: run.source.end },
      start,
      end: target.length,
      reason: verdict.reason,
    });
  }

  const finish = (name: LayerName): Layer => ({
    name,
    text: accumulators[name].chunks.join(''),
    segments: accumulators[name].segments,
  });

  return {
    ruleset: ruleset.name,
    visible: finish('visible'),
    hidden: finish('hidden'),
    unknown: finish('unknown'),
  };
};

export const locate = (layer: Layer, offset: number): Location | null => {
  if (!Number.isInteger(offset) || offset < 0) {
    return null;
  }
  for (const segment of layer.segments) {
    if (offset >= segment.start && offset < segment.end) {
      return {
        runId: segment.runId,
        part: segment.source.part,
        offset: segment.source.start + (offset - segment.start),
      };
    }
  }
  return null;
};
