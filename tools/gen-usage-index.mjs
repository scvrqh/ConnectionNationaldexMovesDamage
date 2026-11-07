import fs from "node:fs";
import path from "node:path";

// 生成 usage-index.json：列出已经发布过的每个月，以及它那份数据包的完整下载地址。
// 每个月单独一个 release（tag usage-data-<月>），所以索引里必须写绝对地址——
// 只有最新那次 release 能通过 releases/latest/download 取到，旧月份只能走自己的 tag。
//
//   node tools/gen-usage-index.mjs --repo owner/name --month 2026-11 --months 2026-10,2026-09 --out dist/usage-index.json

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const REPO = arg("repo");
const OUT = arg("out") || "dist/usage-index.json";
if (!REPO || !/^[^/]+\/[^/]+$/.test(REPO)) {
  console.error("缺少或非法的 --repo（应为 owner/name）：" + REPO);
  process.exit(1);
}

const MONTH_RE = /^\d{4}-\d{2}$/;
const months = new Set();
const picked = argv.filter((_, i) => i > 0 && (argv[i - 1] === "--month" || argv[i - 1] === "--months"));
for (const raw of picked) {
  for (const m of String(raw).split(",")) {
    const v = m.trim();
    if (!v) continue;
    if (!MONTH_RE.test(v)) {
      console.error("月份格式应为 YYYY-MM：" + v);
      process.exit(1);
    }
    months.add(v);
  }
}
if (!months.size) {
  console.error("一个月份都没有：至少给一个 --month");
  process.exit(1);
}

const index = {
  months: [...months]
    .sort()
    .reverse()
    .map((month) => ({
      month,
      url: `https://github.com/${REPO}/releases/download/usage-data-${month}/usage-gen9-${month}.json.gz`,
    })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(index, null, 2) + "\n");
console.log(`写出 ${OUT}：${index.months.length} 个月（${index.months.map((m) => m.month).join(" / ")}）`);
