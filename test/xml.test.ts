import { strict as assert } from 'node:assert';
import test from 'node:test';

import { scanCodePoints } from '../src/codepoints.ts';
import {
  WORDPROCESSINGML_NAMESPACES,
  XML_LIMITS,
  XML_REFUSAL_CODES,
  XmlRefusal,
  canonicalName,
  readXml,
} from '../src/docx/xml.ts';
import type { XmlRefusalCode, XmlToken } from '../src/docx/xml.ts';

const [WML, STRICT] = WORDPROCESSINGML_NAMESPACES;

const tokens = (source: string): XmlToken[] => [...readXml(source)];

const doc = (inner: string, uri: string = WML): string =>
  `<w:document xmlns:w="${uri}">${inner}</w:document>`;

const names = (source: string): string[] =>
  tokens(source).flatMap((token) => (token.kind === 'start' ? [canonicalName(token.name)] : []));

const textOf = (source: string): string =>
  tokens(source)
    .flatMap((token) => (token.kind === 'text' ? [token.text] : []))
    .join('');

const shape = (source: string): string[] =>
  tokens(source).map((token) =>
    token.kind === 'text'
      ? `text ${JSON.stringify(token.text)}`
      : `${token.kind} ${canonicalName(token.name)}@${token.depth}`,
  );

const nested = (depth: number): string =>
  doc(`${'<w:p>'.repeat(depth - 1)}deep${'</w:p>'.repeat(depth - 1)}`);

const refused = (source: string): XmlRefusal => {
  try {
    tokens(source);
  } catch (error) {
    if (error instanceof XmlRefusal) {
      return error;
    }
    throw error;
  }
  return assert.fail('the part was read instead of refused');
};

const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE document [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<w:document xmlns:w="${WML}"><w:body><w:t>&lol4;</w:t></w:body></w:document>`;

test('the default limits are the published ones', () => {
  assert.deepEqual(XML_LIMITS, { depth: 64 });
});

test('start, text and end tokens nest and carry their depth', () => {
  assert.deepEqual(shape(doc('<w:body><w:p><w:t>hi</w:t></w:p></w:body>')), [
    'start w:document@1',
    'start w:body@2',
    'start w:p@3',
    'start w:t@4',
    'text "hi"',
    'end w:t@4',
    'end w:p@3',
    'end w:body@2',
    'end w:document@1',
  ]);
});

test('a self-closing element yields one start token and no end token', () => {
  const source = doc('<w:body><w:br/></w:body>');

  assert.deepEqual(shape(source), [
    'start w:document@1',
    'start w:body@2',
    'start w:br@3',
    'end w:body@2',
    'end w:document@1',
  ]);

  const br = tokens(source).find((token) => token.kind === 'start' && token.name.local === 'br');
  assert.ok(br?.kind === 'start');
  assert.equal(br.selfClosing, true);
});

test('a declaration, a comment and a processing instruction are skipped', () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?><!-- drafted elsewhere -->${doc(
    '<?mso-application progid="Word.Document"?><w:t>plain</w:t>',
  )}\n`;

  assert.deepEqual(names(source), ['w:document', 'w:t']);
  assert.equal(textOf(source), 'plain');
});

test('a re-prefixed document reads the same as a w-prefixed one', () => {
  const prefixed = doc('<w:body><w:p><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:p></w:body>');
  const reprefixed =
    `<x:document xmlns:x="${WML}">` +
    '<x:body><x:p><x:rPr><x:vanish/></x:rPr><x:t>hidden</x:t></x:p></x:body>' +
    '</x:document>';

  assert.deepEqual(names(reprefixed), names(prefixed));
  assert.ok(names(reprefixed).includes('w:vanish'));
  assert.equal(textOf(reprefixed), 'hidden');
});

test('the default namespace binds unprefixed element names', () => {
  assert.deepEqual(names(`<document xmlns="${WML}"><body><t>text</t></body></document>`), [
    'w:document',
    'w:body',
    'w:t',
  ]);
});

test('the Strict namespace URI is recognised as the same vocabulary', () => {
  assert.deepEqual(names(doc('<w:body/>', STRICT)), names(doc('<w:body/>')));
});

test('an element outside the known namespaces keeps its URI', () => {
  const source = `<w:document xmlns:w="${WML}" xmlns:o="http://example.com/o"><o:thing/></w:document>`;

  assert.deepEqual(names(source), ['w:document', '{http://example.com/o}thing']);
});

test('attributes resolve through xmlns and unprefixed names carry no namespace', () => {
  const source = doc('<w:p w:rsidR="00A1" id="7"/>');
  const paragraph = tokens(source).find(
    (token) => token.kind === 'start' && token.name.local === 'p',
  );

  assert.ok(paragraph?.kind === 'start');
  assert.deepEqual(
    paragraph.attributes.map((attribute) => [canonicalName(attribute.name), attribute.value]),
    [
      ['w:rsidR', '00A1'],
      ['id', '7'],
    ],
  );
  assert.equal(paragraph.attributes[0]?.offset, source.indexOf('w:rsidR'));

  const root = tokens(source)[0];
  assert.ok(root?.kind === 'start');
  assert.deepEqual(root.attributes, []);
});

