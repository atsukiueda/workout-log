'use strict';

// ---------- ユーティリティ ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = n => Math.round(n).toLocaleString('ja-JP');
const fmtNum = (n, d = 1) => {
  const r = Math.round(n * 10 ** d) / 10 ** d;
  return r.toLocaleString('ja-JP', { maximumFractionDigits: d });
};
const pad = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => toKey(new Date());
const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fmtDate = k => { const d = fromKey(k); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}（${WD[d.getDay()]}）`; };
const fmtShort = k => { const d = fromKey(k); return `${d.getMonth() + 1}/${d.getDate()}`; };
// 検索用の正規化: 全角/半角統一・小文字化・ひらがな→カタカナ・記号と空白を除去
const searchKey = s => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
  .replace(/[\s・/()&\-]/g, '');
// 副対象筋の表示: 係数つきなら「僧帽筋25%」
const fmtToken = t => { const { name, factor } = Calc.parseToken(t); return factor == null ? name : `${name}${Math.round(factor * 100)}%`; };
const uid = () =>Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- 種目マスタ ----------
let master = [];
const exById = new Map();

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

function buildMaster(text) {
  const [head, ...rows] = parseCsv(text);
  const col = name => head.indexOf(name);
  const c = {
    id: col('種目ID'), name: col('種目名'), type: col('種別'), part: col('主な部位'),
    primary: col('主対象筋'), secondary: col('副対象筋'), move: col('動作分類'),
    level: col('難易度目安'), sets: col('セット数目安'), reps: col('回数目安'),
  };
  return rows.map(r => {
    const repsGuide = r[c.reps] || '';
    const nums = repsGuide.match(/\d+/g) || [];
    const tabs = [...new Set(Calc.splitNames(r[c.part]).map(p => CONFIG.partToTab[p]).filter(Boolean))];
    return {
      id: r[c.id], name: r[c.name], type: r[c.type], partRaw: r[c.part],
      primary: Calc.splitNames(r[c.primary]).map(Calc.stripFactor),
      secondary: Calc.splitNames(r[c.secondary]).map(Calc.stripFactor), secondaryRaw: Calc.splitNames(r[c.secondary]),
      move: r[c.move], level: r[c.level], setsGuide: r[c.sets], repsGuide,
      repMin: nums[0] ? Number(nums[0]) : null, repMax: nums[1] ? Number(nums[1]) : null,
      timed: repsGuide.includes('秒'),
      tabs: tabs.length ? tabs : ['その他'],
      searchKey: searchKey(r[c.name] + Object.entries(CONFIG.searchReadings).filter(([w]) => r[c.name].includes(w)).map(([, y]) => y).join('')),
    };
  }).filter(e => e.id && e.name);
}

// ---------- データ保存 ----------
function loadDb() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d.sessions === 'object') return { settings: normalizeSettings(d.settings), sessions: d.sessions };
    }
  } catch (e) { console.warn('記録の読み込みに失敗しました', e); }
  return { settings: normalizeSettings(), sessions: {} };
}
function normalizeSettings(s = {}) {
  return { bodyWeight: CONFIG.defaultBodyWeight, ...CONFIG.defaultProfile, ...s };
}
let db = loadDb();
function saveLocal() {
  for (const [k, s] of Object.entries(db.sessions)) if (!s.entries.length) delete db.sessions[k];
  try { localStorage.setItem(CONFIG.storageKey, JSON.stringify({ version: 1, ...db })); }
  catch (e) { alert('記録を保存できませんでした（ブラウザの保存領域を確認してください）'); }
}
// 手元に保存し、ログイン中ならクラウドへの送信を予約する
function saveDb() {
  saveLocal();
  Sync.schedule();
}
const session = k => db.sessions[k] || (db.sessions[k] = { entries: [] });
const entriesOf = k => (db.sessions[k]?.entries || []);
const bodyWeight = () => Number(db.settings.bodyWeight) || CONFIG.defaultBodyWeight;
const target = () => Calc.weeklyTarget(db.settings.goal, db.settings.level);
const goalDef = () => CONFIG.goals[db.settings.goal] || CONFIG.goals[CONFIG.defaultProfile.goal];
const itemsOf = k => entriesOf(k).map(entry => ({ entry, ex: exById.get(entry.exId) })).filter(x => x.ex);
const sortedDates = () => Object.keys(db.sessions).filter(k => db.sessions[k].entries.length).sort();

// 指定日より前の同じ種目・同じ動作の記録
function previousEntries(exId, mode, beforeKey) {
  const out = [];
  for (const k of sortedDates()) {
    if (k >= beforeKey) break;
    for (const e of db.sessions[k].entries) {
      if (e.exId === exId && (e.mode ?? 0) === (mode ?? 0) && e.sets.some(Calc.isDone)) out.push({ date: k, entry: e });
    }
  }
  return out;
}

// ---------- UI状態 ----------
const ui = { view: 'record', date: todayKey(), tab: null, type: 'すべて', query: '', openPart: null, trend: { view: 'parts', part: 'all', days: 14, metric: 'volume', tip: null }, prog: { key: null, metric: null, range: 180, tip: null }, cal: { month: null, sel: null } };
const main = $('#main');

function setView(v) {
  ui.view = v;
  document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  render();
  window.scrollTo(0, 0);
}
function setDate(k) { ui.date = k; render(); }

function render() {
  $('#dateText').textContent = fmtDate(ui.date) + (ui.date === todayKey() ? ' 今日' : '');
  $('#dateInput').value = ui.date;
  ({ record: renderRecord, eval: renderEval, trend: renderTrend, history: renderHistory, settings: renderSettings })[ui.view]();
}

// ---------- お気に入り（設定に保存するのでクラウド同期される） ----------
const FAV = 'fav';
const favorites = () => (Array.isArray(db.settings.favorites) ? db.settings.favorites : []);
const isFavorite = id => favorites().includes(id);
function toggleFavorite(id) {
  db.settings.favorites = isFavorite(id) ? favorites().filter(x => x !== id) : [...favorites(), id];
  saveDb();
}
const favButton = id => {
  const on = isFavorite(id);
  return `<button class="fav-btn ${on ? 'on' : ''}" data-fav="${id}" aria-pressed="${on}" aria-label="${on ? 'お気に入りから外す' : 'お気に入りに登録'}">${on ? '★' : '☆'}</button>`;
};

// ---------- 記録画面 ----------
const typeBadge = t => `<span class="badge type-${esc(t)}">${esc(t)}</span>`;
// 体重を負荷に含める種目の説明（例: 「負荷 = 体重×88% ＋ 重量」）
function bodyLoadNote(ex) {
  const pct = Math.round(Calc.bodyFactor(ex) * 100);
  return {
    loaded: `負荷 = 体重×${pct}% ＋ 重量`,
    bodyweight: `負荷 = 体重×${pct}% ＋ 追加重量`,
    assist: `負荷 = 体重×${pct}% − アシスト`,
  }[Calc.loadKind(ex)] || '';
}
function unitLabels(ex) {
  const kind = Calc.loadKind(ex);
  return {
    hideWeight: ex.timed && ex.type === '自重',
    w: { assist: 'アシストkg', bodyweight: '追加kg' }[kind] || 'kg',
    r: ex.timed ? '秒' : '回',
  };
}
const setText = (ex, s) => {
  const u = unitLabels(ex);
  const w = Number(s.w) || 0;
  const kind = Calc.loadKind(ex);
  const wt = u.hideWeight ? ''
    : kind === 'bodyweight' ? (w ? `自重+${fmtNum(w)}kg` : '自重')
    : kind === 'loaded' && !w ? '自重'
    : kind === 'assist' ? `アシスト${fmtNum(w)}kg`
    : `${fmtNum(w)}${u.w}`;
  return `${wt}${wt ? '×' : ''}${s.r}${u.r}`;
};

function entrySummary(ex, entry) {
  const st = Calc.entryStats(ex, entry, bodyWeight());
  if (!st.sets) return 'セット未入力';
  const parts = [`${st.sets}セット`];
  if (!ex.timed) parts.push(`ボリューム ${fmtInt(st.volume)}kg`);
  if (st.bestE1rm) parts.push(`推定1RM ${fmtNum(st.bestE1rm)}kg`);
  return parts.join(' ・ ');
}

function renderEntry(entry) {
  const ex = exById.get(entry.exId);
  if (!ex) return `<article class="card entry" data-uid="${entry.uid}"><p>不明な種目 ${esc(entry.exId)}</p><button class="text-btn danger" data-act="del-entry">削除</button></article>`;
  const u = unitLabels(ex);
  const modes = CONFIG.modes[ex.id];
  const prev = previousEntries(ex.id, entry.mode, ui.date).pop();
  const prevSets = prev ? prev.entry.sets.filter(Calc.isDone) : [];
  const targets = Calc.targets(ex, entry.mode);
  const prim = Object.entries(targets).filter(([, f]) => f >= CONFIG.primaryFactor - 1e-9).map(([m]) => m);
  // 薄い文字の見本: 今日の目安があればそれ、なければ前回の同じセット
  const sug = nextSuggestion(ex, entry);
  const sugPh = sug && sug.kind !== 'first' ? { w: sug.weight ? String(sug.weight) : '', r: String(sug.reps) } : null;
  const rows = entry.sets.map((s, i) => {
    const ph = sugPh || prevSets[i] || prevSets[prevSets.length - 1];
    return `<div class="set-row" data-i="${i}">
      <span class="set-no">${i + 1}</span>
      ${u.hideWeight ? '<span class="set-skip">—</span>' : `<label class="num-field"><input data-f="w" type="text" inputmode="decimal" value="${esc(s.w)}" placeholder="${ph && ph.w !== '' ? esc(ph.w) : ''}" aria-label="${i + 1}セット目の重量"><span>${u.w}</span></label>`}
      <label class="num-field"><input data-f="r" type="text" inputmode="numeric" value="${esc(s.r)}" placeholder="${ph ? esc(ph.r) : ''}" aria-label="${i + 1}セット目の${u.r === '秒' ? '秒数' : '回数'}"><span>${u.r}</span></label>
      <button class="icon-btn small" data-act="del-set" aria-label="${i + 1}セット目を削除">✕</button>
    </div>`;
  }).join('');
  return `<article class="card entry" data-uid="${entry.uid}">
    <div class="entry-head">
      <div>
        <h3>${esc(ex.name)}</h3>
        <div class="meta">${typeBadge(ex.type)} 主対象: ${esc(prim.join('・') || '—')} ・ 目安 ${esc(ex.setsGuide)}セット×${esc(ex.repsGuide)}${ex.timed ? '' : '回'}</div>
        ${bodyLoadNote(ex) ? `<div class="meta body-note">${esc(bodyLoadNote(ex))}（体重 ${fmtNum(bodyWeight())}kg）</div>` : ''}
      </div>
      <div class="entry-actions">${favButton(ex.id)}<button class="text-btn danger" data-act="del-entry">削除</button></div>
    </div>
    ${modes ? `<label class="mode-select">動作 <select data-act="mode">${modes.map((m, i) => `<option value="${i}" ${i === (entry.mode ?? 0) ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>` : ''}
    ${prev ? `<p class="prev">前回 ${fmtShort(prev.date)}: ${prevSets.map(s => esc(setText(ex, s))).join(' / ')}</p>` : ''}
    ${suggestionHtml(ex, entry)}
    <div class="sets">${rows}</div>
    <div class="entry-foot">
      <button class="text-btn" data-act="add-set">＋ セット追加</button>
      ${RestTimer.enabled() ? `<button class="text-btn rest-btn" data-act="rest-start" title="レストタイマーを開始">⏱ ${RestTimer.fmt(restSeconds(ex))}</button>` : ''}
      <span class="entry-sum">${esc(entrySummary(ex, entry))}</span>
    </div>
  </article>`;
}

// 単関節種目か（レスト時間の初期値に使う）
function isIsolation(ex) {
  if (CONFIG.isolationMoves.includes(ex.move)) return true;
  if (ex.move === '下半身') return !(ex.primary.includes('大腿四頭筋') && ex.primary.includes('大臀筋'));
  return false;
}
// その種目のレスト時間（秒）。設定で固定値にしていればそれを使う
function restSeconds(ex) {
  const mode = db.settings.restMode;
  if (mode && mode !== 'auto') return Number(mode);
  const r = CONFIG.rest[db.settings.goal] || CONFIG.rest[CONFIG.defaultProfile.goal];
  return isIsolation(ex) ? r.isolation : r.compound;
}

// ---------- 次回の重量の提案（ダブルプログレッション） ----------
// 回数の範囲: 種目の目安回数と目的の推奨回数が重なる部分。単関節種目は種目の目安を優先
function repRange(ex) {
  if (ex.timed || ex.repMin == null) return null;
  const [gMin, gMax] = goalDef().reps;
  const mMin = ex.repMin, mMax = ex.repMax ?? ex.repMin;
  // 単関節種目と、重りを足さない自重種目（腕立て伏せなど）は種目の目安をそのまま使う
  if (isIsolation(ex) || (Calc.loadKind(ex) === 'bodyweight' && !progressionStep(ex))) return [mMin, mMax];
  const lo = Math.max(mMin, gMin), hi = Math.min(mMax, gMax);
  return hi - lo >= 2 ? [lo, hi] : [gMin, gMax];
}
function progressionStep(ex) {
  const p = CONFIG.progression;
  const kind = Calc.loadKind(ex);
  const lower = ex.tabs.includes('脚') || ex.tabs.includes('臀部');
  if (kind === 'assist') return p.assist;
  if (kind === 'bodyweight') return p.addableBodyweight.includes(ex.id) ? p.bodyweightAdd : 0;
  if (ex.name.includes('ダンベル')) return p.dumbbell;
  if (ex.type === 'フリーウェイト') return lower ? p.barbellLower : p.barbellUpper;
  return lower ? p.machineLower : p.machineUpper;
}
const weightText = (ex, w) => {
  const kind = Calc.loadKind(ex);
  if (kind === 'assist') return `アシスト${fmtNum(w)}kg`;
  if (kind === 'bodyweight') return w ? `自重+${fmtNum(w)}kg` : '自重';
  return `${fmtNum(w)}kg`;
};

function nextSuggestion(ex, entry) {
  const range = repRange(ex);
  if (!range) return null;
  const [lo, hi] = range;
  const prev = previousEntries(ex.id, entry.mode, ui.date).pop();
  if (!prev) return { kind: 'first', lo, hi, text: `${lo}〜${hi}回できる重量で始めましょう` };
  const sets = prev.entry.sets.filter(Calc.isDone).map(s => ({ w: Number(s.w) || 0, r: Number(s.r) }));
  const assist = Calc.loadKind(ex) === 'assist';
  // 主セット = 最も負荷の高いセット（アシスト種目はアシストが最も少ないセット）
  const top = assist ? Math.min(...sets.map(s => s.w)) : Math.max(...sets.map(s => s.w));
  const minReps = Math.min(...sets.filter(s => s.w === top).map(s => s.r));
  const step = progressionStep(ex);
  const prevText = `前回 ${weightText(ex, top)}・最少${minReps}回`;
  const roundStep = w => (step ? Math.round(w / step) * step : w);
  if (minReps >= hi) {
    if (!step) return { kind: 'reps', weight: top, reps: Math.max(hi, minReps) + 1, lo, hi, text: `${prevText}で上限到達 → 回数をさらに増やす（難しいバリエーションへの移行も検討）` };
    const w = assist ? Math.max(0, top - step) : top + step;
    return { kind: 'up', weight: w, reps: lo, lo, hi, text: `${prevText}で上限${hi}回に到達 → 重量アップ` };
  }
  if (minReps < lo - 2 && step) {
    const w = assist ? top + step : Math.max(0, roundStep(top * CONFIG.progression.dropRatio));
    return { kind: 'down', weight: w, reps: lo, lo, hi, text: `${prevText}（目安${lo}〜${hi}回を大きく下回った）→ 重量を下げる` };
  }
  if (minReps < lo) return { kind: 'same', weight: top, reps: lo, lo, hi, text: `${prevText} → 同じ重量で${lo}回を目指す` };
  return { kind: 'reps', weight: top, reps: Math.min(minReps + 1, hi), lo, hi, text: `${prevText} → 同じ重量で1回多く` };
}

function suggestionHtml(ex, entry) {
  const s = nextSuggestion(ex, entry);
  if (!s) return '';
  if (s.kind === 'first') return `<div class="next-hint first">💡 ${esc(s.text)}</div>`;
  const icon = { up: '⬆', down: '⬇', same: '➡', reps: '➕' }[s.kind];
  const canApply = entry.sets.some(x => x.w === '') && (s.weight > 0 || Calc.loadKind(ex) !== 'bodyweight');
  return `<div class="next-hint ${s.kind}">
    <div class="next-main">💡 今日の目安 <b>${icon} ${esc(weightText(ex, s.weight))} × ${s.reps}回</b>
      ${canApply ? '<button class="text-btn small" data-act="apply-hint">重量を入力</button>' : ''}</div>
    <div class="next-why">${esc(s.text)}</div>
  </div>`;
}

function daySummaryText(k) {
  const items = itemsOf(k);
  const sets = items.reduce((a, { entry }) => a + entry.sets.filter(Calc.isDone).length, 0);
  return `${items.length}種目 ・ ${sets}セット`;
}

function renderRecord() {
  const entries = entriesOf(ui.date);
  main.innerHTML = `
    <section>
      <div class="section-head"><h2>トレーニング記録</h2><span class="muted" id="daySummary">${daySummaryText(ui.date)}</span></div>
      ${entries.length ? entries.map(renderEntry).join('') : '<p class="empty">まだ種目がありません。下のボタンから部位を選んで追加してください。</p>'}
      <button class="primary-btn block" data-act="open-picker">＋ 種目を追加</button>
      ${entries.length ? '<button class="secondary-btn block" data-act="go-eval">この日の評価を見る</button>' : ''}
    </section>`;
}

function findEntry(el) {
  const card = el.closest('.entry');
  if (!card) return {};
  const entry = entriesOf(ui.date).find(e => e.uid === card.dataset.uid);
  return { card, entry, ex: entry && exById.get(entry.exId) };
}

// 重量・回数の欄をタップしたら中身を全選択し、そのまま打てば置き換わるようにする
//   iPhone はフォーカス直後にカーソル位置を決め直すため、少し遅らせてもう一度選択する
function selectAllSoon(input) {
  const sel = () => { if (document.activeElement === input) input.setSelectionRange(0, input.value.length); };
  sel();
  requestAnimationFrame(sel);
  setTimeout(sel, 60);
}
let focusedAt = 0;
main.addEventListener('focusin', e => {
  if (!e.target.matches('input[data-f]')) return;
  focusedAt = Date.now();
  selectAllSoon(e.target);
});
// フォーカス直後のタップ（click）でカーソルが置かれて選択が外れるのを防ぐ。2回目以降のタップは通常どおり
main.addEventListener('click', e => {
  if (e.target.matches('input[data-f]') && Date.now() - focusedAt < 500) selectAllSoon(e.target);
});

main.addEventListener('input', e => {
  const t = e.target;
  if (!t.dataset.f) return;
  const { card, entry, ex } = findEntry(t);
  if (!entry) return;
  const i = Number(t.closest('.set-row').dataset.i);
  const v = t.value.replace(/[０-９．]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/[^\d.]/g, '');
  if (v !== t.value) t.value = v;
  entry.sets[i][t.dataset.f] = v;
  saveDb();
  if (ex) card.querySelector('.entry-sum').textContent = entrySummary(ex, entry);
  $('#daySummary').textContent = daySummaryText(ui.date);
});

main.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.act === 'prog-ex') {
    setProg({ key: t.value, metric: null, tip: null });
    return;
  }
  if (t.dataset.f === 'r') {
    // 今日の記録で回数を入れ終えたら、レストタイマーを自動で開始
    const { ex } = findEntry(t);
    if (ex && Number(t.value) > 0 && RestTimer.enabled() && db.settings.restAuto !== false && ui.date === todayKey()) RestTimer.start(restSeconds(ex), ex.name);
  } else if (t.dataset.act === 'mode') {
    const { entry } = findEntry(t);
    entry.mode = Number(t.value);
    saveDb(); render();
  } else if (t.dataset.device) {
    RestTimer.setDevice({ [t.dataset.device]: t.type === 'checkbox' ? t.checked : t.value });
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  } else if (t.dataset.setting) {
    const key = t.dataset.setting;
    if (t.type === 'checkbox') db.settings[key] = t.checked;
    else if (t.type === 'number') {
      const v = Number(t.value);
      if (t.value === '' && key === 'height') db.settings.height = '';
      else if (v > 0) db.settings[key] = v;
      else return;
    } else db.settings[key] = t.value;
    saveDb();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  } else if (t.id === 'importFile' && t.files[0]) {
    importJson(t.files[0]);
    t.value = '';
  }
});

