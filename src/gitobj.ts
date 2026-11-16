// git object primitives: hashing, pkt-lines, packfiles, trees, commits and tags.
//
// There is no git binary in the trial pod and no package to install, so everything a smart-HTTP
// server needs lives here on node:crypto and node:zlib: SHA-1 object ids, zlib object framing,
// packfile read (including OFS_DELTA and REF_DELTA) and packfile write.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** The id git gives an object: sha1 of "<type> <len>\0" plus its bytes. */
export function objectId(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'utf8'), data]));
}

/** The loose-object form: zlib of the same header plus the bytes. */
export function looseObject(type: ObjType, data: Buffer): Buffer {
  return zlib.deflateSync(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'utf8'), data]));
}

// ----------------------------------------------------------------- pkt-line

export interface DataPacket {
  kind: 'data';
  payload: Buffer;
}
export interface ControlPacket {
  kind: 'flush' | 'delim' | 'response-end';
}
export type Packet = DataPacket | ControlPacket;

export function pktLine(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export function pktLines(parts: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(FLUSH_PKT);
    else if (part === 'delim') out.push(DELIM_PKT);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/** Parse a pkt-line stream; a truncated or malformed stream stops at the damage. */
export function parsePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, rest: buf.subarray(pos) };
}

// ----------------------------------------------------------------- zlib

/**
 * Inflate one zlib stream out of `buf` at `offset`, reporting how many input bytes it consumed.
 *
 * node's inflate accepts trailing bytes and ignores them, and throws Z_BUF_ERROR while the stream
 * is incomplete; that makes the exact end of the stream the smallest prefix length that inflates.
 * The search is a binary search, so an object costs a handful of inflations.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const available = buf.length - offset;
  if (available <= 0) throw new Error('zlib stream is empty');
  let low = 1;
  let high = available;
  let best: Buffer | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    let out: Buffer | null = null;
    try {
      out = zlib.inflateSync(buf.subarray(offset, offset + mid));
    } catch {
      out = null;
    }
    if (out !== null) {
      best = out;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (best === null) throw new Error('no complete zlib stream at the offset');
  return { data: best, consumed: low };
}

// ----------------------------------------------------------------- delta

/** Apply a git delta (copy/insert instruction stream) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('truncated delta size');
      const byte = delta[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 56) throw new Error('delta size too long');
    }
  };
  const baseSize = readVarint();
  const targetSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta wants a ${baseSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) copyOffset += delta[pos++];
      if ((op & 0x02) !== 0) copyOffset += delta[pos++] * 2 ** 8;
      if ((op & 0x04) !== 0) copyOffset += delta[pos++] * 2 ** 16;
      if ((op & 0x08) !== 0) copyOffset += delta[pos++] * 2 ** 24;
      if ((op & 0x10) !== 0) copySize += delta[pos++];
      if ((op & 0x20) !== 0) copySize += delta[pos++] * 2 ** 8;
      if ((op & 0x40) !== 0) copySize += delta[pos++] * 2 ** 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy leaves the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
      continue;
    }
    if (op === 0) throw new Error('delta opcode 0');
    if (pos + op > delta.length) throw new Error('truncated delta insert');
    delta.copy(out, written, pos, pos + op);
    written += op;
    pos += op;
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ----------------------------------------------------------------- packfile

export interface PackReadResult {
  objects: Map<string, GitObject>;
  /** Deltas seen (ofs and ref), for the conformance detail lines. */
  deltaCount: number;
  declaredCount: number;
}

export interface PackReadOptions {
  /** A base object a thin pack leaves out, looked up by id. */
  resolveBase?: (oid: string) => GitObject | undefined;
}

/**
 * Read a packfile: version 2 or 3, zlib objects, OFS_DELTA and REF_DELTA resolved recursively
 * (thin-pack bases come from `options.resolveBase`), trailer checksum verified.
 */
