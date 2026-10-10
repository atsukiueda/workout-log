// 負荷計算（UIに依存しない純粋関数）
'use strict';

const Calc = (() => {
  const splitNames = s => (s || '').split('・').map(x => x.trim()).filter(Boolean);
  // 「僧帽筋(0.25)」→ { name: '僧帽筋', factor: 0.25 }。係数がなければ factor は null
  function parseToken(t) {
    const m = String(t).normalize('NFKC').match(/^(.+?)\s*\(\s*([\d.]+)\s*\)$/);
    return m ? { name: m[1].trim(), factor: Number(m[2]) } : { name: String(t).trim(), factor: null };
  }
  const stripFactor = t => parseToken(t).name;

  // 筋肉名を集計用の筋肉へ展開する
  function expand(name) {
    if (CONFIG.muscles[name]) return [[name, 1]];
    if (CONFIG.aliases[name]) return CONFIG.aliases[name];
    return [];
  }

  // 種目（＋動作）の対象筋 → { 筋肉: 寄与率 }
  function targets(ex, modeIndex) {
    let primary = ex.primary, secondary = ex.secondaryRaw || ex.secondary;
    const modes = CONFIG.modes[ex.id];
    if (modes) {
      const m = modes[modeIndex] || modes[0];
      primary = splitNames(m.primary);
      secondary = splitNames(m.secondary);
    }
    const out = {};
    const add = (tokens, defaultFactor) => tokens.forEach(t => {
      const { name, factor } = parseToken(t);
      const f = factor ?? defaultFactor;
      expand(name).forEach(([muscle, share]) => {
        out[muscle] = Math.max(out[muscle] || 0, f * share);
      });
    });
    add(secondary, CONFIG.secondaryFactor);
    add(primary, CONFIG.primaryFactor); // 主・副の重複は大きい方（主）を採用
    for (const m of Object.keys(out)) if (!(out[m] > 0)) delete out[m];
    return out;
  }

  function loadKind(ex) {
    if (ex.timed) return 'timed';
    if (CONFIG.assisted.includes(ex.id)) return 'assist';
    if (CONFIG.bodyweightFactor[ex.id] != null) return 'bodyweight';
    return 'normal';
  }

  // 1セットの実効負荷(kg)
  function effectiveLoad(ex, set, bodyWeight) {
    const w = Number(set.w) || 0;
    switch (loadKind(ex)) {
      case 'assist': return Math.max(0, bodyWeight - w);
      case 'bodyweight': return bodyWeight * CONFIG.bodyweightFactor[ex.id] + w;
      default: return w;
    }
  }

  const isDone = set => Number(set.r) > 0;

  // 推定1RM（Epley式）: 重量 × (1 + 回数 / 30)。15回を超えると誤差が大きいため算出しない
  function e1rm(load, reps) {
    if (!(load > 0) || !(reps > 0) || reps > 15) return null;
    return reps === 1 ? load : load * (1 + reps / 30);
  }

  // 1種目の集計
  function entryStats(ex, entry, bodyWeight) {
    const sets = entry.sets.filter(isDone);
    let volume = 0, best = null, bestE1rm = null;
    for (const s of sets) {
      const reps = Number(s.r);
      const load = effectiveLoad(ex, s, bodyWeight);
      if (!ex.timed) volume += load * reps;
      const est = ex.timed ? null : e1rm(load, reps);
      if (est != null && (bestE1rm == null || est > bestE1rm)) { bestE1rm = est; best = { load, reps }; }
    }
    return { sets: sets.length, volume, best, bestE1rm };
  }

  // 複数エントリーの部位別・筋肉別の負荷
  //   換算セット数 = Σ(セット × 寄与率)、部位は部位内で最大の寄与率を採用（同じセットを二重計上しない）
  //   ボリューム   = Σ(実効負荷 × 回数 × 寄与率)
  function muscleLoad(items, bodyWeight) {
    const muscles = {}, parts = {};
    CONFIG.parts.forEach(p => { parts[p] = { sets: 0, volume: 0 }; });
    for (const { ex, entry } of items) {
      const t = targets(ex, entry.mode);
      const partFactor = {};
      for (const [m, f] of Object.entries(t)) {
        const p = CONFIG.muscles[m];
        partFactor[p] = Math.max(partFactor[p] || 0, f);
      }
      for (const s of entry.sets.filter(isDone)) {
        const vol = ex.timed ? 0 : effectiveLoad(ex, s, bodyWeight) * Number(s.r);
        for (const [m, f] of Object.entries(t)) {
          const acc = muscles[m] || (muscles[m] = { sets: 0, volume: 0 });
          acc.sets += f; acc.volume += vol * f;
        }
        for (const [p, f] of Object.entries(partFactor)) {
          parts[p].sets += f; parts[p].volume += vol * f;
        }
      }
    }
    return { muscles, parts };
  }

  function rate(sets, range) {
    if (sets <= 0) return { key: 'none', label: '未実施' };
    if (sets < range.low) return { key: 'low', label: '少なめ' };
    if (sets > range.high) return { key: 'high', label: '多め' };
    return { key: 'ok', label: '適正' };
  }

  // 回数による強度ゾーン（一般的な目安）
  function repZone(reps) {
    if (reps <= 5) return '筋力';
    if (reps <= 12) return '筋肥大';
    return '筋持久力';
  }

  // 目的と経験から部位あたりの週の目標セット数を求める
  function weeklyTarget(goal, level) {
    const g = CONFIG.goals[goal] || CONFIG.goals[CONFIG.defaultProfile.goal];
    const f = (CONFIG.levels[level] || CONFIG.levels[CONFIG.defaultProfile.level]).factor;
    const low = Math.max(2, Math.round(g.weekly.low * f));
    return { low, high: Math.max(low + 2, Math.round(g.weekly.high * f)) };
  }

  // 目標比較用の筋群ごとの値（CONFIG.goalGroups）。設定でオフにした筋群は除く
  //   複数の筋肉を持つ筋群（腹筋）は、換算セットが最も多い筋肉の値を採用
  function goalGroups(muscles, settings = {}) {
    return CONFIG.goalGroups
      .filter(g => !g.optional || settings[g.optional] !== false)
      .map(g => {
        const best = g.muscles
          .map(m => ({ muscle: m, ...(muscles[m] || { sets: 0, volume: 0 }) }))
          .sort((a, b) => b.sets - a.sets)[0];
        return { ...g, sets: best.sets, volume: best.volume };
      });
  }

  return { goalGroups, parseToken, stripFactor, weeklyTarget, splitNames, expand, targets, loadKind, effectiveLoad, e1rm, entryStats, muscleLoad, rate, repZone, isDone };
})();