main.addEventListener('click', e => {
  const f = e.target.closest('[data-fav]');
  if (f) {
    const id = f.dataset.fav;
    toggleFavorite(id);
    main.querySelectorAll(`[data-fav="${id}"]`).forEach(el => { el.outerHTML = favButton(id); });
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'SELECT') return;
  const act = b.dataset.act;
  const { entry } = findEntry(b);
  switch (act) {
    case 'open-picker': openPicker(); break;
    case 'go-eval': setView('eval'); break;
    case 'go-record': setView('record'); break;
    case 'go-settings': setView('settings'); break;
    case 'suggest-add': {
      const k = todayKey();
      const mode = b.dataset.mode === '' ? null : Number(b.dataset.mode);
      session(k).entries.push({ uid: uid(), exId: b.dataset.ex, mode, sets: [{ w: '', r: '' }] });
      saveDb();
      ui.date = k;
      setView('record');
      document.querySelector('.entry:last-of-type')?.scrollIntoView({ block: 'center' });
      break;
    }
    case 'apply-hint': {
      const ex = exById.get(entry.exId);
      const s = nextSuggestion(ex, entry);
      if (s && s.weight != null) entry.sets.forEach(x => { if (x.w === '') x.w = String(s.weight || ''); });
      saveDb(); render(); break;
    }
    case 'rest-test': RestTimer.testSound(); break;
    case 'rest-start': { const ex = exById.get(entry.exId); RestTimer.start(restSeconds(ex), ex.name); break; }
    case 'add-set': {
      const last = entry.sets[entry.sets.length - 1];
      entry.sets.push(last ? { ...last } : { w: '', r: '' });
      saveDb(); render();
      const rows = document.querySelectorAll(`.entry[data-uid="${entry.uid}"] .set-row`);
      rows[rows.length - 1]?.querySelector('input')?.focus();
      break;
    }
    case 'del-set':
      entry.sets.splice(Number(b.closest('.set-row').dataset.i), 1);
      if (!entry.sets.length) entry.sets.push({ w: '', r: '' });
      saveDb(); render(); break;
    case 'del-entry': {
      const ex = exById.get(entry.exId);
      if (!confirm(`「${ex ? ex.name : entry.exId}」を削除しますか？`)) return;
      const s = session(ui.date);
      s.entries = s.entries.filter(x => x !== entry);
      saveDb(); render(); break;
    }
    case 'toggle-part': ui.openPart = ui.openPart === b.dataset.part ? null : b.dataset.part; render(); break;
    case 'open-date': ui.date = b.dataset.date; ui.trend.tip = null; setView('record'); break;
    case 'trend-part': setTrend({ part: b.dataset.part, tip: null }); break;
    case 'trend-days': setTrend({ days: Number(b.dataset.days), tip: null }); break;
    case 'trend-metric': setTrend({ metric: b.dataset.metric }); break;
    case 'cal-month': setCal({ month: b.dataset.n === '0' ? monthKey(todayKey()) : addMonths(ui.cal.month, Number(b.dataset.n)), sel: null }); break;
    case 'cal-day': setCal({ sel: ui.cal.sel === b.dataset.date ? null : b.dataset.date }); break;
    case 'cal-close': setCal({ sel: null }); break;
    case 'trend-view': ui.trend.view = b.dataset.view; render(); window.scrollTo(0, 0); break;
    case 'prog-range': setProg({ range: Number(b.dataset.days), tip: null }); break;
    case 'prog-metric': setProg({ metric: b.dataset.metric }); break;
    case 'prog-point': setProg({ tip: ui.prog.tip === b.dataset.date ? null : b.dataset.date }); break;
    case 'prog-tip-close': setProg({ tip: null }); break;
    case 'open-progress': ui.trend.view = 'exercise'; ui.prog = { ...ui.prog, key: b.dataset.key, metric: null, tip: null }; setView('trend'); break;
    case 'trend-tip-close': setTrend({ tip: null }); break;
    case 'heat-week': ui.date = addDays(b.dataset.date, 6) > todayKey() ? todayKey() : addDays(b.dataset.date, 6); setView('eval'); break;
    case 'trend-bar': {
      const same = ui.trend.tip?.date === b.dataset.date && ui.trend.tip?.part === b.dataset.part;
      setTrend({ tip: same ? null : { date: b.dataset.date, part: b.dataset.part } });
      break;
    }
    case 'sync-login': syncLogin(); break;
    case 'sync-now': Sync.syncNow(); break;
    case 'sync-logout': syncLogout(); break;
    case 'export': exportJson(); break;
    case 'import': $('#importFile').click(); break;
    case 'clear-all':
      if (confirm(Sync.getState().email ? 'すべての記録を削除します。クラウドからも削除され、元に戻せません。よろしいですか？' : 'すべての記録を削除します。元に戻せません。よろしいですか？')) { db.sessions = {}; saveDb(); render(); }
      break;
  }
});

