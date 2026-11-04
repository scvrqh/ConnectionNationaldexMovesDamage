import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs } from './lib/load-ts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS = path.join(ROOT, 'repo2/caches/pokemon-showdown/data');
const MOD = path.join(PS, 'mods/champions');
const BUILTIN = path.join(ROOT, 'core-model/src/main/resources/pokedata/champions.json');
const OUT = path.join(os.tmpdir(), 'champions-ps.json');

// 白名单：formats-data 里没有 isNonstandard 但冠军赛制可用的形态（已由上游调查确定）
const WHITELIST = [
  'mausholdfour', 'meowsticf', 'mimikyubusted', 'morpekohangry', 'palafinhero',
  'polteageistantique', 'sinistchamasterpiece', 'vivillonfancy', 'vivillonpokeball',
];

// PS 不存在的两条形态，数值对齐现有 champions.json
const SYNTHETIC = {
  'Aegislash-Both': {
    abilities: { 0: 'Stance Change' },
    baseSpecies: 'Aegislash-Blade',
    bs: { at: 140, df: 140, hp: 60, sa: 140, sd: 140, sp: 60 },
    types: ['Steel', 'Ghost'],
    weightkg: 53,
  },
  'Aegislash-Shield': {
    abilities: { 0: 'Stance Change' },
    baseSpecies: 'Aegislash-Blade',
    bs: { at: 50, df: 140, hp: 60, sa: 50, sd: 140, sp: 60 },
    types: ['Steel', 'Ghost'],
    weightkg: 53,
  },
};

const MOVEFLAGS = {
  contact: 'makesContact', sound: 'isSound', punch: 'isPunch', bullet: 'isBullet',
  slicing: 'isSlicing', bite: 'isBite', wind: 'isWind', pulse: 'isPulse',
};
const MOVE_BOOLS = [
  'breaksProtect', 'willCrit', 'hasCrashDamage', 'ignoreDefensive', 'multiaccuracy',
  'mindBlownRecoil', 'struggleRecoil',
];
const MOVE_RAW = [
  'target', 'self', 'drain', 'recoil', 'multihit',
  'overrideOffensiveStat', 'overrideDefensiveStat', 'overrideOffensivePokemon',
];

const DAMAGE_TAKEN_MULT = { 0: 1, 1: 2, 2: 0.5, 3: 0 };

/** 深拷贝为 JSON 安全值：丢掉 undefined 属性，空对象视为无值。 */
function jsonSafe(value) {
  if (value === undefined || value === null) return undefined;
  const out = JSON.parse(JSON.stringify(value));
  if (!Array.isArray(out) && typeof out === 'object' && Object.keys(out).length === 0) return undefined;
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 递归按键排序，保证输出确定。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort(byKey)) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

function mergeMod(base, mod) {
  const out = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(mod)])) {
    out[id] = { ...base[id], ...mod[id] };
  }
  return out;
}

// ---------- moves ----------
function buildMoves() {
  const merged = mergeMod(loadTs(path.join(PS, 'moves.ts')).Moves, loadTs(path.join(MOD, 'moves.ts')).Moves);
  const out = {};
  let dup = 0;
  for (const mv of Object.values(merged)) {
    if (mv.isNonstandard != null) continue;
    const key = mv.name;
    if (out[key]) dup++;
    const e = { bp: mv.basePower === undefined ? 0 : mv.basePower, type: mv.type };
    if (mv.category) e.category = mv.category;
    if (mv.priority) e.priority = mv.priority;
    // makesContact: false 不必写出——本项目 schema 是可空布尔，计算侧一律用 == true 判断，null 与 false 等价
    for (const [flag, field] of Object.entries(MOVEFLAGS)) {
      if (mv.flags && mv.flags[flag]) e[field] = true;
    }
    for (const k of MOVE_BOOLS) if (mv[k]) e[k] = true;
    if (mv.secondary !== undefined || mv.secondaries !== undefined) e.secondaries = true;
    for (const k of MOVE_RAW) {
      const v = jsonSafe(mv[k]);
      if (v !== undefined) e[k] = v;
    }
    out[key] = e;
  }
  out['(No Move)'] = { bp: 0, category: 'Status', type: 'Normal' };
  return { moves: out, dup };
}

