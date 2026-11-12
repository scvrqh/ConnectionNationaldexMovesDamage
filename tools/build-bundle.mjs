import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 生成汇总数据包：把冠军数据和每一个已发布月份的使用率数据打成一个可一次性导入的包。
// 包内结构固定（App 侧按这份契约读，改结构必须两边一起改）：
//
//   manifest.json
//   champion-pack.json
//   usage/<YYYY-MM>.json.gz
//
// 输入取自本仓库 dist/ 下由既有 workflow 产出的两份文件：
//   dist/usage-index.json   {"months":[{"month":"2026-11","url":"https://.../usage-gen9-2026-11.json.gz"}]}
//   dist/champion-pack.json {"version":20261103,...}
//
//   node tools/build-bundle.mjs                        # 全部月份，联网下载
//   node tools/build-bundle.mjs --limit 1              # 只取最新 1 个月
//   node tools/build-bundle.mjs --offline --limit 1    # 只用 dist/bundle/usage 里已有的缓存
//
// 参数：
//   --out <dir>   输出目录，默认 dist/bundle
//   --offline     不联网；缺缓存的月份跳过，manifest 里不列该月（本地试跑用）
//   --limit <n>   只取索引里最新的 n 个月（索引本身从新到旧）
//
// 某个下载失败（404 / 网络错误）只跳过该月并打印月份与状态码：索引可能比实际发布早一步，
// 为一个还没挂上的月份让整次打包失败没有意义；一个月份都没成功才退出码 1。

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes("--" + name);

// 仓库根目录：输入固定读 <仓库>/dist/ 下的两份文件，所以按脚本位置定位，
// 不随执行时所在目录变化（在仓库任意子目录里跑都能工作）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = arg("out") ? path.resolve(arg("out")) : path.join(REPO_ROOT, "dist", "bundle");
const OFFLINE = has("offline");
const LIMIT_RAW = arg("limit");
const INDEX = path.join(REPO_ROOT, "dist", "usage-index.json");
const CHAMPION_SRC = path.join(REPO_ROOT, "dist", "champion-pack.json");
const MONTH_RE = /^\d{4}-\d{2}$/;

let limit = 0;
if (LIMIT_RAW !== undefined) {
  limit = Number(LIMIT_RAW);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error("--limit 应为正整数：" + LIMIT_RAW);
    process.exit(1);
  }
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
  // 至少得看得出是 gzip（1f 8b），免得把错误页面当数据写进包里
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) {
    return "不是 gzip 数据（" + body.length + " 字节）";
  }
  fs.writeFileSync(file, body);
  return null;
}

async function main() {
  // 1. 读索引，按月份从新到旧排好（索引本来有序，这里再排一次，避免上游顺序变化）
  const index = readJson(INDEX, "使用率索引");
  const all = Array.isArray(index.months) ? index.months : [];
  if (!all.length) throw new Error("使用率索引里没有任何月份：" + INDEX);

  const months = all
    .map((m) => ({ month: String(m.month || ""), url: String(m.url || "") }))
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

  // 2. 逐月下载（或读缓存）到 usage/<月>.json.gz
  const usageDir = path.join(OUT, "usage");
  fs.mkdirSync(usageDir, { recursive: true });

  const usage = [];
  const failed = [];
  for (const { month, url } of picked) {
    const file = path.join(usageDir, month + ".json.gz");
    if (OFFLINE) {
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        failed.push({ month, reason: "无缓存" });
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
    usage.push({ month, file: "usage/" + month + ".json.gz", bytes: fs.statSync(file).size });
  }

  // 一个月份都没有：离线试跑照样收尾（manifest 的 usage 为空数组，方便核对结构）；
  // 联网运行则宁可失败，也不发布一个空包
  if (!usage.length && !OFFLINE) {
    throw new Error(
      "没有任何月份可用（" + picked.map((m) => m.month).join(" / ") + "）：" +
        failed.map((f) => f.month + "=" + f.reason).join("，")
    );
  }
  if (!usage.length) {
    console.warn("离线模式下所有月份都缺缓存，manifest 的 usage 会是空数组");
  }

  // 3. 冠军数据原样拷进包里，版本号从它自己的内容取（取不到写 0）
  const champion = readJson(CHAMPION_SRC, "冠军数据包");
  const championDst = path.join(OUT, "champion-pack.json");
  fs.copyFileSync(CHAMPION_SRC, championDst);
  const championBytes = fs.statSync(championDst).size;
  const version = Number(champion.version) || 0;

  // 4. manifest：App 只认这些字段；可以加字段，不能改已有字段名或语义
  const manifest = {
    schema: 1,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    champion: { file: "champion-pack.json", version, bytes: championBytes },
    usage,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  fs.writeFileSync(path.join(OUT, "manifest.json"), manifestText);

  const usageBytes = usage.reduce((n, u) => n + u.bytes, 0);
  console.log("汇总包月份：" + usage.length +
    (usage.length ? "（" + usage.map((u) => u.month).join(" / ") + "）" : ""));
  console.log("总字节：" + (usageBytes + championBytes + Buffer.byteLength(manifestText)) +
    "（冠军 " + championBytes + "，使用率 " + usageBytes + "）");
  console.log("输出路径：" + OUT);
  if (failed.length) {
    console.warn("已跳过 " + failed.length + " 个月：" +
      failed.map((f) => f.month + "（" + f.reason + "）").join(" / ") + "，manifest 里没有这些月份");
  }
}

main().catch((e) => {
  console.error(e.message);
  // 用 exitCode 而不是 process.exit：fetch 还挂着连接时强行退出会踩到 libuv 断言
  process.exitCode = 1;
});
