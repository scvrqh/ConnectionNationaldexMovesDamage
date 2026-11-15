import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 生成汇总数据包：把冠军数据和每一个已发布月份的使用率数据打成一个可一次性导入的包。
// 包内结构固定（App 侧按这份契约读，改结构必须两边一起改）：
//
//   manifest.json
//   champion-pack.json
//   usage/<YYYY-MM>.pack
//
// 输入取自本仓库 dist/ 下由既有 workflow 产出的两份文件：
//   dist/usage-index.json   {"months":[{"month":"2026-11","url":".../usage-gen9-2026-11.pack","lite":"...-lite.pack"}]}
//   dist/champion-pack.json {"version":20261103,...}
//
// 索引里每个月份都有全量与精简两个地址，所以这里出两个变体（各自一份完整包，互不掺和）：
//   dist/bundle/full  全量（每月 10~18 MB）
//   dist/bundle/lite  精简（每月 2 MB 上下）
//
//   node tools/build-bundle.mjs                        # 两个变体、全部月份，联网下载
//   node tools/build-bundle.mjs --variant lite         # 只打精简版
//   node tools/build-bundle.mjs --limit 1              # 只取最新 1 个月
//   node tools/build-bundle.mjs --offline --limit 1    # 只用 dist/bundle/<变体>/usage 里已有的缓存
//
// 参数：
//   --variant <full|lite|both>   变体，默认 both
//   --out <dir>                  输出目录：单变体时就是它自己，both 时是父目录（默认 dist/bundle）
//   --offline                    不联网；缺缓存的月份跳过，manifest 里不列该月（本地试跑用）
//   --limit <n>                  只取索引里最新的 n 个月（索引本身从新到旧）
//
// 某个下载失败（404 / 网络错误）只跳过该月并打印月份与状态码：索引可能比实际发布早一步，
// 为一个还没挂上的月份让整次打包失败没有意义；某个变体一个月份都没成功才退出码 1。

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes("--" + name);

// 仓库根目录：输入固定读 <仓库>/dist/ 下的两份文件，所以按脚本位置定位，
// 不随执行时所在目录变化（在仓库任意子目录里跑都能工作）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = has("offline");
const LIMIT_RAW = arg("limit");
const VARIANT_RAW = String(arg("variant") || "both").toLowerCase();
const OUT_ARG = arg("out");
const INDEX = path.join(REPO_ROOT, "dist", "usage-index.json");
const CHAMPION_SRC = path.join(REPO_ROOT, "dist", "champion-pack.json");
const MONTH_RE = /^\d{4}-\d{2}$/;
const VARIANTS = ["full", "lite"];

if (!["full", "lite", "both"].includes(VARIANT_RAW)) {
  console.error("--variant 只能是 full / lite / both：" + VARIANT_RAW);
  process.exit(1);
}
const pickedVariants = VARIANT_RAW === "both" ? VARIANTS : [VARIANT_RAW];

let limit = 0;
if (LIMIT_RAW !== undefined) {
  limit = Number(LIMIT_RAW);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error("--limit 应为正整数：" + LIMIT_RAW);
    process.exit(1);
  }
}

const OUT_ROOT = OUT_ARG ? path.resolve(OUT_ARG) : path.join(REPO_ROOT, "dist", "bundle");

// 单变体且显式给了 --out：直接用它；否则每个变体一个子目录，缓存不会互相覆盖
function outDirOf(variant) {
  return pickedVariants.length === 1 && OUT_ARG ? OUT_ROOT : path.join(OUT_ROOT, variant);
}

function readJson(file, what) {
  if (!fs.existsSync(file)) throw new Error("找不到" + what + "：" + file);
  try {
    // 去掉可能的 BOM：PowerShell 写出来的 JSON 会带 U+FEFF
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(what + " 不是合法 JSON：" + file + "\n  " + e.message);
  }
}

// 使用率数据是 PKMB 二进制（magic "PKMB"），不是 gzip。早年这里按 1f 8b 校验，
// 换成二进制格式后必须跟着改，否则每一份都会被当成错误页面丢掉。
function packProblem(body) {
  if (body.length < 4) return "只有 " + body.length + " 字节";
  if (body[0] !== 0x50 || body[1] !== 0x4b || body[2] !== 0x4d || body[3] !== 0x42) {
    return "不是 PKMB 数据（头部 " + body.subarray(0, 4).toString("hex") + "）";
  }
  return null;
}