// ---------- 種目選択シート ----------
const sheet = $('#pickerSheet'), backdrop = $('#sheetBackdrop');
const TYPES = ['すべて', 'マシン', 'プレートロード', 'フリーウェイト', '自重'];

function openPicker() {
  if (!ui.tab) ui.tab = favorites().length ? FAV : '胸';
  sheet.hidden = backdrop.hidden = false;
  document.body.classList.add('sheet-open');
  renderPicker();
}
function closePicker() {
  sheet.hidden = backdrop.hidden = true;
  document.body.classList.remove('sheet-open');
  ui.query = ''; $('#pickerSearch').value = '';
}

function renderPicker() {
  const favSet = new Set(favorites());
  $('#partTabs').innerHTML = [FAV, ...CONFIG.tabs].map(t => {
    const n = t === FAV ? master.filter(e => favSet.has(e.id)).length : master.filter(e => e.tabs.includes(t)).length;
    return `<button role="tab" aria-selected="${t === ui.tab && !ui.query}" data-tab="${t}" class="${t === FAV ? 'fav-tab' : ''}">${t === FAV ? '★ お気に入り' : t}<small>${n}</small></button>`;
  }).join('');
  $('#typeChips').innerHTML = TYPES.map(t => `<button class="chip ${t === ui.type ? 'on' : ''}" data-type="${t}">${t}</button>`).join('');
  const q = searchKey(ui.query);
  const done = new Set(entriesOf(ui.date).map(e => e.exId));
  const usage = {};
  for (const k of sortedDates()) for (const e of db.sessions[k].entries) usage[e.exId] = (usage[e.exId] || 0) + 1;
  const list = master
    .filter(e => q ? e.searchKey.includes(q) : ui.tab === FAV ? favSet.has(e.id) : e.tabs.includes(ui.tab))
    .filter(e => ui.type === 'すべて' || e.type === ui.type)
    .sort((a, b) => (usage[b.id] || 0) - (usage[a.id] || 0));
  $('#pickerList').innerHTML = list.length ? list.map(e => `
    <li class="pick-row"><button class="pick-main" data-ex="${e.id}">
      <span class="pick-name">${esc(e.name)}${done.has(e.id) ? ' <span class="badge done">追加済</span>' : ''}</span>
      <span class="pick-meta">${typeBadge(e.type)} ${esc(e.primary.join('・'))}${e.secondary.length ? ` <span class="muted">／${esc(e.secondaryRaw.map(fmtToken).join('・'))}</span>` : ''}${usage[e.id] ? ` <span class="muted">・${usage[e.id]}回実施</span>` : ''}</span>
    </button>${favButton(e.id)}</li>`).join('')
    : `<li class="empty">${ui.tab === FAV && !q ? 'お気に入りはまだありません。各部位のタブで種目の ☆ をタップすると登録できます。' : '該当する種目がありません'}</li>`;
}

$('#partTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab; ui.query = ''; $('#pickerSearch').value = '';
  renderPicker(); $('#pickerList').scrollTop = 0;
});
$('#typeChips').addEventListener('click', e => {
  const b = e.target.closest('[data-type]');
  if (b) { ui.type = b.dataset.type; renderPicker(); }
});
$('#pickerSearch').addEventListener('input', e => { ui.query = e.target.value; renderPicker(); });
$('#pickerList').addEventListener('click', e => {
  const f = e.target.closest('[data-fav]');
  if (f) {
    toggleFavorite(f.dataset.fav);
    const y = $('#pickerList').scrollTop;
    renderPicker();
    $('#pickerList').scrollTop = y;
    return;
  }
  const b = e.target.closest('[data-ex]');
  if (!b) return;
  const exId = b.dataset.ex;
  const prev = previousEntries(exId, 0, ui.date).pop();
  const entry = { uid: uid(), exId, mode: CONFIG.modes[exId] ? (prev?.entry.mode ?? 0) : null, sets: [{ w: '', r: '' }] };
  session(ui.date).entries.push(entry);
  saveDb(); closePicker();
  if (ui.view !== 'record') setView('record'); else render();
  const card = document.querySelector(`.entry[data-uid="${entry.uid}"]`);
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.querySelector('input')?.focus({ preventScroll: true });
});
$('#closeSheet').addEventListener('click', closePicker);
backdrop.addEventListener('click', closePicker);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) closePicker(); });

// ---------- 評価画面 ----------
const RATE_ICON = { none: '－', low: '▼', ok: '●', high: '▲' };

// 部位の棒グラフ行（この日の負荷用）
const partRows = load => CONFIG.parts.map(p => ({ key: p, short: p, label: p, ...load.parts[p] }));
// 筋群の棒グラフ行（目標との比較用）
const groupRows = load => Calc.goalGroups(load.muscles, db.settings);

