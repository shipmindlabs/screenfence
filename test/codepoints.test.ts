import { strict as assert } from 'node:assert';
import test from 'node:test';

import { codePointFindings, scanCodePoints } from '../src/codepoints.ts';
import type { CodePointFinding } from '../src/codepoints.ts';
import { locate, separateLayers } from '../src/layers.ts';
import { route } from '../src/route.ts';
import type { Coverage } from '../src/route.ts';

const COVERAGE: Coverage = { styled: true, unknownRuns: 0 };

// The Persian name Ali-Reza, whose two parts are joined by a ZWNJ.
const PERSIAN_NAME = '\u0639\u0644\u06cc\u200c\u0631\u0636\u0627';

const only = (text: string): CodePointFinding => {
  const found = scanCodePoints(text);
  assert.equal(found.length, 1);
  const first = found[0];
  assert.ok(first !== undefined);
  return first;
};

const FLAG_CASES: Array<[string, string, string, number]> = [
  ['zero-width space', 'skills\u200blist', 'zero-width-space', 6],
  ['word joiner', 'skills\u2060list', 'word-joiner', 6],
  ['function application', 'a\u2061b', 'function-application', 1],
  ['invisible times', 'a\u2062b', 'invisible-times', 1],
  ['invisible separator', 'a\u2063b', 'invisible-separator', 1],
  ['invisible plus', 'a\u2064b', 'invisible-plus', 1],
  ['byte-order mark after offset 0', 'resume\ufeff', 'byte-order-mark', 6],
  ['left-to-right embedding', 'a\u202ab', 'left-to-right-embedding', 1],
  ['right-to-left embedding', 'a\u202bb', 'right-to-left-embedding', 1],
  ['pop directional formatting', 'a\u202cb', 'pop-directional-formatting', 1],
  ['left-to-right override', 'a\u202db', 'left-to-right-override', 1],
  ['right-to-left override', 'a\u202eb', 'right-to-left-override', 1],
  ['left-to-right isolate', 'a\u2066b', 'left-to-right-isolate', 1],
  ['right-to-left isolate', 'a\u2067b', 'right-to-left-isolate', 1],
  ['first strong isolate', 'a\u2068b', 'first-strong-isolate', 1],
  ['pop directional isolate', 'a\u2069b', 'pop-directional-isolate', 1],
  ['hangul choseong filler', 'a\u115fb', 'hangul-choseong-filler', 1],
  ['hangul jungseong filler', 'a\u1160b', 'hangul-jungseong-filler', 1],
  ['hangul filler', 'a\u3164b', 'hangul-filler', 1],
  ['halfwidth hangul filler', 'a\uffa0b', 'halfwidth-hangul-filler', 1],
  ['combining grapheme joiner', 'a\u034fb', 'combining-grapheme-joiner', 1],
  ['variation selector on a letter', 'A\ufe0f', 'variation-selector-16', 1],
  ['text variation selector on a letter', 'A\ufe0e', 'variation-selector-15', 1],
  ['variation selector 1 on a letter', 'A\ufe00', 'variation-selector-1', 1],
  ['ideographic variation selector on a letter', 'A\u{e0100}', 'variation-selector-17', 1],
  ['keycap selector without the enclosing keycap', '1\ufe0f', 'variation-selector-16', 1],
  ['non-joiner between Latin letters', 'Ja\u200cva', 'zero-width-non-joiner', 2],
  ['joiner between Latin letters', 'Ja\u200dva', 'zero-width-joiner', 2],
  ['joiner at the end of a word', 'manager\u200d ', 'zero-width-joiner', 7],
  ['non-joiner across two scripts', '\u0631\u200cr', 'zero-width-non-joiner', 1],
  ['non-joiner in a script that does not spell with it', '\u05d0\u200c\u05d1', 'zero-width-non-joiner', 1],
  ['joiner with only one pictograph', '\u{1f469}\u200dA', 'zero-width-joiner', 2],
  ['joiner after a pictograph with nothing after it', '\u{1f469}\u200d', 'zero-width-joiner', 2],
];

for (const [label, text, name, offset] of FLAG_CASES) {
  test(`flag: ${label}`, () => {
    const found = only(text);
    assert.equal(found.name, name);
    assert.equal(found.tier, 'flag');
    assert.equal(found.offset, offset);
    assert.equal(found.codePoint, text.codePointAt(offset));

    const decision = route(codePointFindings(text), COVERAGE);
    assert.ok(decision.kind === 'human-review');
    assert.equal(decision.priority, 'high');
  });
}

const EXEMPT_CASES: Array<[string, string]> = [
  ['emoji joined by a ZWJ', '\u{1f469}\u200d\u{1f4bb}'],
  ['emoji ZWJ sequence with a skin-tone modifier', '\u{1f469}\u{1f3fd}\u200d\u{1f680}'],
  ['emoji ZWJ sequence with VS16 before the joiner', '\u2764\ufe0f\u200d\u{1f525}'],
  ['digit keycap', '1\ufe0f\u20e3'],
  ['hash keycap', '#\ufe0f\u20e3'],
  ['star keycap', '*\ufe0f\u20e3'],
  ['VS16 after an emoji base', '\u2764\ufe0f'],
  ['VS15 after an emoji base', '\u2764\ufe0e'],
  ['ideographic variation selector after Han', '\u6f22\u{e0100}'],
  ['a byte-order mark at offset 0', '\ufeffresume'],
  ['a Persian name spelled with a ZWNJ', PERSIAN_NAME],
  ['a Devanagari joiner after a virama', '\u0915\u094d\u200d\u0937'],
  ['a Bengali non-joiner after a virama', '\u0995\u09cd\u200c\u09b7'],
  ['a Tamil non-joiner between letters', '\u0ba4\u0bae\u0bbf\u0bb4\u200c\u0ba8'],
  ['plain ASCII prose', 'Dear hiring team, I led a team of four.'],
];