async function download(month, url, file) {
  console.log("下载 " + month + "：" + url);
  let res;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    return "网络错误 " + e.message;
  }
  if (!res.ok) return "HTTP " + res.status + " " + res.statusText;
  const body = Buffer.from(await res.arrayBuffer());
  const problem = packProblem(body);
  if (problem) return problem + "（" + body.length + " 字节）";
  fs.writeFileSync(file, body);
  return null;
}

// 索引里的每个月都带全量与精简两个地址，缺哪个就跳过哪个
function urlOf(entry, variant) {
  return variant === "lite" ? entry.lite : entry.url;
}

async function buildVariant(variant, months, championBytes, version) {
  const OUT = outDirOf(variant);
  const usageDir = path.join(OUT, "usage");
  fs.mkdirSync(usageDir, { recursive: true });

  const usage = [];
  const failed = [];
  for (const entry of months) {
    const { month } = entry;
    const url = urlOf(entry, variant);
    if (!url) {
      failed.push({ month, reason: "索引里没有" + (variant === "lite" ? "精简版" : "全量版") });
      continue;
    }
    const file = path.join(usageDir, month + ".pack");
    if (OFFLINE) {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        failed.push({ month, reason: "无缓存" });
        continue;
      }
      const problem = packProblem(fs.readFileSync(file));
      if (problem) {
        failed.push({ month, reason: "缓存损坏：" + problem });
        continue;
      }
    } else {
      const reason = await download(month, url, file);
      if (reason) {
        console.warn("跳过 " + month + "：" + reason + " " + url);
        failed.push({ month, reason });
        continue;
      }
    }
    usage.push({ month, file: "usage/" + month + ".pack", bytes: fs.statSync(file).size });
  }

  if (!usage.length && !OFFLINE) {
    throw new Error(
      variant + " 变体没有任何月份可用（" + months.map((m) => m.month).join(" / ") + "）：" +
        failed.map((f) => f.month + "=" + f.reason).join("，")
    );
  }
  if (!usage.length) {
    console.warn("离线模式下 " + variant + " 变体所有月份都缺缓存，manifest 的 usage 会是空数组");
  }

  const championDst = path.join(OUT, "champion-pack.json");
  fs.copyFileSync(CHAMPION_SRC, championDst);

  // manifest：App 只认 schema/champion/usage 这些字段；新增字段可以读也可以忽略
  const manifest = {
    schema: 1,
    variant,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    champion: { file: "champion-pack.json", version, bytes: championBytes },
    usage,
  };
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const usageBytes = usage.reduce((n, u) => n + u.bytes, 0);
  console.log("[" + variant + "] 月份：" + usage.length);
  console.log("[" + variant + "] 总字节：" + (usageBytes + championBytes) +
    "（冠军 " + championBytes + "，使用率 " + usageBytes + "）");
  console.log("[" + variant + "] 输出路径：" + OUT);
  if (failed.length) {
    console.warn("[" + variant + "] 已跳过 " + failed.length + " 个月：" +
      failed.map((f) => f.month + "（" + f.reason + "）").join(" / ") + "，manifest 里没有这些月份");
  }
  return { usage: usage.length, failed: failed.length };
}

async function main() {
  // 1. 读索引，按月份从新到旧排好（索引本来有序，这里再排一次，避免上游顺序变化）
  const index = readJson(INDEX, "使用率索引");
  const all = Array.isArray(index.months) ? index.months : [];
  if (!all.length) throw new Error("使用率索引里没有任何月份：" + INDEX);

  const months = all
    .map((m) => ({
      month: String(m.month || ""),
      url: String(m.url || ""),
      lite: String(m.lite || ""),
    }))
    .filter((m) => {
      if (!MONTH_RE.test(m.month) || !/^https?:\/\//.test(m.url)) {
        console.warn("跳过索引里的无效条目：" + JSON.stringify(m));
        return false;
      }
      return true;
    })
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  if (!months.length) throw new Error("使用率索引里没有可用月份：" + INDEX);

  const picked = limit > 0 ? months.slice(0, limit) : months;

  // 2. 冠军数据只需要读一次，两个变体各拷一份
  const champion = readJson(CHAMPION_SRC, "冠军数据包");
  const championBytes = fs.statSync(CHAMPION_SRC).size;
  const version = Number(champion.version) || 0;

  // 3. 逐变体打包
  let anyFailed = false;
  for (const variant of pickedVariants) {
    const r = await buildVariant(variant, picked, championBytes, version);
    if (r.failed) anyFailed = true;
  }
  if (anyFailed) console.warn("有月份被跳过，见上面的清单");
}

main().catch((e) => {
  console.error(e.message);
  // 用 exitCode 而不是 process.exit：fetch 还挂着连接时强行退出会踩到 libuv 断言
  process.exitCode = 1;
});
