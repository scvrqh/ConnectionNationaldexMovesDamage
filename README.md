# ConnectionNationaldexMovesDamage

数据包的发布仓库。app 里填的固定地址：

| 数据包 | 固定地址 |
|---|---|
| 冠军数据 | https://github.com/scvrqh/ConnectionNationaldexMovesDamage/releases/latest/download/champion-pack.json |
| 使用率索引 | https://github.com/scvrqh/ConnectionNationaldexMovesDamage/releases/latest/download/usage-index.json |

Actions 自动跑：冠军数据每周一 03:00 UTC，使用率数据每月 5 日 06:00 UTC（smogon 放出上月统计之后）。
两边都可以在 Actions 页面手动 Run workflow。

## 使用率数据包

- 一次发布 = 一个 Release，tag 为 `usage-data-<YYYY-MM>`，asset 是 `usage-gen9-<YYYY-MM>.json.gz`（约 2 MB）加一份 `usage-index.json`。
- `usage-index.json` 列出**所有已发布月份**，每个月份写的是它自己那次 Release 的绝对地址。
  `releases/latest/download` 只指向最新那一次，旧月份靠它取不到，所以索引里不能用相对地址。
- app 侧：设置页「使用率数据 → 管理月份」按索引列出月份，可以下载、切换、删除；删掉正在用的月份会自动回退到 APK 内置那份。
- 补某个月：Actions → Usage data pack → Run workflow，`month` 填 smogon 的目录名（如 `2026-10`），留空取上个月。
- 同一个月已经发布过会被跳过（不覆盖）；smogon 还没放出该月数据时只打一条 warning，不算失败。
- 抓取约 470 MB、耗时一小时上下，workflow 的 `timeout-minutes` 放到 180。

## 补历史月份

`.github/workflows/usage-backfill.yml` 用来一次性补齐旧月份（smogon 的月度存档从 2023-01 起都有）：

- Actions → Usage data backfill → Run workflow，填 `from` / `to`（含端点），默认 `2023-01` 到 `2026-09`。
- 按月份拆成矩阵并行，`max-parallel: 4`——smogon 是公益站点，别一次把几十个月的 worker 全放出去。
- 每个月一个 job：抓 chaos → 裁剪 → 发布 `usage-data-<月>`。已发布过的月份自动跳过，所以可以分批跑、中断后直接重跑。
- 全部结束后另一个 job 汇总已发布月份重建索引，覆盖写到**当时最新**的那个 Release 上（`releases/latest/download/usage-index.json` 靠它取）。
- 单个月份约 1–2 分钟，45 个月跑完大约 20–30 分钟。

## 这里的文件都是从代码仓库复制来的

自包含的代价是「同一套脚本存在两份」，**改动生成逻辑时必须同步**。副本清单：

| 本仓库路径 | 源头（代码仓库同名路径） |
|---|---|
| `tools/gen-champions-ps.mjs` | 同上 |
| `tools/gen-champion-pack.mjs` | 同上 |
| `tools/lib/load-ts.mjs` | 同上 |
| `tools/gen-usage-raw.mjs` | 同上 |
| `tools/gen-usage-stats.mjs` | 同上 |
| `tools/update-usage.mjs` | 同上（本地一键更新用，CI 不跑） |
| `tools/package.json` / `tools/package-lock.json` | 同上 |
| `core-model/src/main/resources/pokedata/champions.json` | 同上（`gen-champions-ps.mjs` 用它做差异对照，缺了会报错） |

`tools/gen-usage-index.mjs` 只在本仓库里，代码仓库没有对应文件。

最后一次同步：代码仓库 `42f99d4`。

同步命令（在**代码仓库**根目录执行）：

```powershell
$dst = '..\ConnectionNationaldexMovesDamage'
Copy-Item tools\gen-champions-ps.mjs, tools\gen-champion-pack.mjs, tools\package.json, tools\package-lock.json -Destination "$dst\tools" -Force
Copy-Item tools\gen-usage-raw.mjs, tools\gen-usage-stats.mjs, tools\update-usage.mjs -Destination "$dst\tools" -Force
Copy-Item tools\lib\load-ts.mjs -Destination "$dst\tools\lib" -Force
Copy-Item core-model\src\main\resources\pokedata\champions.json -Destination "$dst\core-model\src\main\resources\pokedata" -Force
```

同步后记得把上面那行 commit 号改成代码仓库当前的 `git rev-parse --short HEAD`。
