#!/usr/bin/env node
// 生成冠军数据包：champions.json 的全部字段 + 顶层 version，用于 GitHub Release 分发与 app 在线更新。
// 只读 JSON，不碰 esbuild，默认沙箱可直接运行。
//
// 用法：
//   node gen-champion-pack.mjs                       # 版本取上游 PS 提交日期，否则今天
//   node gen-champion-pack.mjs --version=20261030
//   node gen-champion-pack.mjs --src=<path> --out=<path>
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SRC = path.join(ROOT, 'core-model/src/main/resources/pokedata/champions.json');
const PS_DIR = path.join(ROOT, 'repo2/caches/pokemon-showdown');

// 与 core-model/src/main/kotlin/com/pokedamage/core/model/data/ChampionPack.kt 保持一致
const GEN_NAME = 'champions';
const MIN_MOVES = 400;
const MIN_SPECIES = 300;

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 递归按键排序，保证同一份输入产生同一份字节。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort(byKey)) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

function argOf(name) {
  const prefix = '--' + name + '=';
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

/** 上游 PS 的提交日期（YYYYMMDD）；目录不存在或不是 git 仓库时返回 null。 */
function upstreamVersion() {
  if (!fs.existsSync(path.join(PS_DIR, '.git'))) return null;
  const r = spawnSync('git', ['-C', PS_DIR, 'log', '-1', '--format=%cd', '--date=format:%Y%m%d'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const s = (r.stdout || '').trim();
  return /^\d{8}$/.test(s) ? Number(s) : null;
}

function todayVersion() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function main() {
  const srcPath = path.resolve(ROOT, argOf('src') ?? DEFAULT_SRC);
  const outPath = path.resolve(ROOT, argOf('out') ?? path.join(os.tmpdir(), 'champion-pack.json'));

  let version;
  let versionFrom;
  const explicit = argOf('version');
  if (explicit !== undefined) {
    if (!/^\d+$/.test(explicit) || Number(explicit) <= 0) fail('--version 必须是正整数，收到 ' + explicit);
    version = Number(explicit);
    versionFrom = '--version';
  } else {
    const upstream = upstreamVersion();
    if (upstream !== null) {
      version = upstream;
      versionFrom = 'upstream git log';
    } else {
      version = todayVersion();
      versionFrom = 'today';
    }
  }

  assert(Number.isInteger(version) && version > 0, 'version 必须是正整数，实际是 ' + version);
  assert(fs.existsSync(srcPath), '找不到源文件 ' + srcPath);

  const raw = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  // version 由本次运行决定；源文件里若已有同名字段则丢弃，其余字段原样保留
  const rest = { ...raw };
  delete rest.version;

  // 顶层 version 置首位，其余键递归排序
  const p = { version };
  for (const k of Object.keys(rest).sort(byKey)) p[k] = sortDeep(rest[k]);

  assert(p.gen === GEN_NAME, 'gen 必须是 ' + GEN_NAME + '，实际是 ' + p.gen);
  assert(p.moves && typeof p.moves === 'object' && !Array.isArray(p.moves), 'moves 必须是对象');
  assert(p.species && typeof p.species === 'object' && !Array.isArray(p.species), 'species 必须是对象');
  assert(p.types && typeof p.types === 'object' && !Array.isArray(p.types), 'types 必须是对象');
  assert(Array.isArray(p.items), 'items 必须是数组');
  assert(Array.isArray(p.abilities), 'abilities 必须是数组');

  const counts = {
    moves: Object.keys(p.moves).length,
    species: Object.keys(p.species).length,
    items: p.items.length,
    abilities: p.abilities.length,
    types: Object.keys(p.types).length,
  };
  assert(counts.moves >= MIN_MOVES, 'moves 只有 ' + counts.moves + ' 条，少于 ' + MIN_MOVES);
  assert(counts.species >= MIN_SPECIES, 'species 只有 ' + counts.species + ' 条，少于 ' + MIN_SPECIES);
  assert(counts.types > 0, 'types 为空');

  // 源字段一条不丢：各表条目数与源文件逐项相等
  const srcCounts = {
    moves: Object.keys(raw.moves ?? {}).length,
    species: Object.keys(raw.species ?? {}).length,
    items: (raw.items ?? []).length,
    abilities: (raw.abilities ?? []).length,
    types: Object.keys(raw.types ?? {}).length,
  };
  for (const k of Object.keys(srcCounts)) {
    assert(counts[k] === srcCounts[k], k + ' 条目数被改动：源 ' + srcCounts[k] + ' → 输出 ' + counts[k]);
  }

  const body = JSON.stringify(p);
  fs.writeFileSync(outPath, body);
  const bytes = fs.statSync(outPath).size;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');

  console.log('version   = ' + version + '  (来源: ' + versionFrom + ')');
  console.log('src       = ' + srcPath);
  console.log('out       = ' + outPath);
  console.log('bytes     = ' + bytes);
  console.log('moves     = ' + counts.moves);
  console.log('species   = ' + counts.species);
  console.log('items     = ' + counts.items);
  console.log('abilities = ' + counts.abilities);
  console.log('types     = ' + counts.types);
  console.log('sha256    = ' + sha256);
  console.log('top-keys  = ' + Object.keys(p).join(', '));
  console.log('head120   = ' + body.slice(0, 120));
  console.log('OK: 通过 ChampionPack 校验规则');
}

main();
