export type SourceSpan = {
  part: string;
  start: number;
  end: number;
};

export type Style = {
  color?: string;
  background?: string;
  sizePt?: number;
  hidden?: boolean;
};

export type StyledRun = {
  id: string;
  text: string;
  source: SourceSpan;
  style: Style;
};
