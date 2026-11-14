import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { encodeUsagePack, decodeUsagePack } from "./lib/usage-pack.mjs";

// 把裁剪后的使用率 JSON（或 .json.gz）转成 PKMB 二进制包。
//
//   node tools/gen-usage-pack.mjs <in.json|in.json.gz> <out.pack> [--verify]
//
// gen-usage-stats.mjs 生成 JSON 之后调用它；批量转换历史月份也用它。
const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const verify = process.argv.includes("--verify");
if (!input || !output) {
  console.error("用法: node tools/gen-usage-pack.mjs <in.json|in.json.gz> <out.pack> [--verify]");
  process.exit(1);
}

const raw = fs.readFileSync(input);
// 按魔数判断是不是 gzip：历史月份的文件名五花八门，扩展名不可靠
const gzInput = raw[0] === 0x1f && raw[1] === 0x8b;
const text = (gzInput ? zlib.gunzipSync(raw) : raw).toString("utf8");
const doc = JSON.parse(text);

const t0 = process.hrtime.bigint();
const { bytes, stats } = encodeUsagePack(doc);
const t1 = process.hrtime.bigint();
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, bytes);

let ok = null;
let mismatch = null;
let decodeMs = null;
if (verify) {
  // 逐 format 解码比对：一次只持有一个块的副本，整包全解会撑爆堆
  const names = Object.keys(doc.formats);
  const t2 = process.hrtime.bigint();
  ok = true;
  for (const name of names) {
    const back = decodeUsagePack(bytes, [name]);
    if (!back.month || back.month !== doc.month || back.source !== doc.source) { ok = false; mismatch = "month/source"; break; }
    const a = doc.formats[name], b = back.formats[name];
    if (!b) { ok = false; mismatch = name + " 缺失"; break; }
    if (a.elos.join(",") !== b.elos.join(",") || a.battles.join(",") !== b.battles.join(",") ||
        a.mons.length !== b.mons.length) { ok = false; mismatch = name + " 头部"; break; }
    for (let i = 0; i < a.mons.length && ok; i++) {
      const ma = a.mons[i], mb = b.mons[i];
      if (ma.n !== mb.n || (ma.u || []).join(",") !== (mb.u || []).join(",") ||
          (ma.vc || []).join(",") !== (mb.vc || []).join(",")) { ok = false; mismatch = name + "#" + i + " 基础列"; break; }
      for (const k of ["sp", "mv", "it", "ab", "te"]) {
        const sa = ma[k], sb = mb[k];
        if ((sa === undefined) !== (sb === undefined)) { ok = false; mismatch = name + "#" + i + " " + k + " 存在性"; break; }
        if (sa && sa.map((r) => r.join(",")).join(";") !== sb.map((r) => r.join(",")).join(";")) {
          ok = false; mismatch = name + "#" + i + " " + k; break;
        }
      }
    }
    if (!ok) break;
  }
  decodeMs = Number((process.hrtime.bigint() - t2) / 1000000n);
}

console.log(JSON.stringify({
  month: doc.month,
  jsonBytes: Buffer.byteLength(text, "utf8"),
  inputGzipBytes: raw.length,
  packBytes: bytes.length,
  encodeMs: Number((t1 - t0) / 1000000n),
  verifyAllFormatsMs: decodeMs,
  roundtrip: verify ? ok : undefined,
  mismatch: mismatch ?? undefined,
  stats,
  peakRssMb: Math.round(process.memoryUsage().rss / 1048576),
}));
if (verify && !ok) process.exit(2);
