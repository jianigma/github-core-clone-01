// git-core.ts — pkt-line framing and packfiles (read + write, full objects only
// on the wire; deltas are resolved on read for robustness).

import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, sha1Hex, type GitObject, type ObjectType } from './core.ts';

export const PKT_LINE_MAX = 65520;

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > PKT_LINE_MAX) throw new Error(`pkt-line of ${len} bytes exceeds ${PKT_LINE_MAX}`);
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: ReadonlyArray<string | 'flush' | 'delim' | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface DecodedPacket {
  kind: PacketKind;
  payload: Buffer;
  /** Raw bytes including the 4-byte length prefix (0 for flush/delim). */
  raw: Buffer;
}

/** Decode a whole pkt-line stream (all packets, flushes included). Throws on truncation or a bad length. */
export function decodePktLines(buf: Buffer): DecodedPacket[] {
  const out: DecodedPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len), raw: buf.subarray(off, off + len) });
    off += len;
  }
  return out;
}

/**
 * Decode pkt-lines from the start of `buf`, stopping after the first flush
 * packet (or at the end). The bytes after the flush — a packfile in a push —
 * are returned untouched as `packStart`.
 */
export function decodePktLinesPrefix(buf: Buffer): { packets: DecodedPacket[]; packStart: number } {
  const packets: DecodedPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      return { packets, packStart: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buf.subarray(off, off + 4) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len), raw: buf.subarray(off, off + len) });
    off += len;
  }
  return { packets, packStart: buf.length };
}

/** Split a sideband payload stream into band-1 data chunks (for the push report). */
export function sidebandWrap(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = PKT_LINE_MAX - 4 - 1;
  let off = 0;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
  }
  while (off < data.length) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxPayload));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
    off += chunk.length;
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a version-2 pack of full (undeltified) objects, deterministic order. */
export function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Read one zlib stream starting at `offset`, knowing its uncompressed size. */
function inflateAt(buf: Buffer, offset: number, expectedSize: number, limit: number): { data: Buffer; consumed: number } {
  // Fast path (one inflate + one deflate): inflate the remainder once — the
  // call stops at the first stream's end — then re-deflate to recover the exact
  // compressed length. Packs in this contest are produced by deflateSync with
  // default options, so the re-deflate reproduces the original bytes exactly.
  const data = inflateSync(buf.subarray(offset, limit));
  if (data.length !== expectedSize) throw new Error('pack entry does not inflate to its declared size');
  const recompressed = deflateSync(data);
  const candidate = offset + recompressed.length;
  if (candidate <= limit && buf.subarray(offset, candidate).equals(recompressed)) {
    return { data, consumed: recompressed.length };
  }
  // Fallback (a foreign deflater): binary search for the smallest k that
  // inflates to the declared size.
  let lo = 1;
  let hi = limit - offset;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, offset + mid));
      if (out.length === expectedSize) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (ans < 0) throw new Error('pack entry does not inflate to its declared size');
  return { data, consumed: ans };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (p >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[p] as number;
      p += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const out: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p] as number;
    p += 1;
    if ((op & 0x80) !== 0) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) {
        if (p >= delta.length) throw new Error('truncated delta copy offset');
        off |= (delta[p] as number) << (i * 8);
        p += 1;
      }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) {
        if (p >= delta.length) throw new Error('truncated delta copy size');
        size |= (delta[p] as number) << (i * 8);
        p += 1;
      }
      if (size === 0) size = 0x10000;
      if (off + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(off, off + size));
    } else if (op !== 0) {
      if (p + op > delta.length) throw new Error('truncated delta insert');
      out.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackRead {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(buf: Buffer): PackRead {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1Hex(buf.subarray(0, buf.length - 20)) !== trailer) throw new Error('pack trailer checksum mismatch');
  const limit = buf.length - 20;
  const objects = new Map<string, GitObject>();
  // Deltas are resolved after the first pass: REF_DELTA names its base oid,
  // OFS_DELTA names its base by negative offset from the entry's first byte.
  const deltas: Array<{ baseOid: string | null; baseOffset: number | null; data: Buffer; entryStart: number }> = [];
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  let off = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    if (off >= limit) throw new Error('pack ends before its declared object count');
    const entryStart = off;
    let byte = buf[off] as number;
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (off >= limit) throw new Error('truncated pack entry header');
      byte = buf[off] as number;
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: the offset is stored as a negative offset from this entry's start.
      if (off >= limit) throw new Error('truncated ofs-delta offset');
      byte = buf[off] as number;
      off += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (off >= limit) throw new Error('truncated ofs-delta offset');
        byte = buf[off] as number;
        off += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - offset;
    } else if (typeCode === 7) {
      if (off + 20 > limit) throw new Error('truncated ref-delta base');
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (CODE_TYPES[typeCode] === undefined) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateAt(buf, off, size, limit);
    off += inflated.consumed;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      deltas.push({ baseOid, baseOffset, data: inflated.data, entryStart });
    } else {
      const type = CODE_TYPES[typeCode] as ObjectType;
      const oid = hashObject(type, inflated.data);
      objects.set(oid, { type, data: inflated.data });
      byOffset.set(entryStart, oid);
    }
  }
  // Resolve deltas in order: a delta's base may itself be a delta earlier in the pack.
  for (const delta of deltas) {
    let base: GitObject | undefined;
    if (delta.baseOid !== null) base = objects.get(delta.baseOid);
    else if (delta.baseOffset !== null) {
      const baseOid = byOffset.get(delta.baseOffset);
      if (baseOid !== undefined) base = objects.get(baseOid);
    }
    if (base === undefined) throw new Error('delta base is not in the pack');
    const data = applyDelta(base.data, delta.data);
    const oid = hashObject(base.type, data);
    objects.set(oid, { type: base.type, data });
    byOffset.set(delta.entryStart, oid);
  }
  return { version, declaredCount, objects, deltaCount };
}
