import zlib from "node:zlib";

// 使用率月度包的二进制容器（PKMB v1）。
//
// 布局与 docs/usage-pack.md 一致：文件头 + 分区目录，后面依次是
// Metadata / Dictionary / FormatIndex / 每个格式一个数据块。
// 数据块按「列式 + 位打包 + CSR 稀疏统计」编码，每块单独 gzip，
// 这样读某个月某个格式只要解那几十 KB，而不是整包几 MB。
//
// 这个文件同时提供编码与解码：编码器产物用解码器自检（往返一致），
// Kotlin 端的解析器必须与 decode 的行为逐字段对齐。

const MAGIC = Buffer.from("PKMB", "ascii");
const VERSION = 1;
const T_META = 1;
const T_DICT = 2;
const T_INDEX = 3;
const T_DATA = 4;
const A_NONE = 0;
const A_GZIP = 1;
const ENTRY_SIZE = 32;
const HEADER_SIZE = 16;

const STAT_KEYS = ["sp", "mv", "it", "ab", "te"];

const bitLen = (max) => Math.max(1, Math.ceil(Math.log2(max + 1)) || 1);

class BitWriter {
  constructor() {
    this.chunks = [];
    this.cur = Buffer.alloc(1 << 16);
    this.n = 0;
    this.acc = 0;
    this.nb = 0;
  }
  write(v, bits) {
    let x = v >>> 0;
    while (bits > 0) {
      const space = 8 - this.nb;
      const take = bits < space ? bits : space;
      this.acc |= (x & ((1 << take) - 1)) << this.nb;
      x >>>= take;
      bits -= take;
      this.nb += take;
      if (this.nb === 8) { this.#push(this.acc); this.acc = 0; this.nb = 0; }
    }
  }
  #push(b) {
    if (this.n === this.cur.length) { this.chunks.push(this.cur); this.cur = Buffer.alloc(1 << 16); this.n = 0; }
    this.cur[this.n++] = b;
  }
  done(bits) {
    const out = Buffer.alloc(Math.ceil(bits / 8));
    let i = 0;
    for (const c of this.chunks) { c.copy(out, i); i += c.length; }
    this.cur.copy(out, i, 0, this.n);
    if (this.nb) out[out.length - 1] = this.acc;
    return out;
  }
}

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; this.acc = 0; this.nb = 0; }
  read(bits) {
    let out = 0;
    let shift = 0;
    let left = bits;
    while (left > 0) {
      if (this.nb === 0) { this.acc = this.buf[this.pos++] ?? 0; this.nb = 8; }
      const take = left < this.nb ? left : this.nb;
      out |= (this.acc & ((1 << take) - 1)) << shift;
      this.acc >>>= take;
      this.nb -= take;
      left -= take;
      shift += take;
    }
    return out >>> 0;
  }
  skip(bits) { this.pos += Math.floor(bits / 8); this.nb = bits % 8; }
}

class Cursor {
  constructor(buf) { this.buf = buf; this.p = 0; }
  u8() { return this.buf[this.p++]; }
  u16() { const v = this.buf.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.p); this.p += 4; return v; }
  bytes(n) { const v = this.buf.subarray(this.p, this.p + n); this.p += n; return v; }
}

function statsOf(mon) {
  const out = [];
  for (const k of STAT_KEYS) {
    const arr = mon[k];
    if (arr === undefined) continue;
    for (const row of arr) out.push([k, row]);
  }
  return out;
}

