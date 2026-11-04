import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 用 esbuild 的 CLI 而不是 JS API：JS API 会以管道 stdio 派生子进程，
// 在受限沙箱下 spawn 直接 EPERM；CLI + stdio'ignore' + 落盘产物可以正常工作。
const ESBUILD = path.resolve(HERE, '../node_modules/@esbuild/win32-x64/esbuild.exe');

let seq = 0;

/** 把上游 data/*.ts 打包成 CJS 后求值，返回其 exports。 */
export function loadTs(entry) {
  const out = path.join(os.tmpdir(), 'load-ts-' + process.pid + '-' + seq++ + '.cjs');
  // 先删残片，保证可重复运行
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const r = spawnSync(
    ESBUILD,
    [entry, '--bundle', '--format=cjs', '--platform=node', '--log-level=error', '--outfile=' + out],
    { stdio: 'ignore' }
  );
  if (r.status !== 0) throw new Error('esbuild 打包失败(' + r.status + '): ' + entry);
  const code = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => ({}));
  return mod.exports;
}
