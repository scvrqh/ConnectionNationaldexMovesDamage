import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 使用率数据的一键更新：选月份 → 抓 chaos 原始数据 → 裁成随包小表。
// 原始数据按月分目录（.dsh-diag/usage-raw/<月>/），换月不会复用上个月的旧文件，
// 也就能按月整份删除。
//
//   node tools/update-usage.mjs                  交互选月份，抓取 + 裁剪
//   node tools/update-usage.mjs --month 2026-11  跳过交互
//   node tools/update-usage.mjs --stats-only     只重裁，不动已下载的数据
//   node tools/update-usage.mjs --list           已下载了哪些月份、各占多少
//   node tools/update-usage.mjs --clean          删除已下载的原始数据（非交互加 --yes）

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RAW_BASE = path.join(ROOT, ".dsh-diag", "usage-raw");
const PKG = path.join(ROOT, "core-model/src/main/resources/pokedata/usage-gen9.json.gz");
const INDEX = "https://www.smogon.com/stats/";
const MONTH_RE = /^\d{4}-\d{2}$/;

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);

const size = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB");
const gzSize = () => { try { return fs.statSync(PKG).size; } catch { return 0; } };

function downloaded() {
  if (!fs.existsSync(RAW_BASE)) return [];
  return fs.readdirSync(RAW_BASE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && MONTH_RE.test(d.name))
    .map((d) => {
      const dir = path.join(RAW_BASE, d.name);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
      return { month: d.name, files: files.length, bytes: files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0) };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

// 旧版本把文件平铺在 usage-raw 下、没记月份——遇到就提醒，绝不静默当成当月数据
function stray() {
  if (!fs.existsSync(RAW_BASE)) return [];
  return fs.readdirSync(RAW_BASE).filter((f) => f.endsWith(".json"));
}

async function onlineMonths() {
  try {
    const r = await fetch(INDEX, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [];
    const html = await r.text();
    return [...new Set([...html.matchAll(/href="(\d{4}-\d{2})\//g)].map((m) => m[1]))].sort();
  } catch {
    return [];
  }
}

// 交互与管道两种喂法：终端里逐句问；被脚本调用时从 stdin 读，读完了就当空回答（走默认值）
const tty = Boolean(process.stdin.isTTY);
const rl = tty ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
let piped = null;
let pipedAt = 0;
async function ask(q) {
  if (rl) return (await rl.question(q)).trim();
  if (!piped) piped = fs.readFileSync(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  const v = piped[pipedAt++] ?? "";
  console.log(q + v);
  return v;
}
const bye = (code = 0) => { if (rl) rl.close(); process.exit(code); };

function run(script, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, "tools", script)], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(script + " 退出码 " + code))));
  });
}

if (has("--list")) {
  const rows = downloaded();
  if (!rows.length) console.log("还没有下载过原始数据（" + RAW_BASE + "）");
  for (const r of rows) console.log(r.month, r.files + " 个文件", size(r.bytes));
  const old = stray();
  if (old.length) console.log("\n注意：usage-raw 根目录下还有 " + old.length + " 个未分月份的旧文件，可能是老版本抓的，用 --clean 清掉最省事");
  console.log("\n随包数据：" + size(gzSize()));
  bye();
}

if (has("--clean")) {
  const rows = downloaded();
  const old = stray();
  if (!rows.length && !old.length) { console.log("没有可删的数据"); bye(); }
  const only = arg("--month");
  const targets = only ? rows.filter((r) => r.month === only) : rows;
  if (only && !targets.length) { console.log("没有 " + only + " 的数据"); bye(); }
  for (const r of targets) console.log("将删除", r.month, r.files + " 个文件", size(r.bytes));
  if (!only && old.length) console.log("将删除", old.length, "个未分月份的旧文件");
  const total = targets.reduce((a, r) => a + r.bytes, 0);
  if (!has("--yes")) {
    const ans = (await ask("确认删除（约 " + size(total) + "）？[y/N] ")).toLowerCase();
    if (ans !== "y" && ans !== "yes") { console.log("已取消"); bye(); }
  }
  for (const r of targets) fs.rmSync(path.join(RAW_BASE, r.month), { recursive: true, force: true });
  if (!only) for (const f of old) fs.rmSync(path.join(RAW_BASE, f), { force: true });
  if (!only && fs.existsSync(RAW_BASE) && !fs.readdirSync(RAW_BASE).length) fs.rmdirSync(RAW_BASE);
  console.log("已删除");
  bye();
}

let month = arg("--month");
if (month && !MONTH_RE.test(month)) { console.error("月份格式应为 YYYY-MM，收到：" + month); bye(1); }

if (!month) {
  const recent = (await onlineMonths()).slice(-6).reverse();
  if (recent.length) {
    console.log("smogon 上最近的月份：");
    recent.forEach((m, i) => console.log("  " + (i + 1) + ") " + m));
  } else {
    console.log("拿不到月份索引（网络或站点问题），请直接输入。");
  }
  const pick = await ask(recent.length ? "选择月份（序号或 YYYY-MM，回车取 " + recent[0] + "）：" : "输入月份（YYYY-MM）：");
  month = !pick ? recent[0] : /^\d+$/.test(pick) ? recent[Number(pick) - 1] : pick;
  if (!month || !MONTH_RE.test(month)) { console.error("月份不对：" + pick); bye(1); }
}
if (rl) rl.close();

const old = stray();
if (old.length) {
  console.log("注意：usage-raw 根目录下有 " + old.length + " 个未分月份的旧文件（老版本抓的），本次不会用到；要清理跑 --clean");
}

const have = downloaded().find((r) => r.month === month);
if (have) console.log(month + " 已下载 " + have.files + " 个文件（" + size(have.bytes) + "），已完成的会跳过");

const before = gzSize();
try {
  if (!has("--stats-only")) {
    console.log("\n=== 抓取 " + month + " 的 chaos 原始数据 ===");
    await run("gen-usage-raw.mjs", { USAGE_MONTH: month });
  }
  console.log("\n=== 裁剪成随包数据 ===");
  await run("gen-usage-stats.mjs", { USAGE_MONTH: month });
} catch (e) {
  console.error("\n失败：" + e.message);
  process.exit(1);
}

const after = gzSize();
const diff = after - before;
console.log("\nusage-gen9.json.gz：" + size(before) + " → " + size(after) + (diff === 0 ? "（不变）" : "（" + (diff > 0 ? "+" : "-") + size(Math.abs(diff)) + "）"));
console.log("接着跑：.\\gradlew.bat --max-workers=1 :core-model:test :core-calc:test :app:testDebugUnitTest");
