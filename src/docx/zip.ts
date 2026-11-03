export const ZIP_REFUSAL_CODES = [
  'bad-eocd',
  'bad-central-directory',
  'bad-local-header',
  'local-name-mismatch',
  'duplicate-part-name',
  'encrypted-entry',
  'zip64-marker',
  'unsupported-method',
  'entry-count-cap',
  'total-bytes-cap',
  'entry-ratio-cap',
  'declared-size-mismatch',
  'crc-mismatch',
  'overlapping-entries',
  'inflate-failed',
] as const;

export type ZipRefusalCode = (typeof ZIP_REFUSAL_CODES)[number];

export class ZipRefusal extends Error {
  readonly code: ZipRefusalCode;
  readonly part: string | null;

  constructor(code: ZipRefusalCode, detail: string, part: string | null = null) {
    super(part === null ? `${code}: ${detail}` : `${code}: ${detail} (${part})`);
    this.name = 'ZipRefusal';
    this.code = code;
    this.part = part;
  }
}

const refuse = (code: ZipRefusalCode, detail: string, part: string | null = null): never => {
  throw new ZipRefusal(code, detail, part);
};

export type ZipLimits = {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryRatio: number;
  minEntryBytes: number;
};

// minEntryBytes keeps the ratio from refusing a tiny part that legitimately inflates.
export const ZIP_LIMITS: ZipLimits = {
  maxEntries: 256,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntryRatio: 200,
  minEntryBytes: 64 * 1024,
};

export type ZipEntry = { name: string; bytes: Uint8Array };

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;
const SENTINEL_16 = 0xffff;
const SENTINEL_32 = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP64_VERSION = 45;
const ENCRYPTION_FLAGS = 0x0041;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

type Reader = { bytes: Uint8Array; view: DataView };

const u16 = (reader: Reader, at: number): number => reader.view.getUint16(at, true);
const u32 = (reader: Reader, at: number): number => reader.view.getUint32(at, true);

const within = (reader: Reader, at: number, length: number): boolean =>
  at >= 0 && length >= 0 && at + length <= reader.bytes.length;

const NAMES = new TextDecoder('utf-8');

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const hasZip64Extra = (reader: Reader, at: number, length: number): boolean => {
  let cursor = at;
  while (cursor + 4 <= at + length) {
    if (u16(reader, cursor) === ZIP64_EXTRA_ID) {
      return true;
    }
    cursor += 4 + u16(reader, cursor + 2);
  }
  return false;
};