// ---------- species ----------
function genderOf(p) {
  if (p.gender !== undefined) return p.gender;
  const r = p.genderRatio;
  if (!r) return null;
  if (r.M === 0) return 'F';
  if (r.F === 0) return 'M';
  return null;
}

function buildSpecies() {
  const pokedex = loadTs(path.join(PS, 'pokedex.ts')).Pokedex;
  const formatsData = loadTs(path.join(MOD, 'formats-data.ts')).FormatsData;

  const ids = Object.keys(formatsData)
    .filter((id) => formatsData[id].isNonstandard == null && id !== 'aegislash')
    .concat(WHITELIST);

  const names = new Set(ids.map((id) => pokedex[id].name));
  for (const n of Object.keys(SYNTHETIC)) names.add(n);
  const disponibles = names;

  const species = {};
  const abilityNames = new Set();
  let missing = [];
  let nfeMapped = 0;

  for (const id of ids) {
    const p = pokedex[id];
    if (!p) { missing.push(id); continue; }
    // bs.sl（Gen1 的 Special）在 PS 数据里没有来源，冠军机制不读它，故不输出；不要伪造。
    const bs = p.baseStats;
    const e = {
      types: [...p.types],
      bs: { hp: bs.hp, at: bs.atk, df: bs.def, sa: bs.spa, sd: bs.spd, sp: bs.spe },
      weightkg: p.weightkg,
    };
    const g = genderOf(p);
    if (g) e.gender = g;
    // PS 用 formats-data 的 tier: "NFE" 表达「未完全进化」，damage-calc 用 nfe: true
    if (formatsData[id] && formatsData[id].tier === 'NFE') {
      e.nfe = true;
      nfeMapped++;
    }
    if (p.abilities) {
      // 本项目物种条目只保留 "0" 槽（359 条全是单槽）；能力总表另外取全部槽并集
      if (p.abilities['0']) e.abilities = { 0: p.abilities['0'] };
      for (const name of Object.values(p.abilities)) {
        // PS 的能力名是显示名（"Battle Bond"），按 id 归一化后再扣 battlebond
        if (name.toLowerCase().replace(/[^a-z0-9]/g, '') !== 'battlebond') abilityNames.add(name);
      }
    }
    if (p.canGigantamax) e.canGigantamax = p.canGigantamax;
    const formes = (p.otherFormes || []).filter((f) => disponibles.has(f));
    if (formes.length) e.otherFormes = formes;
    if (p.baseSpecies) e.baseSpecies = p.baseSpecies;
    species[p.name] = e;
  }

  // Aegislash 家族：PS 没有 Both/Shield 两条，Blade 的 otherFormes 也需补齐
  for (const [name, entry] of Object.entries(SYNTHETIC)) species[name] = entry;
  species['Aegislash-Blade'].otherFormes = ['Aegislash-Shield', 'Aegislash-Both'];
  abilityNames.add('Stance Change');

  return { species, abilities: [...abilityNames].sort(byKey), missing, nfeMapped };
}

// ---------- items ----------
function buildItems() {
  const merged = mergeMod(loadTs(path.join(PS, 'items.ts')).Items, loadTs(path.join(MOD, 'items.ts')).Items);
  const names = new Set();
  for (const it of Object.values(merged)) {
    if (it.isNonstandard != null) continue;
    names.add(it.name);
  }
  return [...names].sort(byKey);
}