// rows: [{ key, short, label, sets, volume }]。opts.detail(row) を渡すとタップで内訳を開ける
function loadBars(rows, range, opts = {}) {
  const max = Math.max(range.high * 1.25, ...rows.map(r => r.sets));
  const pct = v => `${(v / max) * 100}%`;
  return `<div class="bars ${opts.className || ''}" role="table" aria-label="${esc(opts.label)}">
    <div class="bars-legend muted"><span class="band-swatch"></span>目安 ${range.low}〜${range.high}セット</div>
    ${rows.map(v => {
      const r = Calc.rate(v.sets, range);
      const open = opts.detail && ui.openPart === v.key;
      return `<div class="bar-row" role="row">
        <button class="bar-btn" ${opts.detail ? `data-act="toggle-part" data-part="${v.key}" aria-expanded="${open}"` : 'tabindex="-1"'}
          title="${esc(v.label)}: 換算${fmtNum(v.sets)}セット / ボリューム${fmtInt(v.volume)}kg">
          <span class="bar-label" role="rowheader">${esc(v.short)}</span>
          <span class="bar-track">
            <span class="bar-band" style="left:${pct(range.low)};width:${pct(range.high - range.low)}"></span>
            ${v.sets > 0 ? `<span class="bar-fill" style="width:${pct(v.sets)}"></span>` : ''}
          </span>
          <span class="bar-value" role="cell">${fmtNum(v.sets)}<small>セット</small></span>
          <span class="rate rate-${r.key}" role="cell">${RATE_ICON[r.key]} ${r.label}</span>
        </button>
        ${open ? opts.detail(v) : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// この日の負荷: 部位をタップしたときの筋肉ごとの内訳
const partDetail = muscles => v => {
  const ms = Object.entries(muscles).filter(([m]) => CONFIG.muscles[m] === v.key).sort((a, b) => b[1].sets - a[1].sets);
  return `<div class="muscle-detail">${ms.length ? `<table><thead><tr><th>筋肉</th><th>換算セット</th><th>ボリューム</th></tr></thead><tbody>
    ${ms.map(([m, x]) => `<tr><td>${m}</td><td>${fmtNum(x.sets)}</td><td>${fmtInt(x.volume)}kg</td></tr>`).join('')}</tbody></table>` : '<p class="muted">この部位の記録はありません</p>'}
    <p class="muted">部位のボリューム: ${fmtInt(v.volume)}kg</p></div>`;
};

function evaluateEntry(ex, entry) {
  const bw = bodyWeight();
  const st = Calc.entryStats(ex, entry, bw);
  const done = entry.sets.filter(Calc.isDone);
  const notes = [];
  const prevList = previousEntries(ex.id, entry.mode, ui.date);
  let pr = null, volDiff = null;
  if (!prevList.length) notes.push({ cls: 'info', text: '初めての記録' });
  else {
    const prevBest = Math.max(0, ...prevList.map(p => Calc.entryStats(ex, p.entry, bw).bestE1rm || 0));
    if (st.bestE1rm && prevBest && st.bestE1rm > prevBest + 1e-9) {
      pr = st.bestE1rm - prevBest;
      notes.push({ cls: 'good', text: `自己ベスト更新（推定1RM +${fmtNum(pr)}kg）` });
    }
    const last = prevList[prevList.length - 1];
    const lastVol = Calc.entryStats(ex, last.entry, bw).volume;
    if (!ex.timed && lastVol > 0) {
      volDiff = (st.volume - lastVol) / lastVol * 100;
      notes.push({ cls: volDiff >= 0 ? 'good' : 'info', text: `前回（${fmtShort(last.date)}）比 ボリューム ${volDiff >= 0 ? '+' : ''}${fmtNum(volDiff, 0)}%` });
    }
  }
  if (!ex.timed && ex.repMin && done.length) {
    const reps = done.map(s => Number(s.r));
    const below = reps.filter(r => r < ex.repMin).length, above = reps.filter(r => ex.repMax && r > ex.repMax).length;
    const inRange = reps.length - below - above;
    notes.push({ cls: inRange === reps.length ? 'good' : 'info', text: `目安${ex.repsGuide}回の範囲内 ${inRange}/${reps.length}セット` });
    if (above) notes.push({ cls: 'info', text: '目安より多く挙がるセットあり → 重量を上げる候補' });
    if (below) notes.push({ cls: 'info', text: '目安より少ない回数のセットあり（高重量寄り）' });
    const avg = reps.reduce((a, b) => a + b, 0) / reps.length;
    const [gMin, gMax] = goalDef().reps;
    const fit = reps.filter(r => r >= gMin && r <= gMax).length;
    notes.push({ cls: fit === reps.length ? 'good' : 'info', text: `強度ゾーン: ${Calc.repZone(avg)}（平均${fmtNum(avg)}回）・目的の推奨${gMin}〜${gMax}回に ${fit}/${reps.length}セット該当` });
  }
  if (ex.repMin == null || ex.timed) { /* 秒指定の種目は回数評価をしない */ }
  const setsGuide = (ex.setsGuide.match(/\d+/g) || []).map(Number);
  if (setsGuide.length === 2 && done.length && done.length < setsGuide[0]) notes.push({ cls: 'info', text: `セット数が目安（${ex.setsGuide}）より少なめ` });
  return { st, notes };
}

function renderEval() {
  const bw = bodyWeight();
  const items = itemsOf(ui.date);
  const day = Calc.muscleLoad(items, bw);
  const weekItems = [];
  for (let i = 6; i >= 0; i--) weekItems.push(...itemsOf(addDays(ui.date, -i)));
  const week = Calc.muscleLoad(weekItems, bw);
  const totalSets = items.reduce((a, { entry }) => a + entry.sets.filter(Calc.isDone).length, 0);
  const totalVol = items.reduce((a, { ex, entry }) => a + Calc.entryStats(ex, entry, bw).volume, 0);
  const evals = items.map(({ ex, entry }) => ({ ex, entry, ...evaluateEntry(ex, entry) }));

  // 総評
  const comments = [];
  const byRate = key => CONFIG.parts.filter(p => Calc.rate(day.parts[p].sets, CONFIG.sessionRange).key === key);
  if (byRate('ok').length) comments.push(`● ${byRate('ok').join('・')} は1回の量として適正範囲です。`);
  if (byRate('high').length) comments.push(`▲ ${byRate('high').join('・')} は${CONFIG.sessionRange.high}セット超。1回の効果は頭打ちになりやすいので、別の日に分けるのも有効です。`);
  if (byRate('low').length) comments.push(`▼ ${byRate('low').join('・')} は${CONFIG.sessionRange.low}セット未満で刺激が少なめです（補助的に使われた分も含む）。`);
  const groups = groupRows(week);
  const untouched = CONFIG.parts.filter(p => week.parts[p].sets === 0);
  if (untouched.length) comments.push(`直近7日間で未実施の部位: ${untouched.join('・')}`);
  const range = target();
  const wkHigh = groups.filter(g => g.sets > range.high).map(g => g.label);
  if (wkHigh.length) comments.push(`直近7日間で目標上限（週${range.high}セット）を超えた筋肉: ${wkHigh.join('・')}（回復に注意）`);
  const wkOk = groups.filter(g => Calc.rate(g.sets, range).key === 'ok');
  if (wkOk.length === groups.length) comments.push('🎯 直近7日間で全筋群が目標範囲に入っています！');
  const chest = week.parts['胸'].sets, back = week.parts['背中'].sets;
  if (chest >= 3 && back < chest * 0.67) comments.push(`押す種目（胸 ${fmtNum(chest)}）に対して引く種目（背中 ${fmtNum(back)}）が少なめです。姿勢バランスのため背中も意識しましょう。`);
  const prs = evals.filter(e => e.notes.some(n => n.text.startsWith('自己ベスト'))).length;
  if (prs) comments.push(`🏆 自己ベスト更新 ${prs}種目！`);

  main.innerHTML = !items.length ? `
    <section><div class="section-head"><h2>評価</h2></div>
      <p class="empty">${fmtDate(ui.date)} の記録はありません。</p>
      <button class="primary-btn block" data-act="go-record">記録画面へ</button>
      ${weekItems.length ? goalCard(week) : ''}
      ${nextCard(week)}
    </section>` : `
    <section>
      <div class="section-head"><h2>評価</h2><span class="muted">体重 ${fmtNum(bw)}kg で計算</span></div>
      <div class="stat-row">
        <div class="stat"><span class="stat-value">${items.length}</span><span class="stat-label">種目</span></div>
        <div class="stat"><span class="stat-value">${totalSets}</span><span class="stat-label">セット</span></div>
        <div class="stat"><span class="stat-value">${fmtInt(totalVol)}<small>kg</small></span><span class="stat-label">総ボリューム</span></div>
      </div>
      ${comments.length ? `<div class="card comments"><h3>総評</h3><ul>${comments.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
      ${goalCard(week)}
      <div class="card">
        <h3>部位別の負荷（この日）</h3>
        <p class="muted small">部位をタップすると筋肉ごとの内訳を表示します。</p>
        ${loadBars(partRows(day), CONFIG.sessionRange, { detail: partDetail(day.muscles), label: 'この日の部位別換算セット' })}
      </div>
      <div class="card">
        <h3>種目ごとの評価</h3>
        ${evals.map(({ ex, entry, st, notes }) => `
          <div class="ex-eval">
            <div class="ex-eval-head"><strong>${esc(ex.name)}</strong>${CONFIG.modes[ex.id] ? ` <span class="muted">（${esc(CONFIG.modes[ex.id][entry.mode ?? 0].label)}）</span>` : ''}<button class="text-btn small" data-act="open-progress" data-key="${progKey(ex.id, entry.mode)}">📈 成長</button></div>
            <div class="ex-eval-stats">
              <span>${st.sets}セット</span>
              ${ex.timed ? '' : `<span>ボリューム ${fmtInt(st.volume)}kg</span>`}
              ${st.best ? `<span>ベスト ${fmtNum(st.best.load)}kg×${st.best.reps}回</span>` : ''}
              ${st.bestE1rm ? `<span>推定1RM ${fmtNum(st.bestE1rm)}kg</span>` : ''}
            </div>
            <ul class="notes">${notes.map(n => `<li class="note-${n.cls}">${esc(n.text)}</li>`).join('')}</ul>
          </div>`).join('')}
      </div>
      ${nextCard(week)}
      ${methodHtml()}
    </section>`;
}

// 目標との比較（直近7日間）: 達成率レーダー＋部位別の棒
function goalCard(week) {
  const range = target();
  const s = db.settings;
  const level = CONFIG.levels[s.level] || CONFIG.levels[CONFIG.defaultProfile.level];
  const groups = groupRows(week);
  return `<div class="card">
    <h3>目標との比較（直近7日間）</h3>
    <p class="muted small">${fmtShort(addDays(ui.date, -6))}〜${fmtShort(ui.date)} ・ ${esc(goalDef().label)} ／ ${esc(level.label)} ・ 目標 週${range.low}〜${range.high}セット/筋群
      <button class="text-btn small" data-act="go-settings">変更</button></p>
    ${radarChart(groups, range)}
    ${loadBars(groups, range, { className: 'groups', label: '直近7日間の筋群別換算セットと目標範囲' })}
  </div>`;
}

// 達成率 = 換算セット ÷ 目標下限。100%の円が目標下限、破線が目標上限
//   rows: [{ short, label, sets }]
function radarChart(rows, range) {
  const n = rows.length;
  const cx = 170, cy = 155, R = 100;
  const hi = range.high / range.low;
  const ratios = rows.map(g => g.sets / range.low);
  const P = rows.map(g => g.short);
  const scale = Math.min(3, Math.ceil(Math.max(hi, ...ratios) * 2) / 2);
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [cx + Math.cos(a) * R * r, cy + Math.sin(a) * R * r];
  };
  const ring = r => P.map((_, i) => pt(i, r / scale).map(v => v.toFixed(1)).join(',')).join(' ');
  const ringPath = r => 'M' + P.map((_, i) => pt(i, r / scale).map(v => v.toFixed(1)).join(',')).join('L') + 'Z';
  const data = ratios.map((v, i) => pt(i, Math.min(v, scale) / scale));
  return `<figure class="radar">
    <svg viewBox="0 0 340 310" role="img" aria-label="筋群別の目標達成率レーダーチャート">
      <path class="radar-band" d="${ringPath(hi)} ${ringPath(1)}" fill-rule="evenodd"/>
      ${[0.5, 1.5, 2, 2.5, 3].filter(r => r < scale + 1e-9 && Math.abs(r - hi) > 1e-9 && r !== 1).map(r => `<polygon class="radar-grid" points="${ring(r)}"/>`).join('')}
      ${P.map((_, i) => { const [x, y] = pt(i, 1); return `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join('')}
      <polygon class="radar-target" points="${ring(1)}"/>
      <polygon class="radar-high" points="${ring(hi)}"/>
      <polygon class="radar-data" points="${data.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}"/>
      ${data.map(([x, y], i) => `<circle class="radar-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${rows[i].label}: ${fmtNum(rows[i].sets)}セット（達成率${Math.round(ratios[i] * 100)}%）</title></circle>`).join('')}
      ${P.map((p, i) => {
        const [x, y] = pt(i, 1.2);
        const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end';
        const r = Calc.rate(rows[i].sets, range);
        return `<text class="radar-label" x="${x.toFixed(1)}" y="${(y - 2).toFixed(1)}" text-anchor="${anchor}">${esc(p)}</text>
          <text class="radar-pct rate-${r.key}" x="${x.toFixed(1)}" y="${(y + 12).toFixed(1)}" text-anchor="${anchor}">${Math.round(ratios[i] * 100)}%</text>`;
      }).join('')}
    </svg>
    <figcaption class="radar-legend muted">
      <span><i class="lg-data"></i>実績</span><span><i class="lg-target"></i>目標下限=100%</span><span><i class="lg-high"></i>目標上限 ${Math.round(hi * 100)}%</span>
    </figcaption>
  </figure>`;
}

// 部位ごとの最終実施日と回復状況（基準日 ui.date 時点）
function recoveryInfo() {
  const bw = bodyWeight();
  const { normalHours, heavyHours, heavySets } = CONFIG.recovery;
  const out = {};
  for (const p of CONFIG.parts) out[p] = { last: null };
  for (let i = 0; i <= 28; i++) {
    const k = addDays(ui.date, -i);
    const items = itemsOf(k);
    if (!items.length) continue;
    const parts = Calc.muscleLoad(items, bw).parts;
    for (const p of CONFIG.parts) {
      if (out[p].last || parts[p].sets < 1) continue;
      const need = parts[p].sets >= heavySets ? heavyHours : normalHours;
      const remainDays = Math.ceil((need - i * 24) / 24);
      out[p] = { last: k, days: i, sets: parts[p].sets, recovered: remainDays <= 0, remainDays };
    }
  }
  return out;
}

// 指定した筋肉を主対象にする種目（よく行う種目を優先）
function suggestExercises(muscle, n = 3) {
  const usage = {};
  for (const k of sortedDates()) for (const e of db.sessions[k].entries) usage[e.exId] = (usage[e.exId] || 0) + 1;
  const hits = (ex, mode) => (Calc.targets(ex, mode)[muscle] || 0) >= CONFIG.primaryFactor;
  return master
    .filter(ex => !ex.primary.includes('種目による'))
    .map(ex => {
      const modes = CONFIG.modes[ex.id];
      const mode = modes ? modes.findIndex((_, i) => hits(ex, i)) : 0;
      return mode >= 0 && hits(ex, mode) ? { ex, mode: modes ? mode : null, used: usage[ex.id] || 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.used - a.used)
    .slice(0, n);
}

function nextCard(week) {
  const range = target();
  const rec = recoveryInfo();
  const need = groupRows(week)
    .map(g => ({ g, remain: range.low - g.sets, rec: rec[g.part] }))
    .filter(x => x.remain >= 1)
    .sort((a, b) => (b.rec.recovered !== false) - (a.rec.recovered !== false) || b.remain - a.remain);
  const statusText = r => !r.last ? '<span class="muted">記録なし</span>'
    : r.recovered ? '<span class="rate-ok">● 回復済み</span>'
    : `<span class="rate-high">◐ 回復中（あと約${r.remainDays}日）</span>`;
  return `<div class="card">
    <h3>次のトレーニング</h3>
    ${need.length ? `<p class="muted small">直近7日間で目標下限（週${range.low}セット）に届いていない筋肉です。回復済みの部位から優先して表示しています。</p>
      <ul class="suggest">${need.slice(0, 3).map(({ g, remain, rec: r }) => `<li>
        <div class="suggest-head"><strong>${esc(g.label)}</strong> <span>あと約${Math.ceil(remain)}セット</span> ${statusText(r)}</div>
        <div class="chips wrap">${suggestExercises(g.muscles[0]).map(s => `<button class="chip" data-act="suggest-add" data-ex="${s.ex.id}" data-mode="${s.mode ?? ''}">＋ ${esc(s.ex.name)}${s.mode != null ? `（${esc(CONFIG.modes[s.ex.id][s.mode].label)}）` : ''}</button>`).join('')}</div>
      </li>`).join('')}</ul>
      <p class="muted small">種目をタップすると今日の記録に追加します。</p>`
    : '<p class="small">🎯 直近7日間で全筋群が目標下限に達しています。</p>'}
    <h4>回復状況（部位ごと）</h4>
    <table class="num-table recovery">
      <thead><tr><th>部位</th><th>前回</th><th>経過</th><th>状態</th></tr></thead>
      <tbody>${CONFIG.parts.map(p => { const r = rec[p]; return `<tr><td>${p}</td><td>${r.last ? fmtShort(r.last) : '—'}</td><td>${r.last ? (r.days ? `${r.days}日` : '当日') : '—'}</td><td>${statusText(r)}</td></tr>`; }).join('')}</tbody>
    </table>
    <p class="muted small">目安: 通常${CONFIG.recovery.normalHours}時間、1日に${CONFIG.recovery.heavySets}セット以上行った部位は${CONFIG.recovery.heavyHours}時間。</p>
  </div>`;
}

function methodHtml() {
  return `<details class="card method">
    <summary>計算方法</summary>
    <dl>
      <dt>ボリューム（負荷量）</dt>
      <dd>重量 × 回数 をセットごとに合計（Volume Load）。秒数で行う種目はボリュームに含めずセット数のみ数えます。</dd>
      <dt>部位への配分（換算セット数）</dt>
      <dd>主対象筋に ${CONFIG.primaryFactor * 100}%、副対象筋に原則 ${CONFIG.secondaryFactor * 100}% を配分（フラクショナルセット法）。日ごとの部位の値はその部位内で最も大きい配分を採用し、同じセットを二重に数えないようにしています。</dd>
      <dt>副対象筋の割合の根拠</dt>
      <dd>
        <b>50%</b>: 関節を動かして働く協働筋（プレスの上腕三頭筋・三角筋前部、ロウ・プルダウンの上腕二頭筋、スクワットの内転筋群など）。67研究のメタ回帰で間接セットを0.5と数える方法が最もデータに合った（Pelland ら 2025）。ロウの上腕二頭筋の成長はカールの約半分（Mannarino ら）。<br>
        <b>25%</b>: 主に姿勢保持・固定で働く筋（ロウの三角筋後部・脊柱起立筋、サイドレイズの僧帽筋、レッグカールのふくらはぎなど）。筋電図の関与はあるが肥大の直接的な根拠は乏しい。<br>
        <b>0%（除外）</b>: 肥大研究で成長がほぼ見られなかった筋。スクワット系・レッグプレスのハムストリングス（Kubo ら 2019、Plotkin ら 2023）、ヒップスラストのハムストリングス・中臀筋（Plotkin ら 2023）。<br>
        種目ごとの値はマスタCSVの副対象筋に「筋肉名(係数)」で記載しています（係数なし=50%）。
      </dd>
      <dt>目標との比較の単位</dt>
      <dd>週の目標セット数は筋肉ごとの研究値のため、${CONFIG.goalGroups.length}の筋群（${CONFIG.goalGroups.map(g => esc(g.label)).join('・')}）ごとに比較します。前腕・脊柱起立筋・内転筋群・中臀筋は週の目標の研究がほぼないため対象外です（日ごとの負荷には含みます）。</dd>
      <dt>評価の目安</dt>
      <dd>1回あたり部位ごとに ${CONFIG.sessionRange.low}〜${CONFIG.sessionRange.high} セット。7日間の目標は目的と経験から決めます（現在: 週${target().low}〜${target().high}セット）。</dd>
      <dt>目的ごとの週の目標（中級者）</dt>
      <dd>${Object.values(CONFIG.goals).map(g => `${esc(g.label)} ${g.weekly.low}〜${g.weekly.high}セット・${g.reps[0]}〜${g.reps[1]}回`).join('<br>')}<br>経験による補正: ${Object.values(CONFIG.levels).map(l => `${esc(l.label)} ×${l.factor}`).join('、')}</dd>
      <dt>達成率</dt>
      <dd>直近7日間の換算セット ÷ 目標下限。100%で下限に到達、上限を超えると「多め」。</dd>
      <dt>推定1RM</dt>
      <dd>Epley式: 重量 × (1 + 回数 ÷ 30)。15回を超えるセットは誤差が大きいため対象外。</dd>
      <dt>自重・アシスト種目</dt>
      <dd>体重 × 係数 ＋ 入力した重量 を負荷とします。係数は動作で実際に持ち上げる体の割合です（スクワット・ランジ0.88、カーフレイズ0.97、懸垂・ディップス0.95、腕立て伏せ0.69、インバーテッドロウ0.6 など）。アシスト種目は 体重×0.95 − アシスト重量。スクワットなど重りを持つ種目の推定1RMは、慣例どおり持った重量だけで計算します（ボリュームには体重分を含めます）。過去の日の計算にも、現在の体重設定を使います。</dd>
      <dt>注意</dt>
      <dd>マシンの表示重量はメーカーや機種でレバー比が異なるため、別機種・フリーウェイトとの重量比較は目安です。</dd>
    </dl>
  </details>`;
}

// ---------- 推移画面（部位別・日ごとの棒グラフ） ----------
const TREND_DAYS = [14, 30, 90];
const METRICS = {
  volume: { label: 'ボリューム', unit: 'kg', fmt: v => fmtInt(v) },
  sets: { label: '換算セット', unit: 'セット', fmt: v => fmtNum(v) },
};

// 軸の最大値を 1・2・2.5・5 × 10^n に切り上げる
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
}
const fmtAxis = (v, metric) => metric === 'sets' ? fmtNum(v) : v >= 10000 ? `${fmtNum(v / 10000)}万` : fmtInt(v);

function trendData() {
  const { days } = ui.trend;
  const bw = bodyWeight();
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(ui.date, i - days + 1);
    const items = itemsOf(date);
    const load = Calc.muscleLoad(items, bw);
    return { date, items, parts: load.parts };
  });
}

function trendChart(data, part, max, { compact = false, showAxis = true } = {}) {
  const { metric } = ui.trend;
  const n = data.length;
  const step = n <= 14 ? 2 : n <= 30 ? 7 : 14;
  const ticks = compact ? [max] : [max / 2, max];
  return `<div class="tchart ${compact ? 'compact' : ''} ${n > 30 ? 'dense' : ''}" style="--n:${n}">
    <div class="tplot">
      ${ticks.map(t => `<div class="tgrid" style="bottom:${(t / max) * 100}%"><span>${fmtAxis(t, metric)}</span></div>`).join('')}
      <div class="tbars">
        ${data.map(d => {
          const v = d.parts[part][metric];
          return `<button class="tcol" data-act="trend-bar" data-date="${d.date}" data-part="${part}"
            title="${fmtShort(d.date)} ${part}: ${METRICS[metric].fmt(v)}${METRICS[metric].unit}"
            aria-label="${fmtShort(d.date)} ${part} ${METRICS[metric].fmt(v)}${METRICS[metric].unit}">
            ${v > 0 ? `<span class="tbar ${d.date === ui.trend.tip?.date && part === ui.trend.tip?.part ? 'on' : ''}" style="height:${Math.max((v / max) * 100, 1.5)}%"></span>` : ''}
          </button>`;
        }).join('')}
      </div>
    </div>
    ${showAxis ? `<div class="txaxis">${data.map((d, i) => (n - 1 - i) % step === 0
      ? `<span style="left:${((i + 0.5) / n) * 100}%">${fmtShort(d.date)}</span>` : '').join('')}</div>` : ''}
  </div>`;
}

function trendTip(data) {
  const tip = ui.trend.tip;
  const d = tip && data.find(x => x.date === tip.date);
  if (!d) return '';
  const p = d.parts[tip.part];
  const exs = d.items.filter(({ ex, entry }) => Object.keys(Calc.targets(ex, entry.mode)).some(m => CONFIG.muscles[m] === tip.part));
  return `<div class="ttip" role="status">
    <div class="ttip-head"><strong>${fmtDate(d.date)} ・ ${tip.part}</strong><button class="icon-btn small" data-act="trend-tip-close" aria-label="閉じる">✕</button></div>
    <div>ボリューム <strong>${fmtInt(p.volume)}kg</strong> ・ 換算 <strong>${fmtNum(p.sets)}</strong>セット</div>
    ${exs.length ? `<div class="muted small">${exs.map(({ ex }) => esc(ex.name)).join('、')}</div>` : '<div class="muted small">この部位の記録なし</div>'}
    ${d.items.length ? `<button class="text-btn" data-act="open-date" data-date="${d.date}">この日の記録を開く ›</button>` : ''}
  </div>`;
}

function renderTrend() {
  if (ui.trend.view === 'exercise') { renderExerciseTrend(); return; }
  const { part, days, metric } = ui.trend;
  const data = trendData();
  const M = METRICS[metric];
  const total = p => data.reduce((a, d) => a + d.parts[p][metric], 0);
  const controls = `
    <div class="chips trend-parts">${['all', ...CONFIG.parts].map(p => `<button class="chip ${p === part ? 'on' : ''}" data-act="trend-part" data-part="${p}">${p === 'all' ? '全部位' : p}</button>`).join('')}</div>
    <div class="trend-opts">
      <div class="seg">${TREND_DAYS.map(n => `<button class="${n === days ? 'on' : ''}" data-act="trend-days" data-days="${n}">${n}日</button>`).join('')}</div>
      <div class="seg">${Object.entries(METRICS).map(([k, m]) => `<button class="${k === metric ? 'on' : ''}" data-act="trend-metric" data-metric="${k}">${m.label}</button>`).join('')}</div>
    </div>`;
  const range = `${fmtShort(data[0].date)}〜${fmtShort(data[data.length - 1].date)}`;
  let body;
  if (part === 'all') {
    const max = niceMax(Math.max(...CONFIG.parts.flatMap(p => data.map(d => d.parts[p][metric]))));
    body = `<div class="card">
      <h3>部位別の${M.label}（日ごと）</h3>
      <p class="muted small">${range} ・ 全部位で縦軸を共通にしています。部位名をタップで拡大</p>
      ${CONFIG.parts.map((p, i) => `<div class="multiple">
        <button class="multiple-head" data-act="trend-part" data-part="${p}"><span>${p}</span><span class="muted">合計 ${M.fmt(total(p))}${M.unit} ›</span></button>
        ${trendChart(data, p, max, { compact: true, showAxis: i === CONFIG.parts.length - 1 })}
      </div>`).join('')}
      ${trendTip(data)}
    </div>`;
  } else {
    const vals = data.map(d => d.parts[part][metric]);
    const active = vals.filter(v => v > 0);
    const peak = Math.max(0, ...vals);
    body = `<div class="stat-row">
        <div class="stat"><span class="stat-value">${M.fmt(total(part))}<small>${M.unit}</small></span><span class="stat-label">期間合計</span></div>
        <div class="stat"><span class="stat-value">${active.length}<small>日</small></span><span class="stat-label">実施日数</span></div>
        <div class="stat"><span class="stat-value">${active.length ? M.fmt(total(part) / active.length) : '—'}<small>${active.length ? M.unit : ''}</small></span><span class="stat-label">実施日の平均</span></div>
      </div>
      <div class="card">
        <h3>${part}の${M.label}（日ごと）</h3>
        <p class="muted small">${range}${peak ? ` ・ 最大 ${M.fmt(peak)}${M.unit}` : ''} ・ 棒をタップで詳細</p>
        ${trendChart(data, part, niceMax(peak))}
        ${trendTip(data)}
      </div>`;
  }
  const shownParts = part === 'all' ? CONFIG.parts : [part];
  const rows = data.filter(d => shownParts.some(p => d.parts[p][metric] > 0)).reverse();
  main.innerHTML = `<section>
    <div class="section-head"><h2>推移</h2><span class="muted">${fmtShort(ui.date)} まで</span></div>
    ${trendSwitch()}
    ${controls}
    ${body}
    ${weekHeatmap()}
    <details class="card">
      <summary>数値で見る（${M.unit}）</summary>
      ${rows.length ? `<div class="table-scroll"><table class="num-table">
        <thead><tr><th>日付</th>${shownParts.map(p => `<th>${p}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(d => `<tr><td>${fmtShort(d.date)}</td>${shownParts.map(p => `<td>${d.parts[p][metric] > 0 ? M.fmt(d.parts[p][metric]) : '—'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted small">この期間の記録はありません。</p>'}
    </details>
    <p class="muted small">ボリューム = 重量×回数 を主対象筋100%・副対象筋50%で部位に配分した値です（評価画面と同じ計算）。</p>
  </section>`;
}

// 週（月〜日）ごとの目標達成率ヒートマップ。直近8週、基準日の週は基準日までで集計
function weekHeatmap(weeks = 8) {
  const bw = bodyWeight(), range = target();
  const d = fromKey(ui.date);
  const monday = addDays(ui.date, -((d.getDay() + 6) % 7));
  const cols = Array.from({ length: weeks }, (_, i) => {
    const start = addDays(monday, (i - weeks + 1) * 7);
    const items = [];
    for (let j = 0; j < 7; j++) {
      const k = addDays(start, j);
      if (k > ui.date) break;
      items.push(...itemsOf(k));
    }
    return { start, current: i === weeks - 1, groups: groupRows(Calc.muscleLoad(items, bw)) };
  });
  const level = ratio => ratio <= 0 ? 0 : ratio < 0.5 ? 1 : ratio < 1 ? 2 : ratio <= range.high / range.low ? 3 : 4;
  return `<div class="card">
    <h3>週ごとの目標達成率</h3>
    <p class="muted small">各週（月〜日）の換算セット ÷ 目標下限（週${range.low}セット）。セルをタップでその週の評価を表示</p>
    <div class="table-scroll">
      <table class="heat">
        <thead><tr><th></th>${cols.map(c => `<th>${c.current ? '今週' : fmtShort(c.start)}</th>`).join('')}</tr></thead>
        <tbody>${cols[0].groups.map((g, gi) => `<tr><th title="${esc(g.label)}">${esc(g.short)}</th>${cols.map(c => {
          const v = c.groups[gi].sets, ratio = v / range.low, lv = level(ratio);
          return `<td class="lv${lv}"><button data-act="heat-week" data-date="${c.start}" title="${fmtShort(c.start)}週 ${esc(g.label)}: ${fmtNum(v)}セット（${Math.round(ratio * 100)}%）">${lv ? `${Math.round(ratio * 100)}${lv === 4 ? '▲' : ''}` : '·'}</button></td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="heat-legend small muted">
      <span><i class="lv1"></i>〜49%</span><span><i class="lv2"></i>50〜99%</span><span><i class="lv3"></i>目標範囲</span><span><i class="lv4"></i>▲上限超</span>
    </div>
    <p class="muted small">今週は${fmtShort(ui.date)}までの途中集計です。</p>
  </div>`;
}

// ---------- 推移: 種目ごとの成長グラフ ----------
const trendSwitch = () => `<div class="seg trend-switch">
  <button class="${ui.trend.view === 'parts' ? 'on' : ''}" data-act="trend-view" data-view="parts">部位別</button>
  <button class="${ui.trend.view === 'exercise' ? 'on' : ''}" data-act="trend-view" data-view="exercise">種目別</button>
</div>`;

// 種目の識別子（複数動作マシンは動作ごとに分ける）
const progKey = (exId, mode) => `${exId}|${mode ?? ''}`;
const parseProgKey = key => { const [exId, m] = key.split('|'); return { exId, mode: m === '' ? null : Number(m) }; };
const progLabel = (ex, mode) => ex.name + (CONFIG.modes[ex.id] ? `（${CONFIG.modes[ex.id][mode ?? 0].label}）` : '');

// 記録のある種目（最近行った順）
function recordedExercises() {
  const map = new Map();
  for (const date of sortedDates()) {
    for (const e of db.sessions[date].entries) {
      const ex = exById.get(e.exId);
      if (!ex || !e.sets.some(Calc.isDone)) continue;
      const key = progKey(e.exId, CONFIG.modes[e.exId] ? (e.mode ?? 0) : null);
      const cur = map.get(key) || { key, ex, mode: e.mode, count: 0, last: date };
      cur.count++; cur.last = date;
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : b.count - a.count));
}

// 1日1点の履歴。同じ日に同じ種目が複数あればセットをまとめる
function exerciseHistory(key) {
  const { exId, mode } = parseProgKey(key);
  const ex = exById.get(exId);
  const bw = bodyWeight();
  const out = [];
  for (const date of sortedDates()) {
    const sets = db.sessions[date].entries
      .filter(e => e.exId === exId && (CONFIG.modes[exId] ? (e.mode ?? 0) === (mode ?? 0) : true))
      .flatMap(e => e.sets).filter(Calc.isDone);
    if (!sets.length) continue;
    const st = Calc.entryStats(ex, { sets }, bw);
    out.push({
      date, sets,
      e1rm: st.bestE1rm,
      weight: Math.max(...sets.map(s => Calc.oneRmLoad(ex, s, bw))),
      volume: st.volume,
      reps: Math.max(...sets.map(s => Number(s.r))),
    });
  }
  return { ex, mode, points: out };
}

const PROG_METRICS = {
  e1rm: { label: '推定1RM', unit: 'kg', fmt: v => fmtNum(v) },
  weight: { label: '最高重量', unit: 'kg', fmt: v => fmtNum(v) },
  volume: { label: 'ボリューム', unit: 'kg', fmt: v => fmtInt(v) },
  reps: { label: '最多回数', unit: '回', fmt: v => fmtInt(v) },
};
const PROG_RANGES = [[90, '3か月'], [180, '半年'], [365, '1年'], [0, '全期間']];

function progressChart(points, metric, unit) {
  const W = 340, H = 190, L = 44, R = 14, T = 16, B = 26;
  const t = d => fromKey(d).getTime();
  const t0 = t(points[0].date), t1 = t(points[points.length - 1].date);
  const vals = points.map(p => p[metric]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { lo -= Math.max(1, lo * 0.05); hi += Math.max(1, hi * 0.05); }
  const step = niceMax((hi - lo) / 3);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = d => (t1 === t0 ? (L + W - R) / 2 : L + ((t(d) - t0) / (t1 - t0)) * (W - L - R));
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = []; for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  const best = vals.indexOf(Math.max(...vals));
  const xLabels = points.length === 1 ? [0] : [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const unitFmt = v => (metric === 'volume' ? fmtAxis(v, 'volume') : fmtNum(v));
  return `<svg class="prog-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(PROG_METRICS[metric].label)}の推移">
    ${ticks.map(v => `<line class="prog-grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="prog-ylabel" x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${unitFmt(v)}</text>`).join('')}
    ${xLabels.map(i => `<text class="prog-xlabel" x="${x(points[i].date).toFixed(1)}" y="${H - 6}" text-anchor="${points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${fmtShort(points[i].date)}</text>`).join('')}
    ${points.length > 1 ? `<polyline class="prog-line" points="${points.map(p => `${x(p.date).toFixed(1)},${y(p[metric]).toFixed(1)}`).join(' ')}"/>` : ''}
    ${points.map((p, i) => `<g>
      <circle class="prog-dot ${i === best ? 'best' : ''} ${ui.prog.tip === p.date ? 'on' : ''}" cx="${x(p.date).toFixed(1)}" cy="${y(p[metric]).toFixed(1)}" r="${i === best ? 5 : 4}"/>
      <circle class="prog-hit" data-act="prog-point" data-date="${p.date}" cx="${x(p.date).toFixed(1)}" cy="${y(p[metric]).toFixed(1)}" r="13"><title>${fmtShort(p.date)} ${PROG_METRICS[metric].fmt(p[metric])}${unit}</title></circle>
    </g>`).join('')}
    <text class="prog-best" x="${Math.min(Math.max(x(points[best].date), L + 20), W - R - 20).toFixed(1)}" y="${Math.max(y(vals[best]) - 10, 11).toFixed(1)}" text-anchor="middle">最高 ${PROG_METRICS[metric].fmt(vals[best])}</text>
  </svg>`;
}

function renderExerciseTrend() {
  const list = recordedExercises();
  const head = `<div class="section-head"><h2>推移</h2><span class="muted">${fmtShort(ui.date)} まで</span></div>${trendSwitch()}`;
  if (!list.length) {
    main.innerHTML = `<section>${head}<p class="empty">まだ記録がありません。</p></section>`;
    return;
  }
  if (!ui.prog.key || !list.some(r => r.key === ui.prog.key)) ui.prog.key = list[0].key;
  const { ex, points: all } = exerciseHistory(ui.prog.key);
  const from = ui.prog.range ? addDays(ui.date, -ui.prog.range + 1) : '0000';
  const points = all.filter(p => p.date >= from && p.date <= ui.date);
  const avail = Object.keys(PROG_METRICS).filter(m =>
    m === 'reps' || (m === 'volume' ? !ex.timed : all.some(p => p[m] > 0)));
  if (!avail.includes(ui.prog.metric)) ui.prog.metric = avail[0];
  const metric = ui.prog.metric;
  const M = PROG_METRICS[metric];
  const unit = metric === 'reps' && ex.timed ? '秒' : M.unit;
  const label = metric === 'reps' && ex.timed ? '最長秒数' : M.label;
  const shown = points.filter(p => p[metric] != null && (metric === 'reps' || p[metric] > 0));

  let body;
  if (!shown.length) {
    body = `<p class="empty">この期間の記録はありません。</p>`;
  } else {
    const first = shown[0][metric], last = shown[shown.length - 1][metric];
    const bestP = shown.reduce((a, p) => (p[metric] > a[metric] ? p : a));
    const diff = last - first, pct = first ? (diff / first) * 100 : 0;
    const tip = shown.find(p => p.date === ui.prog.tip);
    body = `<div class="stat-row">
        <div class="stat"><span class="stat-value">${M.fmt(last)}<small>${unit}</small></span><span class="stat-label">最新（${fmtShort(shown[shown.length - 1].date)}）</span></div>
        <div class="stat"><span class="stat-value">${M.fmt(bestP[metric])}<small>${unit}</small></span><span class="stat-label">最高（${fmtShort(bestP.date)}）</span></div>
        <div class="stat"><span class="stat-value ${diff > 0 ? 'rate-ok' : diff < 0 ? 'rate-high' : ''}">${shown.length > 1 ? `${diff >= 0 ? '+' : ''}${M.fmt(diff)}` : '—'}<small>${shown.length > 1 ? unit : ''}</small></span><span class="stat-label">${shown.length > 1 ? `期間の変化 ${pct >= 0 ? '+' : ''}${fmtNum(pct, 0)}%` : '期間の変化'}</span></div>
      </div>
      <div class="card">
        <h3>${esc(label)}の推移</h3>
        <p class="muted small">${shown.length}回分の記録 ・ 点をタップで詳細</p>
        ${progressChart(shown, metric, unit)}
        ${tip ? `<div class="ttip">
          <div class="ttip-head"><strong>${fmtDate(tip.date)}</strong><button class="icon-btn small" data-act="prog-tip-close" aria-label="閉じる">✕</button></div>
          <div>${esc(label)} <strong>${M.fmt(tip[metric])}${unit}</strong></div>
          <div class="muted small">${tip.sets.map(s => esc(setText(ex, s))).join(' / ')}</div>
          <button class="text-btn" data-act="open-date" data-date="${tip.date}">この日の記録を開く ›</button>
        </div>` : ''}
      </div>
      <details class="card">
        <summary>数値で見る</summary>
        <div class="table-scroll"><table class="num-table">
          <thead><tr><th>日付</th>${avail.map(m => `<th>${m === 'reps' && ex.timed ? '最長秒数' : PROG_METRICS[m].label}</th>`).join('')}</tr></thead>
          <tbody>${[...points].reverse().map(p => `<tr><td>${fmtShort(p.date)}</td>${avail.map(m => `<td>${p[m] != null && (m === 'reps' || p[m] > 0) ? PROG_METRICS[m].fmt(p[m]) : '—'}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </details>`;
  }

  main.innerHTML = `<section>
    ${head}
    <label class="field prog-select">種目<select data-act="prog-ex">
      ${list.map(r => `<option value="${r.key}" ${r.key === ui.prog.key ? 'selected' : ''}>${esc(progLabel(r.ex, r.mode))}（${r.count}回）</option>`).join('')}
    </select></label>
    <div class="trend-opts">
      <div class="seg">${PROG_RANGES.map(([d, l]) => `<button class="${d === ui.prog.range ? 'on' : ''}" data-act="prog-range" data-days="${d}">${l}</button>`).join('')}</div>
    </div>
    <div class="chips wrap prog-metrics">${avail.map(m => `<button class="chip ${m === metric ? 'on' : ''}" data-act="prog-metric" data-metric="${m}">${m === 'reps' && ex.timed ? '最長秒数' : PROG_METRICS[m].label}</button>`).join('')}</div>
    ${body}
    <p class="muted small">推定1RMは Epley 式（15回以下のセットのみ）。重りを持つ種目は持った重量、自重種目は体重分を含めた値です。</p>
  </section>`;
}

function setProg(patch) {
  Object.assign(ui.prog, patch);
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function setTrend(patch) {
  Object.assign(ui.trend, patch);
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

// ---------- 履歴画面 ----------
// ---------- カレンダー ----------
const PART_SHORT = { '胸': '胸', '背中': '背', '肩': '肩', '腕': '腕', '脚': '脚', '臀部': '尻', '体幹': '腹' };
const monthKey = k => k.slice(0, 7);
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

// その日の主な部位（換算1セット以上、多い順）と合計セット数
function dayInfo(k) {
  const items = itemsOf(k);
  if (!items.length) return null;
  const load = Calc.muscleLoad(items, bodyWeight());
  const parts = CONFIG.parts.filter(p => load.parts[p].sets >= 1).sort((a, b) => load.parts[b].sets - load.parts[a].sets);
  const sets = items.reduce((a, { entry }) => a + entry.sets.filter(Calc.isDone).length, 0);
  return { items, load, parts, sets };
}

function calendarCard() {
  const month = ui.cal.month;
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<div class="cal-cell empty"></div>');
  const trained = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const k = `${month}-${pad(d)}`;
    const info = dayInfo(k);
    if (info) trained.push({ k, info });
    const lv = !info ? 0 : info.sets >= 20 ? 3 : info.sets >= 10 ? 2 : 1;
    const shown = info ? info.parts.slice(0, 2).map(p => PART_SHORT[p]).join('') + (info.parts.length > 2 ? '+' : '') : '';
    const wd = new Date(y, m - 1, d).getDay();
    cells.push(`<button class="cal-cell lv${lv} ${k === todayKey() ? 'today' : ''} ${k === ui.cal.sel ? 'sel' : ''} ${wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}"
      data-act="cal-day" data-date="${k}" aria-label="${m}月${d}日${info ? ` ${info.parts.join('・')} ${info.sets}セット` : ''}">
      <span class="cal-num">${d}</span>${shown ? `<span class="cal-parts">${shown}</span>` : ''}</button>`);
  }
  // 月の集計
  const totalSets = trained.reduce((a, t) => a + t.info.sets, 0);
  const isCurrent = month === monthKey(todayKey());
  const elapsedDays = isCurrent ? new Date().getDate() : daysInMonth;
  const perWeek = trained.length / (Math.max(elapsedDays, 7) / 7); // 月初の数日で極端な値にならないよう最低1週間で割る
  const prevCount = sortedDates().filter(k => monthKey(k) === addMonths(month, -1)).length;
  // 選択した日の内容
  const sel = ui.cal.sel && monthKey(ui.cal.sel) === month ? ui.cal.sel : null;
  const selInfo = sel && dayInfo(sel);
  return `<div class="card calendar">
    <div class="cal-head">
      <button class="icon-btn" data-act="cal-month" data-n="-1" aria-label="前の月">‹</button>
      <strong>${y}年${m}月</strong>
      <button class="icon-btn" data-act="cal-month" data-n="1" aria-label="次の月">›</button>
      ${isCurrent ? '' : '<button class="today-btn" data-act="cal-month" data-n="0">今月</button>'}
    </div>
    <div class="cal-grid">
      ${['日', '月', '火', '水', '木', '金', '土'].map((w, i) => `<div class="cal-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
      ${cells.join('')}
    </div>
    <div class="cal-legend muted small">
      <span><i class="lv1"></i>〜9セット</span><span><i class="lv2"></i>10〜19</span><span><i class="lv3"></i>20〜</span>
      <span>胸 背 肩 腕 脚 尻 腹 = 主な部位</span>
    </div>
    <div class="stat-row cal-stats">
      <div class="stat"><span class="stat-value">${trained.length}<small>日</small></span><span class="stat-label">トレーニング日${prevCount ? `（前月 ${prevCount}日）` : ''}</span></div>
      <div class="stat"><span class="stat-value">${fmtNum(perWeek)}<small>回</small></span><span class="stat-label">週あたり${isCurrent ? '（今日まで）' : ''}</span></div>
      <div class="stat"><span class="stat-value">${fmtInt(totalSets)}</span><span class="stat-label">合計セット</span></div>
    </div>
    ${sel ? `<div class="ttip cal-detail">
      <div class="ttip-head"><strong>${fmtDate(sel)}</strong><button class="icon-btn small" data-act="cal-close" aria-label="閉じる">✕</button></div>
      ${selInfo ? `<div class="history-parts">${selInfo.parts.map(p => `<span class="badge">${p} ${fmtNum(selInfo.load.parts[p].sets)}</span>`).join('')}</div>
        <div class="small">${selInfo.items.map(({ ex }) => esc(ex.name)).join('、')}（${selInfo.sets}セット）</div>` : '<div class="muted small">記録はありません</div>'}
      <button class="text-btn" data-act="open-date" data-date="${sel}">${selInfo ? 'この日の記録を開く ›' : 'この日に記録する ›'}</button>
    </div>` : ''}
  </div>`;
}

function renderHistory() {
  const bw = bodyWeight();
  if (!ui.cal.month) ui.cal.month = monthKey(ui.date);
  const dates = sortedDates().reverse().filter(k => monthKey(k) === ui.cal.month);
  main.innerHTML = `<section>
    <div class="section-head"><h2>履歴</h2><span class="muted">全${sortedDates().length}日</span></div>
    ${calendarCard()}
    <h3 class="list-head">${Number(ui.cal.month.slice(5))}月の記録</h3>
    ${dates.length ? dates.map(k => {
      const items = itemsOf(k);
      const load = Calc.muscleLoad(items, bw);
      const top = CONFIG.parts.filter(p => load.parts[p].sets >= 1).sort((a, b) => load.parts[b].sets - load.parts[a].sets);
      const vol = items.reduce((a, { ex, entry }) => a + Calc.entryStats(ex, entry, bw).volume, 0);
      return `<button class="card history-item ${k === ui.date ? 'current' : ''}" data-act="open-date" data-date="${k}">
        <div class="history-head"><strong>${fmtDate(k)}</strong><span class="muted">${daySummaryText(k)} ・ ${fmtInt(vol)}kg</span></div>
        <div class="history-parts">${top.map(p => `<span class="badge">${p} ${fmtNum(load.parts[p].sets)}</span>`).join('')}</div>
        <div class="history-ex muted">${items.map(({ ex }) => esc(ex.name)).join('、')}</div>
      </button>`;
    }).join('') : '<p class="empty">この月の記録はありません。</p>'}
  </section>`;
}

function setCal(patch) {
  Object.assign(ui.cal, patch);
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

// ---------- 設定画面 ----------
function bmiText() {
  const h = Number(db.settings.height) / 100, w = bodyWeight();
  if (!(h > 0)) return '身長を入れると BMI を表示します';
  const bmi = w / (h * h);
  const cat = bmi < 18.5 ? '低体重' : bmi < 25 ? '普通体重' : bmi < 30 ? '肥満（1度）' : '肥満（2度以上）';
  return `BMI ${fmtNum(bmi)}（${cat}・日本肥満学会の基準）`;
}

function renderSettings() {
  const s = db.settings, g = goalDef(), range = target(), dev = RestTimer.device();
  const opts = (defs, cur) => Object.entries(defs).map(([k, d]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  main.innerHTML = `<section>
    <div class="section-head"><h2>設定</h2></div>
    <div class="card profile">
      <h3>プロフィール</h3>
      <label class="field">目的<select data-setting="goal">${opts(CONFIG.goals, s.goal)}</select></label>
      <p class="muted small">${esc(g.note)}</p>
      <label class="field">トレーニング経験<select data-setting="level">${opts(CONFIG.levels, s.level)}</select></label>
      <label class="field">身長（cm）<input data-setting="height" type="number" inputmode="decimal" min="100" max="250" step="0.1" value="${esc(s.height)}"></label>
      <label class="field">体重（kg）<input data-setting="bodyWeight" type="number" inputmode="decimal" min="20" max="300" step="0.1" value="${esc(s.bodyWeight)}"></label>
      <p class="muted small">${bmiText()}。体重は自重種目・アシスト種目の負荷計算にも使います。</p>
      <div class="field checks">目標に含める
        <span>${CONFIG.goalGroups.filter(g => g.optional).map(g => `<label class="check"><input type="checkbox" data-setting="${g.optional}" ${s[g.optional] !== false ? 'checked' : ''}> ${esc(g.short)}</label>`).join('')}</span>
      </div>
      <p class="muted small">鍛えない筋肉は外すと、レーダーや「次のトレーニング」の提案に出なくなります。</p>
      <div class="target-box">
        <div>あなたの目標</div>
        <strong>筋群ごとに 週${range.low}〜${range.high}セット</strong>
        <div class="small">推奨回数 ${g.reps[0]}〜${g.reps[1]}回 ・ 評価画面のレーダーと次のトレーニング提案に使います</div>
      </div>
    </div>
    <div class="card">
      <h3>レストタイマー</h3>
      <label class="field">この端末で使う<select data-device="timer">
        <option value="auto" ${dev.timer === 'auto' ? 'selected' : ''}>スマホ・タブレットのみ</option>
        <option value="on" ${dev.timer === 'on' ? 'selected' : ''}>使う</option>
        <option value="off" ${dev.timer === 'off' ? 'selected' : ''}>使わない</option>
      </select></label>
      <p class="muted small">この端末では${RestTimer.enabled() ? '<b>使います</b>' : '<b>使いません</b>'}（${RestTimer.isTouchDevice() ? 'タッチ操作の端末' : 'PC'}と判定）。この設定は端末ごとで、同期されません。</p>
      ${RestTimer.enabled() ? `
      <label class="field">レスト時間<select data-setting="restMode">
        <option value="auto" ${(s.restMode || 'auto') === 'auto' ? 'selected' : ''}>目的に合わせる</option>
        ${CONFIG.restPresets.map(sec => `<option value="${sec}" ${String(s.restMode) === String(sec) ? 'selected' : ''}>${RestTimer.fmt(sec)} 固定</option>`).join('')}
      </select></label>
      <p class="muted small">${(s.restMode || 'auto') === 'auto'
        ? `${esc(goalDef().label)}: 複数関節の種目 ${RestTimer.fmt((CONFIG.rest[s.goal] || CONFIG.rest.bulk).compound)}、単関節の種目 ${RestTimer.fmt((CONFIG.rest[s.goal] || CONFIG.rest.bulk).isolation)}`
        : 'すべての種目で同じ時間を使います'}</p>
      <label class="field">回数を入れたら自動で開始<input type="checkbox" data-setting="restAuto" ${s.restAuto !== false ? 'checked' : ''}></label>
      <label class="field">終了時に音を鳴らす<input type="checkbox" data-setting="restSound" ${s.restSound !== false ? 'checked' : ''}></label>
      <label class="field">終了の合図の回数<select data-setting="restRepeat">${[1, 3, 5].map(n => `<option value="${n}" ${Number(s.restRepeat ?? 3) === n ? 'selected' : ''}>${n}回</option>`).join('')}</select></label>
      ${RestTimer.audioSessionSupported ? `
      <label class="field">消音モードでも鳴らす<input type="checkbox" data-device="ignoreSilent" ${dev.ignoreSilent ? 'checked' : ''}></label>
      <p class="muted small">iPhone の消音モード中も音を鳴らします。鳴るたびに再生中の音楽が止まることがあります（この端末だけの設定）。</p>` : ''}
      <button class="secondary-btn" data-act="rest-test">🔔 音を試す</button>
      <p class="muted small">今日の記録で回数を入力し終えると開始します（各種目の ⏱ ボタンでも開始できます）。計測中は画面が消えないようにします。画面ロック中やほかのアプリを表示している間は鳴りません。iPhone は振動に対応していません。</p>` : ''}
    </div>
    <div class="card" id="syncCard">${syncCardHtml()}</div>
    <div class="card">
      <h3>データのバックアップ</h3>
      <p class="muted small">記録はこの端末のブラウザ内に保存されています。機種変更やブラウザのデータ削除に備えて書き出しておいてください。</p>
      <div class="btn-row">
        <button class="secondary-btn" data-act="export">書き出し（JSON）</button>
        <button class="secondary-btn" data-act="import">読み込み</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
    </div>
    ${methodHtml()}
    <div class="card">
      <p class="muted small">種目マスタ: ${master.length}種目（${esc(CONFIG.masterUrl)}）</p>
      <button class="text-btn danger" data-act="clear-all">すべての記録を削除</button>
    </div>
  </section>`;
}

// ---------- クラウド同期の表示 ----------
const SYNC_TEXT = {
  local: '端末内のみ',
  signedOut: '未ログイン',
  syncing: '同期中…',
  synced: '同期済み',
  offline: 'オフライン',
  error: '同期エラー',
};
const fmtTime = iso => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function syncCardHtml() {
  const s = Sync.getState();
  if (!s.configured) {
    return `<h3>クラウド同期</h3>
      <p class="small">未設定です。記録はこのブラウザ内だけに保存されています。</p>
      <p class="muted small">Supabase のプロジェクトを作成し、<code>js/supabase-config.js</code> に接続情報を入れると、ログインして複数の端末で同じ記録を使えます（手順は README）。</p>`;
  }
  if (!s.email) {
    return `<h3>クラウド同期</h3>
      <p class="muted small">ログインすると記録がクラウドに保存され、どの端末からでも同じ記録を使えます。この端末にある記録は、ログイン時にアカウントへ取り込まれます。</p>
      <form class="login-form" onsubmit="return false">
        <label class="field">メール<input id="loginEmail" type="email" autocomplete="username" inputmode="email"></label>
        <label class="field">パスワード<input id="loginPassword" type="password" autocomplete="current-password"></label>
        <button class="primary-btn block" data-act="sync-login">ログイン</button>
        ${s.message ? `<p class="small error">${esc(s.message)}</p>` : ''}
      </form>`;
  }
  return `<h3>クラウド同期</h3>
    <p class="small">${esc(s.email)} でログイン中</p>
    <p class="small"><span class="sync-dot ${s.phase}"></span>${SYNC_TEXT[s.phase]}${s.pending ? `（未送信 ${s.pending}件）` : ''}${s.lastSync ? ` ・ 最終同期 ${fmtTime(s.lastSync)}` : ''}</p>
    ${s.phase === 'error' && s.message ? `<p class="small error">${esc(s.message)}</p>` : ''}
    <div class="btn-row">
      <button class="secondary-btn" data-act="sync-now">今すぐ同期</button>
      <button class="text-btn danger" data-act="sync-logout">ログアウト</button>
    </div>`;
}

function renderSyncState(s) {
  const chip = $('#syncChip');
  chip.hidden = !s.configured;
  chip.className = `sync-chip ${s.phase}`;
  chip.innerHTML = `☁<span class="sync-label"> ${s.phase === 'synced' && s.pending ? '未送信' : SYNC_TEXT[s.phase]}</span>`;
  chip.title = s.email ? `${s.email} ・ ${SYNC_TEXT[s.phase]}` : SYNC_TEXT[s.phase];
  const card = $('#syncCard');
  // 入力中のログインフォームは描き直さない
  if (card && !card.contains(document.activeElement)) card.innerHTML = syncCardHtml();
}

async function syncLogin() {
  const email = $('#loginEmail').value.trim(), password = $('#loginPassword').value;
  if (!email || !password) return;
  const btn = $('[data-act="sync-login"]');
  btn.disabled = true; btn.textContent = 'ログイン中…';
  try {
    await Sync.signIn(email, password);
    $('#loginPassword').value = '';
    document.activeElement?.blur();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'ログイン';
    const msg = /invalid login credentials/i.test(e.message) ? 'メールアドレスまたはパスワードが違います' : e.message;
    $('#syncCard .error')?.remove();
    btn.insertAdjacentHTML('afterend', `<p class="small error">${esc(msg)}</p>`);
  }
}

async function syncLogout() {
  const s = Sync.getState();
  const warn = s.pending ? `\n未送信の変更が${s.pending}件あります。ログアウトすると失われます。` : '';
  if (!confirm(`ログアウトします。この端末の記録は消え、クラウドの記録は残ります。${warn}`)) return;
  await Sync.signOut();
  db = { settings: normalizeSettings(), sessions: {} };
  saveLocal();
  render();
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...db }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `workout-log-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!d || typeof d.sessions !== 'object') throw new Error('形式が違います');
      const n = Object.keys(d.sessions).length;
      if (!confirm(`${n}日分の記録を読み込みます。現在の記録は置き換えられます。よろしいですか？`)) return;
      db = { settings: normalizeSettings(d.settings), sessions: d.sessions };
      saveDb(); render();
    } catch (e) { alert('読み込みに失敗しました: ' + e.message); }
  };
  reader.readAsText(file);
}

// ---------- 起動 ----------
RestTimer.init({
  sound: () => db.settings.restSound !== false,
  ignoreSilent: () => RestTimer.device().ignoreSilent,
  repeat: () => db.settings.restRepeat ?? 3,
});
if (!RestTimer.enabled()) RestTimer.stop();
document.querySelector('.bottom-nav').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});
$('#prevDay').addEventListener('click', () => setDate(addDays(ui.date, -1)));
$('#nextDay').addEventListener('click', () => setDate(addDays(ui.date, 1)));
$('#todayBtn').addEventListener('click', () => setDate(todayKey()));
$('#dateInput').addEventListener('change', e => { if (e.target.value) setDate(e.target.value); });

(async function init() {
  try {
    const res = await fetch(encodeURI(CONFIG.masterUrl), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    master = buildMaster(await res.text());
    master.forEach(e => exById.set(e.id, e));
    const unknown = new Set();
    master.forEach(e => [...e.primary, ...e.secondary].forEach(n => { if (!Calc.expand(n).length && !CONFIG.modes[e.id]) unknown.add(`${e.id}:${n}`); }));
    if (unknown.size) console.warn('集計対象に対応付けられていない筋肉名:', [...unknown]);
    render();
    Sync.init({
      getDb: () => db,
      applyDb: (next, changed) => {
        db = next;
        saveLocal();
        // 入力中は描き直さない（フォーカスが外れるため）。次の操作で反映される
        if (changed && !document.activeElement?.matches('input, select, textarea')) render();
      },
      onState: renderSyncState,
    });
  } catch (e) {
    main.innerHTML = `<div class="card"><h3>種目マスタを読み込めませんでした</h3>
      <p class="small">${esc(e.message)}</p>
      <p class="small">index.html をファイルとして直接開くとブラウザの制限で読み込めません。README の手順でローカルサーバーから開いてください。</p></div>`;
  }
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker 登録失敗', err));
  }
})();
