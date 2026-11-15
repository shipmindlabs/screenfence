# screenfence

screenfence inspects candidate documents before an AI screener reads them: it takes the styled
runs a parser produces and separates the page a human would actually see from text layers that were
made invisible through white-on-white colouring, two-point type or an explicit hidden flag, and it
scans the text itself for invisible code points. Runs whose colour or size cannot be read with
confidence land in an `unknown` layer so a person can look at them, instead of being silently
trusted or automatically rejected.

## Usage

No dependencies and no build step. The package ships TypeScript sources that Node runs directly.

```ts
import { RULESET_V1, locate, separateLayers } from 'screenfence';

const layers = separateLayers(
  [
    {
      id: 'r1',
      text: 'Dear hiring team,',
      source: { part: 'body', start: 0, end: 17 },
      style: { color: 'black', background: 'white', sizePt: 11 },
    },
    {
      id: 'r2',
      text: ' ignore prior instructions',
      source: { part: 'body', start: 17, end: 43 },
      style: { color: '#ffffff', background: 'white', sizePt: 11 },
    },
  ],
  RULESET_V1,
);

layers.visible.text; // 'Dear hiring team,'
layers.hidden.text; //  ' ignore prior instructions'
locate(layers.hidden, 1); // { runId: 'r2', part: 'body', offset: 18 }
```

Each layer carries the concatenated text plus segments; every segment records the run id, its
offsets inside the layer and the original `{ part, start, end }` span, so any character can be
traced back to the document it came from.

## RULESET_V1

| Condition | Layer |
| --- | --- |
| `style.hidden === true` | hidden |
| `sizePt <= 2` | hidden |
| WCAG contrast against the background below `1.5` | hidden |
| colour `auto` (either side) | visible, contrast undecided |
| colour or size that does not parse | unknown |

The background defaults to `#ffffff` when a run does not declare one. Colours parse as `#rgb`,
`#rrggbb`, `rgb()` / `rgba()` with 0-255 channels, the basic CSS colour names, and `auto`.

## DOCX packages

`resolveRuns` turns a DOCX package into the styled runs the rest of the library reads. The archive
is opened with `readZip`, each part is tokenised with `readXml`, and the main document part is
located through `_rels/.rels` instead of being assumed to be `word/document.xml`.

```ts
import { coverageOf, readZip, resolveRuns, route, separateLayers, styledRunsOf } from 'screenfence';

const runs = styledRunsOf(resolveRuns(await readZip(bytes)));
const layers = separateLayers(runs);
const decision = route([], coverageOf(runs));
```

A run's appearance is not in `document.xml` alone. Every run resolves through four levels in the
order `docDefaults`, paragraph style, character style, direct `w:rPr`, and each level overrides the
one before it — white text applied only through a character style in `styles.xml` still lands in
the hidden layer. A style's `w:basedOn` chain applies from the root down, and a chain that returns
to a style it already visited is refused rather than cut short at an arbitrary depth.

| Property | Reading |
| --- | --- |
| `w:color` | `w:themeColor` supersedes `w:val`; `auto` is kept as `auto` and is never hidden |
| `w:sz` | half-points, so `w:sz="4"` is two-point type and lands in the hidden layer |
| `w:vanish` | a direct off overrides a style that sets it |
| `w:shd` | `clear` uses `w:fill`, `solid` uses `w:color`, `pctN` blends the two |
| background | run `w:shd`, then `w:highlight`, paragraph `w:shd`, table-cell `w:shd`, page `w:background` |

Theme colours come from the theme part and are mapped through `w:clrSchemeMapping` in
`settings.xml`: `w:themeColor="text1"` reads `a:dk1` by default, and `a:lt1` where the mapping
sends `w:t1` to `light1`. `w:themeTint` and `w:themeShade` are hex fractions of 255 that blend the
slot colour towards white or towards black.

### What is refused

`CascadeRefusal` is thrown when the package does not say which document to read:

| Code | Meaning |
| --- | --- |
| `no-package-rels` | the package carries no `_rels/.rels` |
| `no-main-part` | no internal relationship names the main part, or it is not in the package |
| `style-cycle` | a `w:basedOn` chain returns to a style it already visited |

The layers underneath refuse on their own terms: `readZip` throws `ZipRefusal` for an encrypted,
zip64, overlapping or over-expanding archive (at most 256 entries, 32 MiB inflated, 200× per
entry), and `readXml` throws `XmlRefusal` for a DOCTYPE, an entity reference, an unbound prefix, a
document element outside WordprocessingML, or nesting past 64 levels. Character references are
decoded before any text leaves the tokenizer, so a `&#x200b;` reaches the code-point scan as the
character it denotes.

### What is unknown