export function encodeUsagePack(doc) {
  const dict = doc.dict.slice();
  const dictIndex = new Map(dict.map((s, i) => [s, i]));
  const idOf = (s) => {
    let id = dictIndex.get(s);
    if (id === undefined) { id = dict.length; dictIndex.set(s, id); dict.push(s); }
    return id;
  };

  const names = Object.keys(doc.formats);
  const enriched = names.map((name) => {
    const f = doc.formats[name];
    return { name, nameId: idOf(name), f, eloIds: f.elos.map(idOf) };
  });

  // 位宽取全文件最大，一次写在每块头部：保证同一个月内各块自描述，
  // 下个月数据变大时也能自然升级，不会溢出（RULE-3）。
  let maxN = 0, maxU = 0, maxVc = 0, maxId = 0, maxCnt = 0;
  const blocks = [];
  for (const { f } of enriched) {
    for (const m of f.mons) {
      maxN = Math.max(maxN, m.n);
      for (const v of m.u || []) maxU = Math.max(maxU, v || 0);
      for (const v of m.vc || []) maxVc = Math.max(maxVc, v || 0);
      for (const st of statsOf(m)) {
        maxId = Math.max(maxId, st[1][0]);
        for (let c = 1; c < st[1].length; c++) maxCnt = Math.max(maxCnt, st[1][c] || 0);
      }
    }
  }
  const bitsN = bitLen(maxN), bitsU = bitLen(maxU), bitsVc = bitLen(maxVc);
  const bitsId = bitLen(maxId), bitsCnt = bitLen(maxCnt);

  for (const { f } of enriched) {
    const M = f.mons.length;
    const E = f.elos.length;
    if (E > 8) throw new Error("elos 超过 8 档：" + E);
    const parts = [];
    const head = Buffer.alloc(9);
    head.writeUInt32LE(M, 0);
    head[4] = E;
    head[5] = bitsN; head[6] = bitsU; head[7] = bitsVc; head[8] = bitsId;
    // bitsCnt 跟在后面
    parts.push(head, Buffer.from([bitsCnt]));

    const colN = new BitWriter();
    for (const m of f.mons) colN.write(m.n, bitsN);
    parts.push(colN.done(M * bitsN));

    for (let e = 0; e < E; e++) {
      const w = new BitWriter();
      for (const m of f.mons) w.write((m.u && m.u[e]) || 0, bitsU);
      parts.push(w.done(M * bitsU));
    }
    for (let e = 0; e < E; e++) {
      const w = new BitWriter();
      for (const m of f.mons) w.write((m.vc && m.vc[e]) || 0, bitsVc);
      parts.push(w.done(M * bitsVc));
    }

    // 每组统计各自一张存在位图：旧月份里太晶是整组缺失，套用「五组同步」会丢信息
    for (const k of STAT_KEYS) {
      const presence = Buffer.alloc(Math.ceil(M / 8));
      for (let i = 0; i < M; i++) {
        if (f.mons[i][k] !== undefined) presence[i >> 3] |= 1 << (i & 7);
      }
      parts.push(presence);

      const ids = new BitWriter(), masks = new BitWriter(), vals = new BitWriter();
      const offsets = Buffer.alloc(4 * (M + 1));
      let rows = 0, valueCount = 0;
      for (let i = 0; i < M; i++) {
        offsets.writeUInt32LE(rows, 4 * i);
        const arr = f.mons[i][k];
        if (arr) for (const row of arr) {
          ids.write(row[0], bitsId);
          let mask = 0;
          for (let c = 1; c < row.length; c++) if (row[c]) mask |= 1 << (c - 1);
          masks.write(mask, E);
          for (let c = 1; c < row.length; c++) if (row[c]) { vals.write(row[c], bitsCnt); valueCount++; }
          rows++;
        }
      }
      offsets.writeUInt32LE(rows, 4 * M);
      const total = Buffer.alloc(4);
      total.writeUInt32LE(rows, 0);
      parts.push(total, offsets, ids.done(rows * bitsId), masks.done(rows * E), vals.done(valueCount * bitsCnt));
    }

    blocks.push(Buffer.concat(parts));
  }

  // 字典段
  const strings = Buffer.concat(dict.map((s) => Buffer.from(s, "utf8")));
  const offsets = Buffer.alloc(4 * (dict.length + 1));
  let off = 0;
  for (let i = 0; i < dict.length; i++) { offsets.writeUInt32LE(off, 4 * i); off += Buffer.byteLength(dict[i], "utf8"); }
  offsets.writeUInt32LE(off, 4 * dict.length);
  const dictRaw = Buffer.concat([Buffer.from([0, 0, 0, 0]), offsets, strings]);
  dictRaw.writeUInt32LE(dict.length, 0);

  // 索引段
  const indexParts = [Buffer.alloc(2)];
  indexParts[0].writeUInt16LE(enriched.length, 0);
  enriched.forEach(({ nameId, f, eloIds }, i) => {
    const b = Buffer.alloc(4 + 1 + 4 * f.elos.length + 4 * f.elos.length + 4 + 2);
    let p = 0;
    b.writeUInt32LE(nameId, p); p += 4;
    b[4] = f.elos.length; p = 5;
    for (const id of eloIds) { b.writeUInt32LE(id, p); p += 4; }
    for (const bt of f.battles) { b.writeUInt32LE(bt, p); p += 4; }
    b.writeUInt32LE(f.mons.length, p); p += 4;
    b.writeUInt16LE(3 + i, p); p += 2;
    indexParts.push(b);
  });
  const indexRaw = Buffer.concat(indexParts);

  // 元数据段
  const monthBytes = Buffer.from(doc.month, "utf8");
  const sourceBytes = Buffer.from(doc.source || "", "utf8");
  const metaRaw = Buffer.concat([
    Buffer.from([monthBytes.length & 0xff, monthBytes.length >> 8]), monthBytes,
    Buffer.from([sourceBytes.length & 0xff, sourceBytes.length >> 8]), sourceBytes,
  ]);

  const sections = [
    { type: T_META, algo: A_NONE, raw: metaRaw },
    { type: T_DICT, algo: A_GZIP, raw: dictRaw },
    { type: T_INDEX, algo: A_GZIP, raw: indexRaw },
    ...blocks.map((raw) => ({ type: T_DATA, algo: A_GZIP, raw })),
  ];
  for (const s of sections) {
    s.data = s.algo === A_GZIP ? zlib.gzipSync(s.raw, { level: 9 }) : s.raw;
    s.crc = zlib.crc32(s.raw);
  }

  const dirSize = sections.length * ENTRY_SIZE;
  let offset = HEADER_SIZE + dirSize;
  for (const s of sections) { s.offset = offset; offset += s.data.length; }

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(sections.length, 8);
  header.writeUInt16LE(0, 10);

  const dir = Buffer.alloc(dirSize);
  sections.forEach((s, i) => {
    const p = i * ENTRY_SIZE;
    dir.writeUInt16LE(s.type, p);
    dir.writeUInt16LE(s.algo, p + 2);
    dir.writeBigUInt64LE(BigInt(s.offset), p + 4);
    dir.writeBigUInt64LE(BigInt(s.data.length), p + 12);
    dir.writeBigUInt64LE(BigInt(s.raw.length), p + 20);
    dir.writeUInt32LE(s.crc >>> 0, p + 28);
  });

  return {
    bytes: Buffer.concat([header, dir, ...sections.map((s) => s.data)]),
    stats: { sections: sections.length, dictRaw: dictRaw.length, indexRaw: indexRaw.length,
      blocksRaw: blocks.reduce((a, b) => a + b.length, 0),
      blocksGzip: sections.filter((s) => s.type === T_DATA).reduce((a, s) => a + s.data.length, 0),
      dictGzip: sections[1].data.length },
  };
}

