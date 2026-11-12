# ConnectionNationaldexMovesDamage

宝可梦伤害计算器（Android 应用 PokeDamageCalculator）的数据发布仓库：把对战需要的三份数据整理成固定地址的文件，App 里填一次地址即可长期更新。维护者：scvrqh。

数据全部整理自公开上游，本仓库只做搬运、裁剪与打包：

| 数据 | 上游来源 | 许可 / 致谢 |
|---|---|---|
| 冠军数据 `champion-pack.json` | Pokémon Showdown（[smogon/pokemon-showdown](https://github.com/smogon/pokemon-showdown) 的 `data/mods/champions`） | MIT，版权归 Pokémon Showdown 贡献者 |
| 使用率数据 `usage-gen9-*.json.gz` | Smogon University 月度对战统计（https://www.smogon.com/stats/） | 公开统计数据，版权归 Smogon 与 Pokémon Showdown 贡献者 |
| 分级数据 `tiers-formats-data.js` | https://play.pokemonshowdown.com/data/formats-data.js 的原文快照，不做格式转换 | 同上 |

宝可梦名称、招式与相关商标归 Nintendo / Creatures Inc. / GAME FREAK inc. 所有；本仓库不包含任何游戏本体资源，也不对上游数据的准确性作担保。

## 固定下载地址

| 数据 | 地址 | 用途 |
|---|---|---|
| 汇总数据包 | https://github.com/scvrqh/ConnectionNationaldexMovesDamage/releases/latest/download/data-bundle.zip | 一次拿到冠军数据 + 全部使用率月份，App 里「导入汇总包」用这个 |
| 冠军数据 | https://github.com/scvrqh/ConnectionNationaldexMovesDamage/releases/latest/download/champion-pack.json | App 内置的默认更新地址 |
| 使用率索引 | https://github.com/scvrqh/ConnectionNationaldexMovesDamage/releases/latest/download/usage-index.json | App 内置的默认更新地址，列出所有已发布月份 |
| 分级数据 | https://github.com/scvrqh/ConnectionNationaldexMovesDamage/releases/latest/download/tiers-formats-data.js | 分级筛选用，随汇总包一起发布 |

`releases/latest` 只指向**最近创建的那一次 Release**。因此每次发布（冠军 / 使用率 / 汇总包）都会把另外几份文件一并挂上，上面几个地址由此长期有效。分级文件只存在于 `data-bundle-*` 的 Release 里：冠军数据在每周一 03:00 UTC 发布、汇总包在 03:30 UTC 跟上，那半小时内 latest 指向冠军 Release，`tiers-formats-data.js` 会暂时取不到——稍等片刻，或改从最近一次 `data-bundle-<日期>` Release 下载。

## 在 App 里导入

入口是 **设置 → 数据包**：

1. **导入汇总包**：选择 `data-bundle.zip`，在导入界面勾选要导入的类别（冠军数据 / 使用率月份 / 分级数据），确认后立即生效，不需要重启。
2. **导入分级文件**：也可以单独导入 `tiers-formats-data.js`，只补分级数据；重复导入即为覆盖。
3. **恢复内置数据**：一键清掉导入的内容，回到 APK 自带的那份快照。删除正在使用的某个使用率月份时，会自动回退到内置那份。

只导入其中一部分也没问题：例如先导入汇总包，再单独导入分级文件。

## data-bundle.zip 的结构

```text
data-bundle.zip
├── manifest.json
├── champion-pack.json
└── usage/
    ├── 2026-11.json.gz
    ├── 2026-10.json.gz
    └── 2026-09.json.gz
```

`manifest.json` 是导入清单，App **只读这里列出的文件**，未列入的月份不会被导入。字段如下：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | number | 契约版本，当前固定为 `1` |
| `generated` | string | 生成时间，UTC ISO 8601（如 `2026-11-12T00:00:00Z`） |
| `champion` | object | 冠军数据条目 |
| `champion.file` | string | 冠军数据在包内的相对路径，固定 `champion-pack.json` |
| `champion.version` | number | 冠军数据版本号，取自 `champion-pack.json` 的 `version` 字段（`YYYYMMDD` 形式，取不到时为 `0`） |
| `champion.bytes` | number | 该文件的真实字节数 |
| `usage` | array | 已打包的使用率月份，**从新到旧**排列 |
| `usage[].month` | string | 月份，`YYYY-MM` |
| `usage[].file` | string | 该月在包内的相对路径，`usage/<YYYY-MM>.json.gz` |
| `usage[].bytes` | number | 该 gz 文件的真实字节数 |

每个 `usage/<YYYY-MM>.json.gz` 与该月单独发布的 `usage-gen9-<YYYY-MM>.json.gz` 内容一致（smogon chaos 裁剪后的 gzip JSON）。字段只会增加，已有字段的名称与语义不会变。

## 更新节奏

| 数据 | 时间 | workflow |
|---|---|---|
| 冠军数据 | 每周一 03:00 UTC | `.github/workflows/champion-data.yml` |
| 使用率数据 | 每月 5 日 06:00 UTC（smogon 放出上月统计之后） | `.github/workflows/usage-data.yml` |
| 汇总数据包 | 每周一 03:30 UTC（晚于冠军数据，同一轮就能拿到当周最新的冠军包） | `.github/workflows/data-bundle.yml` |

三个 workflow 都能在 Actions 页面手动 **Run workflow**；`data-bundle.yml` 还可以填 `limit`，只打最新 n 个月用于试跑。

## 使用率数据包（单独发布）

- 一次发布 = 一个 Release，tag 为 `usage-data-<YYYY-MM>`，asset 是 `usage-gen9-<YYYY-MM>.json.gz`（约 2 MB）加一份 `usage-index.json`。
- `usage-index.json` 列出**所有已发布月份**，每一项写的是那次 Release 的绝对地址：`releases/latest/download` 只指向最新一次，旧月份靠它取不到，所以索引里不能用相对地址。
- 补某个月：Actions → Usage data pack → Run workflow，`month` 填 smogon 的目录名（如 `2026-10`），留空取上个月；已发布过的月份会被跳过（不覆盖）；smogon 还没放出该月数据时只打一条 warning，不算失败。
- 每月抓取约 470 MB、耗时一小时上下，workflow 的 `timeout-minutes` 设为 180。

## 补历史月份

`.github/workflows/usage-backfill.yml` 用来一次性补齐旧月份（smogon 的月度存档从 2023-01 起都有）：

- Actions → Usage data backfill → Run workflow，填 `from` / `to`（含端点），默认 `2023-01` 到 `2026-09`。
- 按月份拆成矩阵并行，`max-parallel: 4`——smogon 是公益站点，不要一次把几十个月的 worker 全放出去。
- 每个月一个 job：抓 chaos → 裁剪 → 发布 `usage-data-<月>`。已发布过的月份自动跳过，所以可以分批跑、中断后直接重跑。
- 全部结束后另一个 job 汇总已发布月份重建索引，覆盖写到**当时最新**的那个 Release 上（`releases/latest/download/usage-index.json` 靠它取）。
- 单个月份约 1–2 分钟，45 个月跑完大约 20–30 分钟。

## 本地构建汇总包

```bash
node tools/build-bundle.mjs                        # 全部月份，联网下载 usage gz
node tools/build-bundle.mjs --limit 3              # 只取最新 3 个月
node tools/build-bundle.mjs --offline --limit 1    # 只用 dist/bundle/usage 下的缓存
```

- 读 `dist/usage-index.json` 与 `dist/champion-pack.json`（由上面两个 workflow 产出），逐个月份下载到 `dist/bundle/usage/<月>.json.gz`。
- `--out <dir>` 指定输出目录，默认 `dist/bundle`。
- `--offline` 不联网，缺缓存的月份跳过、manifest 里也不列；结束时打印月份数、总字节与输出路径。
- 打包：`cd dist/bundle && zip -r ../data-bundle.zip .`

## 仓库结构与脚本来源（同步说明）

`tools/` 下的生成脚本与基线数据是从代码仓库（PokeDamageCalculator）复制的副本，**同一套脚本存在两份，改动生成逻辑时必须同步**：

| 本仓库路径 | 来源 |
|---|---|
| `tools/gen-champions-ps.mjs` | 代码仓库同名路径 |
| `tools/gen-champion-pack.mjs` | 同上 |
| `tools/lib/load-ts.mjs` | 同上 |
| `tools/gen-usage-raw.mjs` | 同上 |
| `tools/gen-usage-stats.mjs` | 同上 |
| `tools/update-usage.mjs` | 同上（本地一键更新用，CI 不跑） |
| `tools/package.json` / `tools/package-lock.json` | 同上 |
| `core-model/src/main/resources/pokedata/champions.json` | 同上（`gen-champions-ps.mjs` 用它做差异对照，缺了会报错） |

只存在于本仓库：`tools/gen-usage-index.mjs`（生成使用率索引）、`tools/build-bundle.mjs`（组装汇总包）、`.github/workflows/*`。

最后一次同步：代码仓库 `42f99d4`。

同步命令（在代码仓库根目录执行）：

```powershell
$dst = '..\ConnectionNationaldexMovesDamage'
Copy-Item tools\gen-champions-ps.mjs, tools\gen-champion-pack.mjs, tools\package.json, tools\package-lock.json -Destination "$dst\tools" -Force
Copy-Item tools\gen-usage-raw.mjs, tools\gen-usage-stats.mjs, tools\update-usage.mjs -Destination "$dst\tools" -Force
Copy-Item tools\lib\load-ts.mjs -Destination "$dst\tools\lib" -Force
Copy-Item core-model\src\main\resources\pokedata\champions.json -Destination "$dst\core-model\src\main\resources\pokedata" -Force
```

同步后把上面那行 commit 号改成代码仓库当前的 `git rev-parse --short HEAD`。