// ---------- types ----------
function buildTypes() {
  const chart = loadTs(path.join(PS, 'typechart.ts')).TypeChart;
  const types = {};
  // damageTaken 里混有状态免疫键（brn/frz/par/psn/slp/powder 等），只保留真正的属性名
  const validTypes = new Set(Object.keys(chart).map((k) => (k === 'stellar' ? '???' : cap(k))));
  for (const defKey of Object.keys(chart)) {
    const defName = defKey === 'stellar' ? '???' : cap(defKey);
    for (const [atkNameRaw, code] of Object.entries(chart[defKey].damageTaken)) {
      const atkName = atkNameRaw === 'Stellar' ? '???' : atkNameRaw;
      if (!validTypes.has(atkName)) continue;
      // 「???」自我倍率无意义，且现有内置文件同样省略（effectiveness 缺省 1.0）
      if (atkName === '???' && defName === '???') continue;
      (types[atkName] ||= {})[defName] = DAMAGE_TAKEN_MULT[code];
    }
  }
  return types;
}

// ---------- 差异报告 ----------
function diffSets(label, localKeys, psKeys) {
  const L = new Set(localKeys);
  const P = new Set(psKeys);
  const onlyLocal = [...L].filter((k) => !P.has(k)).sort(byKey);
  const onlyPs = [...P].filter((k) => !L.has(k)).sort(byKey);
  console.log('  ' + label + ': 内置=' + L.size + ' 生成=' + P.size +
    ' 仅内置' + onlyLocal.length + ' 条, 仅生成' + onlyPs.length + ' 条');
  if (onlyLocal.length) console.log('    仅内置: ' + onlyLocal.join(', '));
  if (onlyPs.length) console.log('    仅生成: ' + onlyPs.join(', '));
  return { onlyLocal, onlyPs, common: [...L].filter((k) => P.has(k)) };
}

const canon = (v) => (v === undefined ? undefined : JSON.stringify(sortDeep(v)));

function diffFields(label, localMap, psMap, commonKeys) {
  const counts = {};
  const samples = [];
  for (const k of commonKeys) {
    const a = localMap[k];
    const b = psMap[k];
    const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const f of fields) {
      const av = canon(a[f]);
      const bv = canon(b[f]);
      if (av !== bv) {
        const c = counts[f] || (counts[f] = { total: 0, missingLocal: 0, missingGen: 0, differ: 0 });
        c.total++;
        if (av === undefined) c.missingLocal++;
        else if (bv === undefined) c.missingGen++;
        else c.differ++;
        samples.push(f + ' | ' + k + ': 内置=' + (av === undefined ? '(缺)' : av) + ' 生成=' + (bv === undefined ? '(缺)' : bv));
      }
    }
  }
  const entries = Object.entries(counts).sort((x, y) => y[1].total - x[1].total || byKey(x[0], y[0]));
  const totalDiff = entries.reduce((s, e) => s + e[1].total, 0);
  console.log('  ' + label + ' 字段差异（共 ' + totalDiff + ' 处，涉及 ' + entries.length + ' 个字段）:');
  if (!entries.length) console.log('    （无）');
  for (const [f, n] of entries) {
    const ex = samples.filter((s) => s.startsWith(f + ' | ')).slice(0, 2)
      .map((s) => s.slice(f.length + 3)).join(' ; ');
    console.log('    ' + f + ': ' + n.total + ' (内置缺 ' + n.missingLocal + ' / 生成缺 ' + n.missingGen + ' / 值不同 ' + n.differ + ')' + (ex ? '  例: ' + ex : ''));
  }
  if (samples.length) {
    console.log('    前 ' + Math.min(samples.length, 15) + ' 条样例 (共 ' + samples.length + '):');
    for (const s of samples.slice(0, 15)) console.log('      ' + s);
  }
  return counts;
}