type CentralEntry = {
  name: string;
  nameBytes: Uint8Array;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

type LocatedEntry = CentralEntry & { headerStart: number; dataStart: number; dataEnd: number };

const findEocd = (reader: Reader): number => {
  const floor = Math.max(0, reader.bytes.length - EOCD_SIZE - MAX_COMMENT);
  for (let at = reader.bytes.length - EOCD_SIZE; at >= floor; at -= 1) {
    const comment = reader.bytes.length - at - EOCD_SIZE;
    if (u32(reader, at) === EOCD_SIGNATURE && u16(reader, at + 20) === comment) {
      return at;
    }
  }
  return refuse('bad-eocd', 'no end-of-central-directory record');
};

const readCentral = (
  reader: Reader,
  cdOffset: number,
  cdSize: number,
  total: number,
): CentralEntry[] => {
  const entries: CentralEntry[] = [];
  const folded = new Set<string>();
  const end = cdOffset + cdSize;
  let at = cdOffset;

  for (let index = 0; index < total; index += 1) {
    if (
      !within(reader, at, CENTRAL_HEADER_SIZE) ||
      at + CENTRAL_HEADER_SIZE > end ||
      u32(reader, at) !== CENTRAL_SIGNATURE
    ) {
      return refuse('bad-central-directory', `no header at offset ${at}`);
    }

    const versionNeeded = u16(reader, at + 6);
    const flags = u16(reader, at + 8);
    const method = u16(reader, at + 10);
    const crc = u32(reader, at + 16);
    const compressedSize = u32(reader, at + 20);
    const uncompressedSize = u32(reader, at + 24);
    const nameLength = u16(reader, at + 28);
    const extraLength = u16(reader, at + 30);
    const commentLength = u16(reader, at + 32);
    const diskStart = u16(reader, at + 34);
    const localOffset = u32(reader, at + 42);
    const nameAt = at + CENTRAL_HEADER_SIZE;
    const next = nameAt + nameLength + extraLength + commentLength;

    if (next > end || !within(reader, nameAt, nameLength + extraLength + commentLength)) {
      return refuse('bad-central-directory', 'a header runs past the directory');
    }
    if (nameLength === 0) {
      return refuse('bad-central-directory', 'an entry has an empty name');
    }

    const nameBytes = reader.bytes.slice(nameAt, nameAt + nameLength);
    const name = NAMES.decode(nameBytes);

    if ((flags & ENCRYPTION_FLAGS) !== 0) {
      refuse('encrypted-entry', 'an encryption flag is set', name);
    }
    if (
      versionNeeded >= ZIP64_VERSION ||
      diskStart === SENTINEL_16 ||
      compressedSize === SENTINEL_32 ||
      uncompressedSize === SENTINEL_32 ||
      localOffset === SENTINEL_32 ||
      hasZip64Extra(reader, nameAt + nameLength, extraLength)
    ) {
      refuse('zip64-marker', 'the entry is marked zip64', name);
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      refuse('unsupported-method', `method ${method} is neither stored nor deflated`, name);
    }

    // OPC part names are case-insensitive: two entries folding together are two readings.
    if (!name.endsWith('/')) {
      const key = name.toLowerCase();
      if (folded.has(key)) {
        refuse('duplicate-part-name', 'two part names are equal under case folding', name);
      }
      folded.add(key);
    }

    entries.push({ name, nameBytes, method, crc, compressedSize, uncompressedSize, localOffset });
    at = next;
  }

  if (at !== end) {
    refuse('bad-central-directory', 'the central directory has trailing bytes');
  }

  return entries;
};

const locateEntry = (reader: Reader, entry: CentralEntry, cdOffset: number): LocatedEntry => {
  const at = entry.localOffset;

  if (!within(reader, at, LOCAL_HEADER_SIZE) || u32(reader, at) !== LOCAL_SIGNATURE) {
    return refuse('bad-local-header', `no local file header at offset ${at}`, entry.name);
  }

  const flags = u16(reader, at + 6);
  const method = u16(reader, at + 8);
  const compressedSize = u32(reader, at + 18);
  const uncompressedSize = u32(reader, at + 22);
  const nameLength = u16(reader, at + 26);
  const extraLength = u16(reader, at + 28);
  const nameAt = at + LOCAL_HEADER_SIZE;

  if (!within(reader, nameAt, nameLength + extraLength)) {
    return refuse('bad-local-header', 'the header runs past the archive', entry.name);
  }
  if ((flags & ENCRYPTION_FLAGS) !== 0) {
    refuse('encrypted-entry', 'an encryption flag is set', entry.name);
  }
  if (hasZip64Extra(reader, nameAt + nameLength, extraLength)) {
    refuse('zip64-marker', 'a zip64 extra field is present', entry.name);
  }
  if (!sameBytes(reader.bytes.subarray(nameAt, nameAt + nameLength), entry.nameBytes)) {
    refuse('local-name-mismatch', 'the local header names another part', entry.name);
  }
  if (method !== entry.method) {
    refuse('bad-local-header', 'the method differs from the central directory', entry.name);
  }
  if (
    (flags & FLAG_DATA_DESCRIPTOR) === 0 &&
    (compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize)
  ) {
    refuse('declared-size-mismatch', 'the local header declares other sizes', entry.name);
  }

  const dataStart = nameAt + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > cdOffset) {
    refuse('bad-local-header', 'the entry data overruns the central directory', entry.name);
  }

  return { ...entry, headerStart: at, dataStart, dataEnd };
};

const refuseOverlaps = (located: readonly LocatedEntry[]): void => {
  const spans = [...located].sort((a, b) => a.headerStart - b.headerStart);

  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous.dataEnd > current.headerStart) {
      refuse(
        'overlapping-entries',
        `${previous.name} runs into the header of ${current.name}`,
        current.name,
      );
    }
  }
};

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

type Inflated = { bytes: Uint8Array; capped: boolean };