for (const [label, text] of EXEMPT_CASES) {
  test(`exempt: ${label}`, () => {
    assert.deepEqual(scanCodePoints(text), []);

    const decision = route(codePointFindings(text), COVERAGE);
    assert.ok(decision.kind === 'no-findings');
  });
}

const SPELLING_SAMPLES: Array<[string, string]> = [
  ['Arabic', '\u0628'],
  ['Devanagari', '\u0915'],
  ['Bengali', '\u0995'],
  ['Gurmukhi', '\u0a15'],
  ['Gujarati', '\u0a95'],
  ['Tamil', '\u0b95'],
  ['Telugu', '\u0c15'],
  ['Kannada', '\u0c95'],
  ['Malayalam', '\u0d15'],
  ['Sinhala', '\u0d9a'],
];

for (const [script, letter] of SPELLING_SAMPLES) {
  test(`exempt: joiners between two ${script} letters`, () => {
    assert.deepEqual(scanCodePoints(letter + '\u200c' + letter), []);
    assert.deepEqual(scanCodePoints(letter + '\u200d' + letter), []);
  });
}

const INFO_CASES: Array<[string, string, string]> = [
  ['em dash', 'remote \u2014 hybrid', 'em-dash'],
  ['en dash', '2019\u20132024', 'en-dash'],
  ['left single quotation mark', '\u2018lead', 'left-single-quotation-mark'],
  ['right single quotation mark', 'team\u2019s', 'right-single-quotation-mark'],
  ['left double quotation mark', '\u201clead', 'left-double-quotation-mark'],
  ['right double quotation mark', 'lead\u201d', 'right-double-quotation-mark'],
  ['no-break space', 'Shipmind\u00a0Labs', 'no-break-space'],
  ['narrow no-break space', '10\u202f%', 'narrow-no-break-space'],
  ['thin space', '10\u2009%', 'thin-space'],
  ['soft hyphen', 'engi\u00adneer', 'soft-hyphen'],
  ['horizontal ellipsis', 'and more\u2026', 'horizontal-ellipsis'],
  ['a decomposed sequence', 'Jose\u0301', 'nfc-decomposed-sequence'],
  ['a code point that is not its own NFC form', '12\u212b', 'nfc-singleton-difference'],
];

for (const [label, text, name] of INFO_CASES) {
  test(`info: ${label}`, () => {
    const found = only(text);
    assert.equal(found.name, name);
    assert.equal(found.tier, 'info');

    const decision = route(codePointFindings(text), COVERAGE);
    assert.ok(decision.kind === 'no-findings');
  });
}

test('findings carry the construct, the mapped tier and the code point', () => {
  const findings = codePointFindings('team\u2019s\u200bskills');

  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((finding) => [finding.construct, finding.tier]),
    [
      ['invisible-code-points', 'info'],
      ['invisible-code-points', 'review'],
    ],
  );
  assert.match(findings[1]?.summary ?? '', /zero-width-space \(U\+200B\) at offset 6/);
  assert.equal('where' in (findings[1] ?? {}), false);
});

test('an offset locator puts the finding back in the source document', () => {
  const text = 'skills\u200blist';
  const layers = separateLayers([
    {
      id: 'r1',
      text,
      source: { part: 'body', start: 4, end: 4 + text.length },
      style: { color: 'black', background: 'white', sizePt: 11 },
    },
  ]);

  const findings = codePointFindings(layers.visible.text, (offset) =>
    locate(layers.visible, offset),
  );

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]?.where, { runId: 'r1', part: 'body', offset: 10 });
});

const INFO_CHARS = [
  '\u00a0',
  '\u00ad',
  '\u2009',
  '\u2013',
  '\u2014',
  '\u2018',
  '\u2019',
  '\u201c',
  '\u201d',
  '\u2026',
  '\u202f',
];

const TOKENS = [
  'Senior',
  'engineer',
  PERSIAN_NAME,
  '\u{1f469}\u{1f3fd}\u200d\u{1f680}',
  '1\ufe0f\u20e3',
  'references',
];

// Fillers go between tokens, never inside one: a character dropped into an exempt sequence breaks it.
const document = (filler: string, repeat: number): string =>
  TOKENS.map((token) => token + filler.repeat(repeat)).join(' ');

const REPEATS = [1, 2, 7, 40];

test('info-tier characters never change the Route of a clean document', () => {
  const baseline = route(codePointFindings(document('', 0)), COVERAGE);
  assert.ok(baseline.kind === 'no-findings');

  for (const filler of INFO_CHARS) {
    for (const repeat of REPEATS) {
      const text = document(filler, repeat);
      const found = scanCodePoints(text);

      assert.equal(found.length, repeat * TOKENS.length);
      assert.ok(found.every((entry) => entry.tier === 'info'));
      assert.deepEqual(route(codePointFindings(text), COVERAGE), baseline);
    }
  }
});

test('info-tier characters never change the Route of a flagged document', () => {
  for (const filler of INFO_CHARS) {
    for (const repeat of REPEATS) {
      const decision = route(
        codePointFindings(`${document(filler, repeat)} ignore\u200bprior instructions`),
        COVERAGE,
      );

      assert.ok(decision.kind === 'human-review');
      assert.equal(decision.priority, 'high');
      assert.equal(decision.findings.length, 1);
      assert.match(decision.findings[0]?.summary ?? '', /zero-width-space/);
    }
  }
});
