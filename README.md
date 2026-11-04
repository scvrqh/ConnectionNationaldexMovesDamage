# ConnectionNationaldexMovesDamage

Champions 数据包的发布仓库。app 里填的固定地址：

    https://github.com/scvrqh/ConnectionNationaldexMovesDamage/releases/latest/download/champion-pack.json

Actions 每周一 03:00 UTC 自动跑一次，也可以在 Actions 页面手动 Run workflow。

## 这里的文件都是从代码仓库复制来的

自包含的代价是「同一套脚本存在两份」，**改动生成逻辑时必须同步**。副本清单：

| 本仓库路径 | 源头（代码仓库同名路径） |
|---|---|
| `tools/gen-champions-ps.mjs` | 同上 |
| `tools/gen-champion-pack.mjs` | 同上 |
| `tools/lib/load-ts.mjs` | 同上 |
| `tools/package.json` / `tools/package-lock.json` | 同上 |
| `core-model/src/main/resources/pokedata/champions.json` | 同上（`gen-champions-ps.mjs` 用它做差异对照，缺了会报错） |

最后一次同步：代码仓库 `c09076c`。

同步命令（在**代码仓库**根目录执行）：

```powershell
$dst = '..\ConnectionNationaldexMovesDamage'
Copy-Item tools\gen-champions-ps.mjs, tools\gen-champion-pack.mjs, tools\package.json, tools\package-lock.json -Destination "$dst\tools" -Force
Copy-Item tools\lib\load-ts.mjs -Destination "$dst\tools\lib" -Force
Copy-Item core-model\src\main\resources\pokedata\champions.json -Destination "$dst\core-model\src\main\resources\pokedata" -Force
```

同步后记得把上面那行 commit 号改成代码仓库当前的 `git rev-parse --short HEAD`。