// only: 只解这些 format（校验、单格式读盘时用），其余格式的 mons 留空。
// 一个 format 一个 DATA 段，跳过别的段就不必把它们解到内存里。
export function decodeUsagePack(bytes, only = null) {
  if (bytes.subarray(0, 4).toString("ascii") !== "PKMB") throw new Error("不是 PKMB 包");
  const c = new Cursor(bytes);
  c.bytes(4);
  const version = c.u16();
  if (version !== VERSION) throw new Error("版本不支持：" + version);
  c.u16();
  const count = c.u16();
  c.u16();
  c.bytes(4); // 头部补齐到 16 字节
  const entries = [];
  for (let i = 0; i < count; i++) {
    const type = c.u16(), algo = c.u16();
    const offset = Number(c.bytes(8).readBigUInt64LE(0));
    const compSize = Number(c.bytes(8).readBigUInt64LE(0));
    const rawSize = Number(c.bytes(8).readBigUInt64LE(0));
    const crc = c.u32();
    entries.push({ type, algo, offset, compSize, rawSize, crc });
  }
  const raw = (i) => {
    const e = entries[i];
    const d = bytes.subarray(e.offset, e.offset + e.compSize);
    const out = e.algo === A_GZIP ? zlib.gunzipSync(d) : d;
    if (out.length !== e.rawSize) throw new Error("段长度不符：" + i);
    if ((zlib.crc32(out) >>> 0) !== (e.crc >>> 0)) throw new Error("校验和不符：" + i);
    return out;
  };

  const mc = new Cursor(raw(0));
  const month = mc.bytes(mc.u16()).toString("utf8");
  const source = mc.bytes(mc.u16()).toString("utf8");

  const dc = new Cursor(raw(1));
  const dictCount = dc.u32();
  const offs = [];
  for (let i = 0; i <= dictCount; i++) offs.push(dc.u32());
  const dictBytes = dc.buf.subarray(dc.p);
  const dict = [];
  for (let i = 0; i < dictCount; i++) dict.push(dictBytes.subarray(offs[i], offs[i + 1]).toString("utf8"));

  const ic = new Cursor(raw(2));
  const formatCount = ic.u16();
  const formats = {};
  const metas = [];
  for (let i = 0; i < formatCount; i++) {
    const nameId = ic.u32();
    const eloCount = ic.u8();
    const eloIds = [];
    for (let e = 0; e < eloCount; e++) eloIds.push(ic.u32());
    const battles = [];
    for (let e = 0; e < eloCount; e++) battles.push(ic.u32());
    const monCount = ic.u32();
    const sectionIndex = ic.u16();
    const name = dict[nameId];
    metas.push({ name, eloIds, battles, monCount, sectionIndex });
    formats[name] = { elos: eloIds.map((id) => dict[id]), battles, mons: [] };
  }

  for (const meta of metas) {
    if (only && !only.includes(meta.name)) continue;
    const d = raw(meta.sectionIndex);
    const k = new Cursor(d);
    const M = k.u32();
    const E = k.u8();
    const bitsN = k.u8(), bitsU = k.u8(), bitsVc = k.u8(), bitsId = k.u8();
    const bitsCnt = k.u8();
    let p = k.p;
    const take = (bits) => { const n = Math.ceil(bits / 8); const b = d.subarray(p, p + n); p += n; return b; };
    const colN = take(M * bitsN);
    const us = [], vcs = [];
    for (let e = 0; e < E; e++) us.push(take(M * bitsU));
    for (let e = 0; e < E; e++) vcs.push(take(M * bitsVc));
    // presence 位图不在这里读：它跟着各统计组自己走
    const rn = new BitReader(colN);
    const mons = [];
    for (let i = 0; i < M; i++) mons.push({ n: rn.read(bitsN), u: [], vc: [] });
    for (let e = 0; e < E; e++) {
      const r = new BitReader(us[e]);
      for (let i = 0; i < M; i++) mons[i].u.push(r.read(bitsU));
    }
    for (let e = 0; e < E; e++) {
      const r = new BitReader(vcs[e]);
      for (let i = 0; i < M; i++) mons[i].vc.push(r.read(bitsVc));
    }

    for (const ka of STAT_KEYS) {
      // 存在位图按字节切（它记的是每行有没有这一组，不是位数）
      const presenceBytes = Math.ceil(M / 8);
      const presence = d.subarray(p, p + presenceBytes);
      p += presenceBytes;
      const total = d.readUInt32LE(p); p += 4;
      const offsList = [];
      for (let i = 0; i <= M; i++) { offsList.push(d.readUInt32LE(p)); p += 4; }
      const idsBuf = take(total * bitsId);
      const maskBuf = take(total * E);
      const maskScan = new BitReader(maskBuf);
      let valueCount = 0;
      for (let i = 0; i < total; i++) valueCount += popcount(maskScan.read(E));
      const valBuf = take(valueCount * bitsCnt);
      const ids = new BitReader(idsBuf);
      const vals = new BitReader(valBuf);
      const maskReader = new BitReader(maskBuf);
      let row = 0;
      for (let i = 0; i < M; i++) {
        const from = offsList[i], to = offsList[i + 1];
        const present = (presence[i >> 3] & (1 << (i & 7))) !== 0;
        if (from === to) {
          // 行数为 0 时靠位图区分「这一组为空数组」与「这一组整块缺失」
          if (present) mons[i][ka] = [];
          continue;
        }
        const arr = [];
        for (let r = from; r < to; r++) {
          const id = ids.read(bitsId);
          const mask = maskReader.read(E);
          const share = [id];
          for (let e = 0; e < E; e++) share.push(mask & (1 << e) ? vals.read(bitsCnt) : 0);
          arr.push(share);
        }
        mons[i][ka] = arr;
      }
    }
    formats[meta.name].mons = mons;
  }
  return { month, source, dict, formats };
}

function popcount(mask) {
  let n = 0;
  for (let m = mask; m; m >>>= 1) n += m & 1;
  return n;
}

export const PACK_SUFFIX = ".pack";
export { STAT_KEYS };
