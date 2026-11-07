import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// 把 .dsh-diag/usage-raw 里的 chaos 原始数据裁成随包小表。
// 只保留页面用得到的部分：使用率、常见配点、招式/道具/特性/太晶占比。
// 计数一律换成万分比整数（0..10000），长度比 "0.31415926" 短一半。
const MONTH = process.env.USAGE_MONTH || "2026-10";
// 与 gen-usage-raw.mjs 的落盘目录一致：按月分目录
const RAW = path.join(".dsh-diag/usage-raw", MONTH);
const DETAIL_MIN = Number(process.env.DETAIL_MIN || 20); // 万分比，0.2%
const OUT = process.env.USAGE_OUT || "core-model/src/main/resources/pokedata/usage-gen9.json.gz";
// 体积就是 APK 体积：配点/招式/道具/特性/太晶都按页面能看的条数留
const TOP = {
  sp: Number(process.env.TOP_SP || 4),
  mv: Number(process.env.TOP_MV || 8),
  it: Number(process.env.TOP_IT || 4),
  ab: Number(process.env.TOP_AB || 4),
  te: Number(process.env.TOP_TE || 4),
};

const pct = (count, total) => Math.max(0, Math.min(10000, Math.round((count / total) * 10000)));
const topN = (dict, n, total) =>
  Object.fromEntries(
    Object.entries(dict || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => [k, pct(v, total)]),
  );

if (!fs.existsSync(RAW)) {
  console.error("没有 " + MONTH + " 的原始数据（" + RAW + "），先跑 node tools/gen-usage-raw.mjs");
  process.exit(1);
}
const files = fs.readdirSync(RAW).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
// 第一遍：每个「格式-档位」各自裁剪（DETAIL_MIN 与 TOP 都是按档位判断的）
const perElo = {};
for (const file of files) {
  const m = /^(.+)-(\d+)\.json$/.exec(file);
  if (!m) continue;
  const [, fmt, elo] = m;
  const j = JSON.parse(fs.readFileSync(path.join(RAW, file), "utf8"));
  const battles = j.info?.["number of battles"] ?? 0;
  const list = [];
  for (const [name, v] of Object.entries(j.data || {})) {
    const total = v["Raw count"] || 0;
    if (!total) continue;
    const entry = {
      n: name,
      u: Math.round((v.usage || 0) * 10000),
      vc: (v["Viability Ceiling"] || [])[1] ?? 0,
    };
    // 长尾只留名字与使用率：它们在排行榜里要继续出现，但配点/招式占比没人看，
    // 而且尾部条目占了详情字段的六成体积
    if (entry.u >= DETAIL_MIN) {
      entry.sp = topN(v.Spreads, TOP.sp, total);
      entry.mv = topN(v.Moves, TOP.mv, total);
      entry.it = topN(v.Items, TOP.it, total);
      entry.ab = topN(v.Abilities, TOP.ab, total);
      // 太晶字段只对 gen9 的格式存在，旧格式是空对象：空的就不写进 json
      const te = topN(v["Tera Types"], TOP.te, total);
      if (Object.keys(te).length) entry.te = te;
    }
    list.push(entry);
  }
  (perElo[fmt] || (perElo[fmt] = {}))[elo] = { battles, list };
}

// 第二遍：合并成「每只宝可梦一条 + 各档占比数组」。
// 同一只在 4 个档位各存一份时，物种名、招式名、配点串会被重复写四遍；
// 合并之后每个字符串只进 dict 一次，四个档位共用同一行的数字。
const dict = [];
const ids = new Map();
const idOf = (s) => {
  let id = ids.get(s);
  if (id === undefined) {
    id = dict.length;
    ids.set(s, id);
    dict.push(s);
  }
  return id;
};
const formats = {};
let monCount = 0;
for (const [fmt, elos] of Object.entries(perElo)) {
  const order = Object.keys(elos).sort((a, b) => Number(a) - Number(b));
  const slot = new Map(order.map((e, i) => [e, i]));
  const width = order.length;
  const byName = new Map();
  for (const elo of order) {
    for (const e of elos[elo].list) {
      let rec = byName.get(e.n);
      if (!rec) {
        rec = { n: idOf(e.n), u: new Array(width).fill(0), vc: new Array(width).fill(0) };
        byName.set(e.n, rec);
      }
      const i = slot.get(elo);
      rec.u[i] = e.u;
      rec.vc[i] = e.vc;
      for (const k of ["sp", "mv", "it", "ab", "te"]) {
        const src = e[k];
        if (!src) continue;
        const bucket = rec[k] || (rec[k] = new Map());
        for (const [key, val] of Object.entries(src)) {
          let arr = bucket.get(key);
          if (!arr) {
            arr = new Array(width).fill(0);
            bucket.set(key, arr);
          }
          arr[i] = val;
        }
      }
    }
  }
  // 进包的顺序 = 「全部」档的名次；其它档的名次由读入口按各自的 u 重排
  const mons = [...byName.values()]
    .sort((a, b) => b.u[0] - a.u[0])
    .map((rec) => {
      const out = { n: rec.n, u: rec.u, vc: rec.vc };
      for (const k of ["sp", "mv", "it", "ab", "te"]) {
        const bucket = rec[k];
        if (bucket) out[k] = [...bucket.entries()].map(([key, arr]) => [idOf(key), ...arr]);
      }
      return out;
    });
  monCount += mons.length;
  formats[fmt] = { elos: order, battles: order.map((e) => elos[e].battles), mons };
}
const out = { month: MONTH, source: "https://www.smogon.com/stats/", dict, formats };
const text = JSON.stringify(out);
const gz = zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, gz);
console.log("格式", Object.keys(formats).length, "档位", Object.values(formats).reduce((a, f) => a + f.elos.length, 0),
  "宝可梦条目", monCount, "字典", dict.length,
  "原始", (text.length / 1048576).toFixed(2) + "MB", "gzip", (gz.length / 1024).toFixed(0) + "KB");
