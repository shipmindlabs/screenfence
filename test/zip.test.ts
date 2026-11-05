import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ZIP_LIMITS,
  ZIP_REFUSAL_CODES,
  ZipRefusal,
  crc32,
  findPart,
  readZip,
} from '../src/docx/zip.ts';
import type { ZipLimits, ZipRefusalCode } from '../src/docx/zip.ts';
import { buildZip, crc32Bitwise, zip64Extra } from './helpers/zipwriter.ts';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const TYPES = '<?xml version="1.0"?><Types/>';
const DOCUMENT = '<?xml version="1.0"?><w:document>Dear hiring team,</w:document>';
const PART = 'word/document.xml';

const SMALL_LIMITS: ZipLimits = {
  maxEntries: 8,
  maxTotalBytes: 2048,
  maxEntryRatio: 1000,
  minEntryBytes: 4096,
};

const RATIO_LIMITS: ZipLimits = {
  maxEntries: 8,
  maxTotalBytes: 1 << 20,
  maxEntryRatio: 10,
  minEntryBytes: 1024,
};

const EXACT_LIMITS: ZipLimits = {
  maxEntries: 8,
  maxTotalBytes: 2048,
  maxEntryRatio: 1000,
  minEntryBytes: 1,
};

const refused = async (zip: Uint8Array, limits?: ZipLimits): Promise<ZipRefusal> => {
  try {
    await readZip(zip, limits);
  } catch (error) {
    if (error instanceof ZipRefusal) {
      return error;
    }
    throw error;
  }
  return assert.fail('the archive was read instead of refused');
};

test('the default limits are the published ones', () => {
  assert.deepEqual(ZIP_LIMITS, {
    maxEntries: 256,
    maxTotalBytes: 32 * 1024 * 1024,
    maxEntryRatio: 200,
    minEntryBytes: 64 * 1024,
  });
});

test('crc32 agrees with an independent bitwise implementation', () => {
  assert.equal(crc32(encoder.encode('')), 0);
  assert.equal(crc32(encoder.encode('hello')), 0x3610a686);

  for (const sample of ['', 'a', PART, DOCUMENT, 'x'.repeat(1000)]) {
    assert.equal(crc32(encoder.encode(sample)), crc32Bitwise(encoder.encode(sample)));
  }
});

test('a well-formed archive yields its parts, directories aside', async () => {
  const zip = await buildZip({
    entries: [
      { name: '[Content_Types].xml', data: TYPES, method: 0 },
      { name: 'word/', data: '', method: 0 },
      { name: PART, data: DOCUMENT },
    ],
  });

  const parts = await readZip(zip);

  assert.deepEqual(
    parts.map((part) => part.name),
    ['[Content_Types].xml', PART],
  );
  assert.equal(decoder.decode(parts[0]?.bytes), TYPES);
  assert.equal(decoder.decode(parts[1]?.bytes), DOCUMENT);
});

test('findPart folds case and returns null for a part that is absent', async () => {
  const parts = await readZip(await buildZip({ entries: [{ name: PART, data: DOCUMENT }] }));
  const found = findPart(parts, 'WORD/Document.XML');

  assert.ok(found !== null);
  assert.equal(found.name, PART);
  assert.equal(findPart(parts, 'word/header1.xml'), null);
});

test('a trailing archive comment does not hide the record', async () => {
  const zip = await buildZip({
    entries: [{ name: PART, data: DOCUMENT }],
    comment: 'written by a test',
  });

  assert.equal((await readZip(zip)).length, 1);
});

test('an entry that stops exactly at the total cap is read', async () => {
  const zip = await buildZip({ entries: [{ name: PART, data: 'a'.repeat(2048), method: 0 }] });
  const parts = await readZip(zip, EXACT_LIMITS);

  assert.equal(parts[0]?.bytes.length, 2048);
});

type RefusalCase = {
  label: string;
  code: ZipRefusalCode;
  part?: string;
  limits?: ZipLimits;
  build: () => Promise<Uint8Array>;
};