test('a numeric reference is decoded before the code-point scan', () => {
  const text = textOf(doc('<w:t>skills&#x200B;list</w:t>'));

  assert.equal(text, 'skills\u200blist');
  assert.deepEqual(scanCodePoints(text), [
    { offset: 6, codePoint: 0x200b, name: 'zero-width-space', tier: 'flag' },
  ]);
  assert.deepEqual(scanCodePoints(textOf(doc('<w:t>skills\u200blist</w:t>'))), scanCodePoints(text));
});

test('the five predefined entities and a decimal reference are decoded', () => {
  assert.equal(textOf(doc('<w:t>&amp;&lt;&gt;&quot;&apos;&#65;</w:t>')), '&<>"\'A');
});

test('an attribute value is decoded and a CDATA section is passed through', () => {
  const source = doc('<w:p w:val="a&amp;b"><w:t><![CDATA[1 < 2 & raw]]></w:t></w:p>');
  const paragraph = tokens(source).find(
    (token) => token.kind === 'start' && token.name.local === 'p',
  );

  assert.ok(paragraph?.kind === 'start');
  assert.equal(paragraph.attributes[0]?.value, 'a&b');
  assert.equal(textOf(source), '1 < 2 & raw');
});

test('a text token points back at the part it came from', () => {
  const source = doc('<w:t>skills&#x200B;list</w:t>');
  const text = tokens(source).find((token) => token.kind === 'text');

  assert.ok(text?.kind === 'text');
  assert.equal(text.offset, source.indexOf('skills'));
});

test('nesting up to the cap is read', () => {
  assert.equal(names(nested(XML_LIMITS.depth)).length, XML_LIMITS.depth);
  assert.equal(textOf(nested(XML_LIMITS.depth)), 'deep');
});

const CASES: ReadonlyArray<[string, XmlRefusalCode, string]> = [
  ['a document type declaration', 'doctype', `<!DOCTYPE document>${doc('<w:body/>')}`],
  ['a billion-laughs part', 'doctype', BILLION_LAUGHS],
  ['an entity reference in text', 'entity-reference', doc('<w:t>&nbsp;</w:t>')],
  ['an entity reference in an attribute', 'entity-reference', doc('<w:p w:val="&lol4;"/>')],
  ['a reference to the null character', 'character-reference', doc('<w:t>&#0;</w:t>')],
  ['a reference to a control character', 'character-reference', doc('<w:t>&#x1F;</w:t>')],
  ['a reference to a surrogate', 'character-reference', doc('<w:t>&#xD800;</w:t>')],
  ['a reference past the last code point', 'character-reference', doc('<w:t>&#x110000;</w:t>')],
  ['a reference that is not a number', 'character-reference', doc('<w:t>&#xZZ;</w:t>')],
  ['nesting past the cap', 'depth-cap', nested(XML_LIMITS.depth + 1)],
  ['an undeclared element prefix', 'unbound-prefix', doc('<y:p/>')],
  ['an undeclared attribute prefix', 'unbound-prefix', doc('<w:p y:val="1"/>')],
  [
    'a document element in an unknown namespace',
    'unknown-namespace',
    `<w:document xmlns:w="http://example.com/wml"><w:body/></w:document>`,
  ],
  ['a document element in no namespace', 'unknown-namespace', '<document><body/></document>'],
  ['an end tag that closes another element', 'malformed', doc('<w:body></w:p>')],
  ['an end tag that closes nothing', 'malformed', doc('</w:p>')],
  ['a start tag that does not close', 'malformed', `<w:document xmlns:w="${WML}"><w:body`],
  ['a part that ends inside an element', 'malformed', `<w:document xmlns:w="${WML}"><w:body>`],
  ['a part with no document element', 'malformed', '<!-- empty -->'],
  ['text before the document element', 'malformed', `stray${doc('<w:body/>')}`],
  ['an unquoted attribute value', 'malformed', doc('<w:p w:val=1/>')],
  ['an attribute without a value', 'malformed', doc('<w:p w:val/>')],
  ['a repeated attribute', 'malformed', doc('<w:p w:val="a" w:val="b"/>')],
  ['a reference without a semicolon', 'malformed', doc('<w:t>skills &amp list</w:t>')],
  ['an entity declaration without a doctype', 'malformed', `<!ENTITY lol "lol">${doc('<w:body/>')}`],
  ['a comment that does not close', 'malformed', doc('<!-- open')],
  ['a prefix bound to no namespace', 'malformed', doc('<w:p xmlns:z=""><w:t>t</w:t></w:p>')],
];

for (const [label, code, source] of CASES) {
  test(`refuse ${code}: ${label}`, () => {
    const refusal = refused(source);

    assert.equal(refusal.name, 'XmlRefusal');
    assert.equal(refusal.code, code);
    assert.ok(refusal.message.startsWith(`${code}: `));
    assert.ok(refusal.offset >= 0 && refusal.offset <= source.length);
  });
}

test('every refusal code is pinned by a part', () => {
  const covered = new Set(CASES.map(([, code]) => code));

  assert.deepEqual(
    [...XML_REFUSAL_CODES].filter((code) => !covered.has(code)),
    [],
  );
});