export function readPack(buf: Buffer, options: PackReadOptions = {}): PackReadResult {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const body = buf.subarray(12, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20);
  const digest = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
  }
  const raws: Raw[] = [];
  let pos = 0;
  let deltaCount = 0;
  for (let index = 0; index < declaredCount; index += 1) {
    const start = pos;
    let byte = body[pos++];
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = body[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Raw = { offset: start, typeCode };
    if (typeCode === 6) {
      let value = body[pos++];
      let distance = value & 0x7f;
      while ((value & 0x80) !== 0) {
        value = body[pos++];
        distance = ((distance + 1) << 7) | (value & 0x7f);
      }
      entry.baseOffset = start - distance;
      deltaCount += 1;
    } else if (typeCode === 7) {
      entry.baseOid = body.toString('hex', pos, pos + 20);
      pos += 20;
      deltaCount += 1;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateAt(body, pos);
    pos += inflated.consumed;
    const payload = inflated.data;
    if (typeCode === 6 || typeCode === 7) {
      (entry as Raw & { delta: Buffer }).delta = payload;
    } else {
      entry.resolved = { type: CODE_TYPE[typeCode], data: payload };
    }
    raws.push(entry);
  }

  const byOffset = new Map<number, Raw>();
  for (const raw of raws) byOffset.set(raw.offset, raw);
  const byOid = new Map<string, GitObject>();
  const resolving = new Set<number>();

  const resolve = (raw: Raw): GitObject => {
    if (raw.resolved !== undefined) return raw.resolved;
    if (resolving.has(raw.offset)) throw new Error('delta cycle');
    resolving.add(raw.offset);
    let base: GitObject;
    if (raw.baseOffset !== undefined) {
      const baseRaw = byOffset.get(raw.baseOffset);
      if (baseRaw === undefined) throw new Error('ofs-delta base is not in the pack');
      base = resolve(baseRaw);
    } else {
      const oid = raw.baseOid ?? '';
      const inPack = byOid.get(oid);
      const supplied = options.resolveBase?.(oid);
      const found = inPack ?? supplied;
      if (found === undefined) throw new Error(`ref-delta base ${oid} is not in the pack`);
      base = found;
    }
    const delta = (raw as Raw & { delta: Buffer }).delta;
    const data = applyDelta(base.data, delta);
    const resolved: GitObject = { type: base.type, data };
    raw.resolved = resolved;
    byOid.set(objectId(resolved.type, data), resolved);
    resolving.delete(raw.offset);
    return resolved;
  };

  const objects = new Map<string, GitObject>();
  for (const raw of raws) {
    const object = resolve(raw);
    objects.set(objectId(object.type, object.data), object);
  }
  return { objects, deltaCount, declaredCount };
}

/** Build a packfile of plain objects (no deltas); the trailer is SHA-1 over everything before it. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    parts.push(Buffer.from([(TYPE_CODE[object.type] << 4) | (size & 0x0f) | (size > 0x0f ? 0x80 : 0x00)]));
    size = Math.floor(size / 16);
    while (size > 0) {
      parts.push(Buffer.from([(size & 0x7f) | (size > 0x7f ? 0x80 : 0x00)]));
      size = Math.floor(size / 128);
    }
    parts.push(zlib.deflateSync(object.data, { level: 1 }));
  }
  const digest = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(digest);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function modeText(mode: string): string {
  const numeric = parseInt(mode, 8);
  return numeric.toString(8);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const right = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${modeText(entry.mode)} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nul = data.indexOf(0, pos);
    if (nul < 0) break;
    const text = data.toString('utf8', pos, nul);
    const space = text.indexOf(' ');
    const mode = text.slice(0, space);
    const name = text.slice(space + 1);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

// ----------------------------------------------------------------- commits and tags

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[];
}

export function buildCommit(input: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer?: string;
  timestamp: number;
  timezone?: string;
  message: string;
}): Buffer {
  const zone = input.timezone ?? '+0000';
  const when = `${input.timestamp} ${zone}`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${when}`);
  lines.push(`committer ${input.committer ?? input.author} ${when}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.length > 0) extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

export interface TagData {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(input: { object: string; type: string; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger} ${input.timestamp} +0000\n\n${message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): TagData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Identity for a commit the forge itself makes ("Name <mail> <when>"). */
export function identity(name: string, email: string, timestamp: number): string {
  return `${name} <${email}> ${timestamp} +0000`;
}

/** Follow tag objects to the object they ultimately name (a commit, usually). */
export function peelObject(store: { objects: Map<string, GitObject> }, oid: string): string {
  let current = oid;
  for (let hop = 0; hop < 16; hop += 1) {
    const object = store.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}
