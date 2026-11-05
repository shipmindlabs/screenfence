// A test-only ZIP writer. Every field a reader could disagree with is an override, so a test can
// build the one malformed archive it wants to pin instead of laying out bytes by hand.

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const VERSION = 20;
const EMPTY = new Uint8Array(0);

const encoder = new TextEncoder();

export type ZipEntryInput = {
  name: string;
  data?: Uint8Array | string;
  method?: number;
  payload?: Uint8Array;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  flags?: number;
  versionNeeded?: number;
  diskStart?: number;
  extra?: Uint8Array;
  localName?: string;
  localMethod?: number;
  localFlags?: number;
  localCompressedSize?: number;
  localUncompressedSize?: number;
  localExtra?: Uint8Array;
  localSignature?: number;
};

export type ZipArchiveInput = {
  entries: readonly ZipEntryInput[];
  diskNumber?: number;
  centralDisk?: number;
  entriesOnDisk?: number;
  totalEntries?: number;
  cdOffset?: number;
  cdSize?: number;
  comment?: string;
  zip64Locator?: boolean;
  eocdSignature?: number;
};

// Bitwise and table-free, so it shares no implementation with the reader under test.
export const crc32Bitwise = (input: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const zip64Extra = (): Uint8Array => {
  const field = new Uint8Array(20);
  field[0] = 0x01;
  field[2] = 0x10;
  return field;
};

const u16 = (value: number): readonly number[] => [value & 0xff, (value >>> 8) & 0xff];

const u32 = (value: number): readonly number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];

const deflateRaw = async (input: Uint8Array): Promise<Uint8Array> => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

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
    total += chunk.length;
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

type Prepared = {
  nameBytes: Uint8Array;
  extra: Uint8Array;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  versionNeeded: number;
  diskStart: number;
  localOffset: number;
};

const contentOf = (data: Uint8Array | string | undefined): Uint8Array => {
  if (data === undefined) {
    return EMPTY;
  }
  return typeof data === 'string' ? encoder.encode(data) : data;
};

export const buildZip = async (archive: ZipArchiveInput): Promise<Uint8Array> => {
  const out: number[] = [];

  const write = (values: readonly number[]): void => {
    for (const value of values) {
      out.push(value);
    }
  };

  const writeBytes = (input: Uint8Array): void => {
    for (const byte of input) {
      out.push(byte);
    }
  };

  const prepared: Prepared[] = [];

  for (const input of archive.entries) {
    const content = contentOf(input.data);
    const method = input.method ?? 8;
    const payload = input.payload ?? (method === 8 ? await deflateRaw(content) : content);
    const nameBytes = encoder.encode(input.name);
    const localNameBytes = encoder.encode(input.localName ?? input.name);
    const localExtra = input.localExtra ?? EMPTY;
    const flags = input.flags ?? 0;
    const crc = input.crc ?? crc32Bitwise(content);
    const compressedSize = input.compressedSize ?? payload.length;
    const uncompressedSize = input.uncompressedSize ?? content.length;
    const localOffset = out.length;

    write(u32(input.localSignature ?? LOCAL_SIGNATURE));
    write(u16(VERSION));
    write(u16(input.localFlags ?? flags));
    write(u16(input.localMethod ?? method));
    write(u16(0));
    write(u16(0));
    write(u32(crc));
    write(u32(input.localCompressedSize ?? compressedSize));
    write(u32(input.localUncompressedSize ?? uncompressedSize));
    write(u16(localNameBytes.length));
    write(u16(localExtra.length));
    writeBytes(localNameBytes);
    writeBytes(localExtra);
    writeBytes(payload);

    prepared.push({
      nameBytes,
      extra: input.extra ?? EMPTY,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      versionNeeded: input.versionNeeded ?? VERSION,
      diskStart: input.diskStart ?? 0,
      localOffset,
    });
  }

  const cdStart = out.length;

  for (const entry of prepared) {
    write(u32(CENTRAL_SIGNATURE));
    write(u16(VERSION));
    write(u16(entry.versionNeeded));
    write(u16(entry.flags));
    write(u16(entry.method));
    write(u16(0));
    write(u16(0));
    write(u32(entry.crc));
    write(u32(entry.compressedSize));
    write(u32(entry.uncompressedSize));
    write(u16(entry.nameBytes.length));
    write(u16(entry.extra.length));
    write(u16(0));
    write(u16(entry.diskStart));
    write(u16(0));
    write(u32(0));
    write(u32(entry.localOffset));
    writeBytes(entry.nameBytes);
    writeBytes(entry.extra);
  }

  const cdEnd = out.length;

  if (archive.zip64Locator === true) {
    write(u32(ZIP64_LOCATOR_SIGNATURE));
    write(u32(0));
    write(u32(0));
    write(u32(0));
    write(u32(1));
  }

  const comment = encoder.encode(archive.comment ?? '');

  write(u32(archive.eocdSignature ?? EOCD_SIGNATURE));
  write(u16(archive.diskNumber ?? 0));
  write(u16(archive.centralDisk ?? 0));
  write(u16(archive.entriesOnDisk ?? archive.totalEntries ?? prepared.length));
  write(u16(archive.totalEntries ?? prepared.length));
  write(u32(archive.cdSize ?? cdEnd - cdStart));
  write(u32(archive.cdOffset ?? cdStart));
  write(u16(comment.length));
  writeBytes(comment);

  return new Uint8Array(out);
};