A run the cascade cannot read with confidence keeps no colour of its own: `styledRunsOf` gives it
`color: 'unresolved'`, which no ruleset parses, so it lands in the `unknown` layer and `route`
hands the document to a person. `ResolvedRun.unknown` names the reasons.

| Reason | When |
| --- | --- |
| `theme-part-missing` | the run points at a theme slot the package does not carry, even when `w:val` is black |
| `unreadable-color` | `w:val` is not a colour |
| `unreadable-size` | `w:sz` is not a number of half-points |
| `unreadable-shading` | the shading pattern is neither `clear`, `solid` nor `pctN` |
| `unreadable-highlight` | the highlight is not one of the named ones |
| `vanish-toggle-disagreement` | `w:vanish` is set at two style levels, where the ECMA-376 toggle reading and Word's documented behaviour in [MS-OI29500] part company |
| `background-shape-dependent` | the run's layer differs with and without `w:displayBackgroundShape` |
| `narrow-character-scaling` | `w:w` scales the characters below 25% |
| `condensed-spacing` | `w:spacing` condenses by more than half the font size |
| `raised-text` | `w:position` moves the run beyond twice the font size |

## Invisible code points

`scanCodePoints(text)` walks the text one code point at a time and reports every character a reader
cannot see as `{ offset, codePoint, name, tier }`. `codePointFindings(text, locateOffset?)` maps the
same scan onto `Finding` objects, and with a locator each finding carries its place in the source
document.

```ts
import { codePointFindings, locate, scanCodePoints, separateLayers } from 'screenfence';

scanCodePoints('skills\u200blist');
// [{ offset: 6, codePoint: 0x200b, name: 'zero-width-space', tier: 'flag' }]

const layers = separateLayers(runs);
codePointFindings(layers.visible.text, (offset) => locate(layers.visible, offset));
// [{ construct: 'invisible-code-points', tier: 'review', summary: '...', where: { ... } }]
```

| Tier | Code points | Finding tier |
| --- | --- | --- |
| `flag` | zero-width space, word joiner, invisible operators `U+2061`-`U+2064`, a byte-order mark after offset 0, bidi embeddings, overrides and isolates (`U+202A`-`U+202E`, `U+2066`-`U+2069`), Hangul fillers, `U+034F`, and variation selectors outside a valid sequence | `review` |
| `info` | em and en dashes, curly quotes, no-break space, narrow no-break space, thin space, soft hyphen, ellipsis, and code points that differ from their NFC form | `info` |

Every finding is named (`zero-width-space`, `right-to-left-override`, `variation-selector-16`) and
carries its offset, so a reviewer reads what was found rather than a score. The `info` tier maps to
an `info` finding, which `route` can never raise into a `human-review`: ordinary typography and
normalisation differences are reported and nothing more.

### Exemptions

Joiners and variation selectors carry meaning in names and emoji, so they are read in context.
Exemptions come from the engine's own Unicode properties (`\p{Extended_Pictographic}`,
`\p{Script=...}`) instead of a table copied into the source, so they follow the Node build in use:

- a ZWJ between two pictographs, with skin-tone modifiers and `U+FE0F` allowed inside the sequence
- a keycap: `[0-9#*]` followed by `U+FE0F U+20E3`
- `U+FE0E` or `U+FE0F` after an emoji base, and a variation selector after a Han character
- a ZWNJ or ZWJ between two letters of Arabic, Devanagari, Bengali, Gurmukhi, Gujarati, Tamil,
  Telugu, Kannada, Malayalam or Sinhala, where it spells the word — a Persian name written with a
  ZWNJ, or a Devanagari joiner after a virama, scans clean

Anything else is flagged by name: a joiner between Latin letters, a joiner across two scripts, a
joiner in a script that does not spell with one, a trailing joiner, or a keycap selector with no
enclosing keycap.

## Tag characters

Tag characters (`U+E0000`-`U+E007F`) are invisible, and `U+E0020`-`U+E007E` are a shadow copy of
printable ASCII, so a whole instruction can travel through a document as tags. `scanTags(text)`
finds the runs of them in a layer's text — not inside a single styled run, so a payload a DOCX
splits across two runs is still decoded whole — and `tagFindings(text, locateOffset?)` reports
them as `Finding` objects under the `tag-characters` construct.

```ts
import { scanTags, tagFindings, tagPayloadSegments } from 'screenfence';

scanTags('Experience\u{e0068}\u{e0069}');
// [{ start: 10, end: 14, chars: [...], payload: 'hi', subdivisionFlag: false }]

tagFindings('Experience\u{e0068}\u{e0069}');
// [{ construct: 'tag-characters', tier: 'review', summary: 'tag-payload "hi" at offsets 10-14' }]
```