const CASES: readonly RefusalCase[] = [
  {
    label: 'the bytes carry no record at all',
    code: 'bad-eocd',
    build: async () => encoder.encode('this is not an archive'),
  },
  {
    label: 'the record signature is corrupt',
    code: 'bad-eocd',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], eocdSignature: 0x06054b51 }),
  },
  {
    label: 'the archive claims a second disk',
    code: 'bad-eocd',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], diskNumber: 1 }),
  },
  {
    label: 'the central directory lives on another disk',
    code: 'bad-eocd',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], centralDisk: 1 }),
  },
  {
    label: 'the entry counts disagree',
    code: 'bad-eocd',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], entriesOnDisk: 2 }),
  },
  {
    label: 'a zip64 locator precedes the record',
    code: 'zip64-marker',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], zip64Locator: true }),
  },
  {
    label: 'the record carries zip64 sentinels',
    code: 'zip64-marker',
    build: () =>
      buildZip({
        entries: [{ name: PART, data: DOCUMENT }],
        totalEntries: 0xffff,
        entriesOnDisk: 0xffff,
      }),
  },
  {
    label: 'the central header asks for zip64 support',
    code: 'zip64-marker',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, versionNeeded: 45 }] }),
  },
  {
    label: 'the central header carries a zip64 extra field',
    code: 'zip64-marker',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, extra: zip64Extra() }] }),
  },
  {
    label: 'the central header declares a sentinel size',
    code: 'zip64-marker',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, uncompressedSize: 0xffffffff }] }),
  },
  {
    label: 'the entry claims to start on another disk',
    code: 'zip64-marker',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, diskStart: 0xffff }] }),
  },
  {
    label: 'only the local header carries a zip64 extra field',
    code: 'zip64-marker',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, localExtra: zip64Extra() }] }),
  },
  {
    label: 'the archive holds more entries than the cap allows',
    code: 'entry-count-cap',
    limits: { ...ZIP_LIMITS, maxEntries: 1 },
    build: () =>
      buildZip({
        entries: [
          { name: PART, data: DOCUMENT },
          { name: 'word/header1.xml', data: TYPES },
        ],
      }),
  },
  {
    label: 'the directory does not fit before the record',
    code: 'bad-central-directory',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], cdSize: 70000 }),
  },
  {
    label: 'the directory offset points at a local header',
    code: 'bad-central-directory',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], cdOffset: 0 }),
  },
  {
    label: 'a central header runs past the directory',
    code: 'bad-central-directory',
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT }], cdSize: 50 }),
  },
  {
    label: 'the directory has trailing bytes',
    code: 'bad-central-directory',
    build: () =>
      buildZip({
        entries: [
          { name: PART, data: DOCUMENT },
          { name: 'word/header1.xml', data: TYPES },
        ],
        totalEntries: 1,
      }),
  },
  {
    label: 'an entry has an empty name',
    code: 'bad-central-directory',
    build: () => buildZip({ entries: [{ name: '', data: DOCUMENT }] }),
  },
  {
    label: 'two part names are equal under case folding',
    code: 'duplicate-part-name',
    part: 'word/Document.xml',
    build: () =>
      buildZip({
        entries: [
          { name: PART, data: DOCUMENT },
          { name: 'word/Document.xml', data: TYPES },
        ],
      }),
  },
  {
    label: 'the central header sets an encryption flag',
    code: 'encrypted-entry',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, flags: 0x0001 }] }),
  },
  {
    label: 'only the local header sets an encryption flag',
    code: 'encrypted-entry',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, localFlags: 0x0040 }] }),
  },
  {
    label: 'the entry uses a method that is neither stored nor deflated',
    code: 'unsupported-method',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, method: 12 }] }),
  },
  {
    label: 'there is no local file header at the recorded offset',
    code: 'bad-local-header',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, localSignature: 0x04034b51 }] }),
  },
  {
    label: 'the local header names another method',
    code: 'bad-local-header',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, method: 8, localMethod: 0 }] }),
  },
  {
    label: 'the entry data overruns the central directory',
    code: 'bad-local-header',
    part: PART,
    build: () =>
      buildZip({ entries: [{ name: PART, data: DOCUMENT, method: 0, compressedSize: 70000 }] }),
  },
  {
    label: 'the local header names another part',
    code: 'local-name-mismatch',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, localName: 'word/other.xml' }] }),
  },
  {
    label: 'the local header declares another uncompressed size',
    code: 'declared-size-mismatch',
    part: PART,
    build: () =>
      buildZip({ entries: [{ name: PART, data: DOCUMENT, localUncompressedSize: 999 }] }),
  },
  {
    label: 'the local header declares another compressed size',
    code: 'declared-size-mismatch',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, localCompressedSize: 42 }] }),
  },
  {
    label: 'the inflated size is not the declared size',
    code: 'declared-size-mismatch',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, uncompressedSize: 999 }] }),
  },
  {
    label: 'the crc-32 does not match the bytes',
    code: 'crc-mismatch',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: DOCUMENT, crc: 0x12345678 }] }),
  },
  {
    label: 'one entry runs into the header of the next',
    code: 'overlapping-entries',
    part: 'word/b.xml',
    build: () =>
      buildZip({
        entries: [
          { name: 'word/a.xml', data: '12345678', method: 0, compressedSize: 100 },
          { name: 'word/b.xml', data: 'B'.repeat(64), method: 0 },
        ],
      }),
  },
  {
    label: 'the deflate stream cannot be read',
    code: 'inflate-failed',
    part: PART,
    build: () =>
      buildZip({
        entries: [
          { name: PART, data: DOCUMENT, payload: new Uint8Array([0xff, 0xff, 0xff, 0xff]) },
        ],
      }),
  },
  {
    label: 'an entry inflates past its ratio of the compressed size',
    code: 'entry-ratio-cap',
    part: PART,
    limits: RATIO_LIMITS,
    build: () => buildZip({ entries: [{ name: PART, data: 'A'.repeat(8192) }] }),
  },
  {
    label: 'a small entry inflates past the default ratio cap',
    code: 'entry-ratio-cap',
    part: PART,
    build: () => buildZip({ entries: [{ name: PART, data: new Uint8Array(256 * 1024) }] }),
  },
  {
    label: 'the archive inflates past the total cap',
    code: 'total-bytes-cap',
    part: 'word/b.xml',
    limits: SMALL_LIMITS,
    build: () =>
      buildZip({
        entries: [
          { name: 'word/a.xml', data: 'a'.repeat(1024) },
          { name: 'word/b.xml', data: 'b'.repeat(1600) },
        ],
      }),
  },
  {
    label: 'a stored entry passes the total cap',
    code: 'total-bytes-cap',
    part: PART,
    limits: SMALL_LIMITS,
    build: () => buildZip({ entries: [{ name: PART, data: 'a'.repeat(3000), method: 0 }] }),
  },
];

for (const refusalCase of CASES) {
  test(`refuse ${refusalCase.code}: ${refusalCase.label}`, async () => {
    const refusal = await refused(await refusalCase.build(), refusalCase.limits);

    assert.equal(refusal.name, 'ZipRefusal');
    assert.equal(refusal.code, refusalCase.code);
    assert.ok(refusal.message.startsWith(`${refusalCase.code}: `));

    if (refusalCase.part === undefined) {
      assert.equal(refusal.part, null);
    } else {
      assert.equal(refusal.part, refusalCase.part);
      assert.ok(refusal.message.endsWith(`(${refusalCase.part})`));
    }
  });
}

test('every refusal code is pinned by a synthetic archive', () => {
  const covered = new Set(CASES.map((refusalCase) => refusalCase.code));

  assert.deepEqual(
    [...ZIP_REFUSAL_CODES].filter((code) => !covered.has(code)),
    [],
  );
});