// The cap is enforced on bytes the stream actually produces, so a lying header cannot raise it.
const inflateCapped = async (payload: Uint8Array, cap: number, part: string): Promise<Inflated> => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let produced = 0;

  try {
    for (;;) {
      const step = await reader.read();
      if (step.done === true) {
        break;
      }
      const chunk = step.value as Uint8Array | undefined;
      if (chunk === undefined) {
        break;
      }
      chunks.push(chunk);
      produced += chunk.length;
      if (produced > cap) {
        await reader.cancel();
        return { bytes: concat(chunks, produced), capped: true };
      }
    }
  } catch {
    return refuse('inflate-failed', 'the deflate stream could not be read', part);
  }

  return { bytes: concat(chunks, produced), capped: false };
};

const capFor = (
  entry: LocatedEntry,
  remaining: number,
  limits: ZipLimits,
): { cap: number; code: ZipRefusalCode } => {
  const ratio = Math.max(limits.minEntryBytes, entry.compressedSize * limits.maxEntryRatio);
  return ratio <= remaining
    ? { cap: ratio, code: 'entry-ratio-cap' }
    : { cap: remaining, code: 'total-bytes-cap' };
};

export const readZip = async (
  input: Uint8Array,
  limits: ZipLimits = ZIP_LIMITS,
): Promise<ZipEntry[]> => {
  const reader: Reader = {
    bytes: input,
    view: new DataView(input.buffer, input.byteOffset, input.byteLength),
  };

  const eocd = findEocd(reader);

  if (eocd >= 20 && u32(reader, eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    refuse('zip64-marker', 'a zip64 locator precedes the record');
  }

  const diskNumber = u16(reader, eocd + 4);
  const centralDisk = u16(reader, eocd + 6);
  const entriesOnDisk = u16(reader, eocd + 8);
  const totalEntries = u16(reader, eocd + 10);
  const cdSize = u32(reader, eocd + 12);
  const cdOffset = u32(reader, eocd + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    refuse('bad-eocd', 'the archive is split across disks');
  }
  if (totalEntries === SENTINEL_16 || cdSize === SENTINEL_32 || cdOffset === SENTINEL_32) {
    refuse('zip64-marker', 'the record carries zip64 sentinels');
  }
  if (totalEntries > limits.maxEntries) {
    refuse('entry-count-cap', `${totalEntries} entries, cap is ${limits.maxEntries}`);
  }
  if (cdOffset + cdSize > eocd) {
    refuse('bad-central-directory', 'the directory does not fit before the record');
  }

  const central = readCentral(reader, cdOffset, cdSize, totalEntries);
  const located = central.map((entry) => locateEntry(reader, entry, cdOffset));
  refuseOverlaps(located);

  const parts: ZipEntry[] = [];
  let produced = 0;

  for (const entry of located) {
    if (entry.name.endsWith('/')) {
      continue;
    }

    const { cap, code } = capFor(entry, limits.maxTotalBytes - produced, limits);
    let bytes: Uint8Array;

    if (entry.method === METHOD_STORE) {
      if (entry.compressedSize > cap) {
        refuse(code, `the entry passes the cap at ${cap} bytes`, entry.name);
      }
      bytes = input.slice(entry.dataStart, entry.dataEnd);
    } else {
      const inflated = await inflateCapped(
        input.subarray(entry.dataStart, entry.dataEnd),
        cap,
        entry.name,
      );
      if (inflated.capped) {
        refuse(code, `inflation passes the cap at ${cap} bytes`, entry.name);
      }
      bytes = inflated.bytes;
    }

    if (bytes.length !== entry.uncompressedSize) {
      refuse(
        'declared-size-mismatch',
        `the header declares ${entry.uncompressedSize} bytes, ${bytes.length} came out`,
        entry.name,
      );
    }
    if (crc32(bytes) !== entry.crc) {
      refuse('crc-mismatch', 'the crc-32 does not match the bytes', entry.name);
    }

    produced += bytes.length;
    parts.push({ name: entry.name, bytes });
  }

  return parts;
};

export const findPart = (entries: readonly ZipEntry[], name: string): ZipEntry | null => {
  const folded = name.toLowerCase();
  return entries.find((entry) => entry.name.toLowerCase() === folded) ?? null;
};