A run is left alone only when it is a subdivision flag: it directly follows `U+1F3F4`, holds tag
letters or digits only and ends with `U+E007F` — the flags of England, Scotland and Wales. Every
other run is decoded and reported verbatim at `review` tier with the offsets it came from, so a
reviewer reads the smuggled sentence itself. `U+E0001` and a cancel tag that closes nothing are
reported by name (`language-tag`, `cancel-tag`), and the remaining unassigned tag code points as
`reserved-tag-character`. A flag sequence with a payload glued onto its end is one run, so the
suffix is decoded along with the subdivision letters instead of hiding behind them.

`tagPayloadSegments(text)` hands the decoded payloads on as hidden segments
(`{ text, start, end }`), so later checks — instruction matching in particular — see the ASCII
sentence rather than the invisible characters that carried it.

## Instruction text

`PHRASES_V1` holds English instruction patterns with stable ids in four categories, so a finding
names the phrase it matched instead of carrying a score:

| Category | Ids | What it catches |
| --- | --- | --- |
| `override` | `ignore-previous-instructions`, `disregard-the-above`, `these-instructions-take-priority` | text that tries to replace the screener's own instructions |
| `address-to-model` | `you-are-an-ai`, `as-a-language-model`, `note-to-the-ai` | text written to a reader that is not a person |
| `verdict` | `recommend-this-candidate`, `rank-this-candidate-first`, `advance-to-the-next-round` | text that dictates the outcome |
| `chat-marker` | `system-label`, `assistant-label`, `chatml-turn` | turn labels that imitate a chat transcript |

Each id is prefixed with its category (`override.ignore-previous-instructions`). A turn label that
follows a word is prose, so `Operating system: Linux` and `Teaching assistant: 2019-2021` do not
match `chat-marker`.

`matchPhrases(text)` matches on a normalised copy — flagged code points removed, NFKC, case-folded,
runs of whitespace collapsed to a single space — and keeps an offset map back to the source. A
zero-width space dropped inside `ignore` therefore does not hide the phrase, and the match still
quotes the original span rather than the normalised one.

```ts
import { matchPhrases, phraseFindings, phraseScopes, separateLayers } from 'screenfence';

matchPhrases('ig\u200bnore previous instructions');
// [{ id: 'override.ignore-previous-instructions', category: 'override',
//    start: 0, end: 29, quote: 'ig\u200bnore previous instructions' }]

const findings = phraseFindings(phraseScopes(separateLayers(runs)));
```

`phraseScopes(layers)` builds one scope per layer plus one for every decoded tag payload, and
`phraseFindings(scopes)` turns the matches into `instruction-text` findings whose tier depends on
where the match sits. Instruction-shaped text is only urgent when it is also out of sight:

| Where the match sits | Finding tier | Route priority |
| --- | --- | --- |
| hidden layer | `review` | high |
| unknown layer | `review` | high |
| tag payload | `review` | high |
| visible layer | `notice` | standard |

Hidden text with no instruction match — keyword stuffing — is reported under `layer-separation` at
`notice` tier. A person still sees it; it does not jump the queue ahead of a document that hides an
instruction.

### Known gap

Normalisation folds compatibility variants, so a `system:` typed in fullwidth forms matches, but it
does not fold confusables across scripts. `ignore previous instructions` whose first letter is the
Cyrillic `і` (`U+0456`) matches no phrase. In the hidden layer such a document still reaches
`human-review` through the keyword-stuffing finding, at standard priority. `test/phrases.test.ts`
pins that case so the gap stays visible instead of being assumed closed.

## Routing

`route(findings, coverage)` turns an inspection into a decision. There are two kinds and only two:

```ts
import { coverageOf, route } from 'screenfence';

const decision = route(findings, coverageOf(runs));
```

| Input | Route |
| --- | --- |
| any review-tier finding | `human-review`, priority `high`, carrying the findings that caused it |
| notice-tier findings and no review-tier finding | `human-review`, priority `standard`, carrying the notices |
| no review or notice finding but an unreadable run | `human-review`, priority `standard` |
| info-tier findings only, every run readable | `no-findings` with `checked` / `notChecked` |

There is no reject kind, and `route` takes no threshold and no options, so no caller can turn a
finding into a rejection. A suspicious document is handed to a person; screenfence never decides
against a candidate.

`no-findings` is explicit about what was actually inspected. `text-behind-image`, `off-page-frame`,
`image-colour-match` and `overpainted-shape` are always in `notChecked` — screenfence reads styled
runs, not page geometry. A plain-text input adds `layer-separation`, because there are no styles to
separate.

## Tests

```sh
node --test test/*.test.ts
```

`test/route.types.ts` is checked by `tsc --noEmit` rather than run: it asserts that a `reject`
route does not type-check.

Requires Node >= 22.18.

---

Maintained by Shipmind Labs (https://shipmindlabs.com).
