import fs from "node:fs";
import path from "node:path";

// 抓 smogon 的使用率原始数据（chaos），只做下载不做裁剪：
// 裁剪另有一个脚本，读这里的文件生成随包数据，抓一次可以反复裁。
const MONTH = process.env.USAGE_MONTH || "2026-10";
const INDEX = `https://www.smogon.com/stats/${MONTH}/`;
// 按月分目录：文件名里只有格式与档位，平铺会让下个月静默复用上个月的旧文件
const OUT = path.join(".dsh-diag/usage-raw", MONTH);
// 不写死档位：每个格式的分档并不一样（gen9ou 是 0/1500/1695/1825，
// 其它 45 个格式是 0/1500/1630/1760），写死 "0,1630" 会让 gen9ou 只有「全部」一档。
// USAGE_ELOS 只用来临时缩小范围，留空就从 chaos 目录里取每个格式真实存在的档位。
const ELOS = process.env.USAGE_ELOS ? process.env.USAGE_ELOS.split(",") : null;

fs.mkdirSync(OUT, { recursive: true });
const html = await (await fetch(INDEX)).text();
const formats = new Set([...html.matchAll(/href="([a-z0-9]+)-\d+\.txt"/g)].map(m => m[1])
  .filter(f => f.startsWith("gen9")));
const chaos = await (await fetch(`${INDEX}chaos/`)).text();
const tasks = [];
for (const m of chaos.matchAll(/href="([a-z0-9]+)-(\d+)\.json"/g)) {
  const [, f, e] = m;
  if (!formats.has(f) || (ELOS && !ELOS.includes(e))) continue;
  tasks.push({ name: `${f}-${e}`, url: `${INDEX}chaos/${f}-${e}.json`, out: path.join(OUT, `${f}-${e}.json`) });
}
console.log("formats", formats.size, "tasks", tasks.length);
let i = 0, ok = 0;
const fail = [];
async function worker() {
  while (i < tasks.length) {
    const t = tasks[i++];
    if (fs.existsSync(t.out) && fs.statSync(t.out).size > 0) { ok++; continue; }
    try {
      const r = await fetch(t.url, { signal: AbortSignal.timeout(1800000) });
      if (r.status !== 200) { fail.push(`${t.name}:${r.status}`); continue; }
      const b = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(t.out, b);
      ok++;
      console.log(`ok ${t.name} ${b.length}B`);
    } catch {
      fail.push(`${t.name}:ERR`);
    }
  }
}
await Promise.all(Array.from({ length: 20 }, worker));
fs.writeFileSync(path.join(OUT, "_fail.json"), JSON.stringify(fail, null, 1));
console.log("done ok=", ok, "fail=", fail.length, JSON.stringify(fail.slice(0, 5)));