function main() {
  const { moves, dup } = buildMoves();
  const { species, abilities, missing, nfeMapped } = buildSpecies();
  const items = buildItems();
  const types = buildTypes();

  const data = sortDeep({ gen: 'champions', species, moves, items, abilities, types });
  fs.writeFileSync(OUT, JSON.stringify(data));

  console.log('=== 生成统计 ===');
  console.log('输出: ' + OUT + '  (' + fs.statSync(OUT).size + ' bytes)');
  console.log('moves=' + Object.keys(moves).length + ' (真实 ' + (Object.keys(moves).length - 1) + ' + (No Move), 重名覆盖 ' + dup + ')');
  console.log('species=' + Object.keys(species).length);
  console.log('items=' + items.length);
  console.log('abilities=' + abilities.length);
  console.log('types=' + Object.keys(types).length);
  console.log('nfe=' + nfeMapped + ' (由 formats-data 的 tier === "NFE" 映射)');
  if (missing.length) console.log('!! 缺失 pokedex 条目: ' + missing.join(', '));

  console.log('');
  console.log('=== 差异报告 vs core-model/src/main/resources/pokedata/champions.json ===');
  const builtin = JSON.parse(fs.readFileSync(BUILTIN, 'utf8'));

  console.log('[1] 招式集合');
  const mv = diffSets('moves', Object.keys(builtin.moves), Object.keys(moves));

  console.log('[2] 招式字段');
  diffFields('moves', builtin.moves, moves, mv.common);

  const normalTargets = Object.keys(moves)
    .filter((k) => moves[k].target === 'normal' && builtin.moves[k] && builtin.moves[k].target === undefined).length;
  console.log('  说明: target 的 ' + normalTargets + ' 处差异是 PS 默认值 "normal"（内置一律省略 target，本脚本按规则 4 直取）');
  console.log('  说明: maxPower/zp 按规则 6 有意不输出（PS 无来源，冠军世代不用极巨化/Z）');

  console.log('[3] species 集合');
  const sp = diffSets('species', Object.keys(builtin.species), Object.keys(species));

  diffFields('species', builtin.species, species, sp.common);

  console.log('[4] items / abilities / types');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  console.log('  items: ' + (eq(builtin.items, items) ? '完全一致' : '不一致') + ' (内置 ' + builtin.items.length + ', 生成 ' + items.length + ')');
  if (!eq(builtin.items, items)) {
    const onlyL = builtin.items.filter((x) => !items.includes(x));
    const onlyP = items.filter((x) => !builtin.items.includes(x));
    console.log('    仅内置: ' + (onlyL.join(', ') || '(无)'));
    console.log('    仅生成: ' + (onlyP.join(', ') || '(无)'));
  }
  const abEq = eq(builtin.abilities, abilities);
  console.log('  abilities: ' + (abEq ? '完全一致' : '不一致') + ' (内置 ' + builtin.abilities.length + ', 生成 ' + abilities.length + ')');
  if (!abEq) {
    const onlyL = builtin.abilities.filter((x) => !abilities.includes(x));
    const onlyP = abilities.filter((x) => !builtin.abilities.includes(x));
    console.log('    仅内置: ' + (onlyL.join(', ') || '(无)'));
    console.log('    仅生成: ' + (onlyP.join(', ') || '(无)'));
  }
  const sortedBuiltinTypes = sortDeep(builtin.types);
  const genTypes = sortDeep(types);
  console.log('  types: ' + (eq(sortedBuiltinTypes, genTypes) ? '完全一致' : '不一致') + ' (内置 ' + Object.keys(builtin.types).length + ' 行, 生成 ' + Object.keys(types).length + ' 行)');
  if (!eq(sortedBuiltinTypes, genTypes)) {
    diffFields('types', sortedBuiltinTypes, genTypes, Object.keys(sortedBuiltinTypes).filter((k) => genTypes[k]));
  }

  console.log('');
  console.log('=== 结论 ===');
  const checks = [
    ['moves=516', Object.keys(moves).length === 516],
    ['species=359', Object.keys(species).length === 359],
    ['items=166', items.length === 166],
    ['abilities=215', abilities.length === 215],
    ['types=19', Object.keys(types).length === 19],
    ['招式仅内置 11 条', mv.onlyLocal.length === 11],
    ['招式仅生成 4 条', mv.onlyPs.length === 4],
  ];
  for (const [name, ok] of checks) console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + name);
  console.log('  species 仅内置 ' + sp.onlyLocal.length + ' 条 / 仅生成 ' + sp.onlyPs.length + ' 条');
}

main();
