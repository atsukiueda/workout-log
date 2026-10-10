// Supabase とのクラウド同期
//   ブラウザ内（localStorage）を手元のキャッシュとして使い、変更があった日だけをクラウドへ送る。
//   「最後にクラウドと一致していた内容」を日ごとに記録しておき、それと違う日を未送信として扱う。
//   オフライン中の変更は残しておき、オンラインに戻ったときに送る。
'use strict';

const Sync = (() => {
  const SNAP_KEY = 'workout-log.synced.v1';
  const SETTINGS = '__settings';
  const cfg = window.SUPABASE_CONFIG || {};
  const configured = Boolean(cfg.url && cfg.anonKey && window.supabase?.createClient);

  let client = null;
  let user = null;
  let hooks = null;          // { getDb, applyDb, onState }
  let snap = loadSnap();     // { userId, items: { 'YYYY-MM-DD' | '__settings': JSON文字列 } }
  let state = { phase: configured ? 'signedOut' : 'local', message: '', lastSync: snap.lastSync || null };
  let timer = null;
  let running = null;

  function loadSnap() {
    try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || { userId: null, items: {} }; }
    catch { return { userId: null, items: {} }; }
  }
  function saveSnap() {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch { /* 容量不足時は次回全件比較になるだけ */ }
  }
  function setState(patch) {
    state = { ...state, ...patch };
    hooks?.onState(getState());
  }

  const sessionJson = (db, date) => {
    const s = db.sessions[date];
    return s && s.entries.length ? JSON.stringify(s.entries) : null;
  };
  // 有効な値は「設定」と「記録のある日」。クラウドと最後に一致した内容と違うものが未送信
  function dirtyKeys(db) {
    const keys = new Set([...Object.keys(db.sessions), ...Object.keys(snap.items).filter(k => k !== SETTINGS)]);
    const dirty = [...keys].filter(k => sessionJson(db, k) !== (snap.items[k] ?? null));
    if (JSON.stringify(db.settings) !== snap.items[SETTINGS]) dirty.push(SETTINGS);
    return dirty;
  }

  function getState() {
    const db = hooks?.getDb();
    return {
      configured,
      email: user?.email || '',
      pending: user && db ? dirtyKeys(db).length : 0,
      ...state,
    };
  }

  async function fetchAllSessions() {
    const rows = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await client.from('workout_sessions')
        .select('date, entries').order('date').range(from, from + page - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < page) return rows;
    }
  }

  // クラウドの内容を取り込み（未送信の日は手元を優先）、その後に未送信分を送る
  async function syncOnce() {
    const db = hooks.getDb();
    const dirty = new Set(dirtyKeys(db));

    const remote = await fetchAllSessions();
    const remoteDates = new Set();
    let changed = false;
    for (const row of remote) {
      remoteDates.add(row.date);
      if (dirty.has(row.date)) continue;
      if (sessionJson(db, row.date) !== JSON.stringify(row.entries)) changed = true;
      db.sessions[row.date] = { entries: row.entries };
      snap.items[row.date] = JSON.stringify(row.entries);
    }
    // 別の端末で削除された日
    for (const date of Object.keys(snap.items)) {
      if (date !== SETTINGS && !remoteDates.has(date) && !dirty.has(date)) {
        if (db.sessions[date]) changed = true;
        delete db.sessions[date];
        delete snap.items[date];
      }
    }
    const { data: st, error: stErr } = await client.from('user_settings').select('settings').maybeSingle();
    if (stErr) throw stErr;
    // 初回同期ではクラウドの設定を優先（新しい端末の初期値で上書きしないため）
    const firstSync = !(SETTINGS in snap.items);
    if (st && (firstSync || !dirty.has(SETTINGS))) {
      const merged = { ...db.settings, ...st.settings };
      if (JSON.stringify(merged) !== JSON.stringify(db.settings)) changed = true;
      db.settings = merged;
      snap.items[SETTINGS] = JSON.stringify(db.settings);
    }
    hooks.applyDb(db, changed);

    // 送信
    const now = new Date().toISOString();
    const pending = dirtyKeys(db);
    const upserts = pending.filter(k => k !== SETTINGS && sessionJson(db, k) !== null)
      .map(date => ({ user_id: user.id, date, entries: db.sessions[date].entries, updated_at: now }));
    const deletes = pending.filter(k => k !== SETTINGS && sessionJson(db, k) === null);
    if (upserts.length) {
      const { error } = await client.from('workout_sessions').upsert(upserts, { onConflict: 'user_id,date' });
      if (error) throw error;
      upserts.forEach(u => { snap.items[u.date] = JSON.stringify(u.entries); });
    }
    if (deletes.length) {
      const { error } = await client.from('workout_sessions').delete().eq('user_id', user.id).in('date', deletes);
      if (error) throw error;
      deletes.forEach(d => { delete snap.items[d]; });
    }
    if (pending.includes(SETTINGS)) {
      const { error } = await client.from('user_settings')
        .upsert({ user_id: user.id, settings: db.settings, updated_at: now }, { onConflict: 'user_id' });
      if (error) throw error;
      snap.items[SETTINGS] = JSON.stringify(db.settings);
    }
    snap.lastSync = now;
    saveSnap();
  }

  async function syncNow() {
    if (!client || !user) return;
    if (running) return running;
    if (!navigator.onLine) { setState({ phase: 'offline', message: '' }); return; }
    setState({ phase: 'syncing', message: '' });
    running = syncOnce()
      .then(() => {
        setState({ phase: 'synced', message: '', lastSync: snap.lastSync });
        // 同期中に入力された分を続けて送る
        if (dirtyKeys(hooks.getDb()).length) schedule();
      })
      .catch(err => {
        console.warn('同期に失敗しました', err);
        setState({ phase: navigator.onLine ? 'error' : 'offline', message: err?.message || String(err) });
      })
      .finally(() => { running = null; });
    return running;
  }

  // 手元の保存のたびに呼ぶ。連続入力をまとめて送る
  function schedule() {
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, 1500);
    hooks?.onState(getState());
  }

  function onUser(u) {
    const changed = (u?.id || null) !== (user?.id || null);
    user = u;
    if (!u) { setState({ phase: configured ? 'signedOut' : 'local' }); return; }
    // 別のアカウントの比較情報は使わない
    if (snap.userId !== u.id) { snap = { userId: u.id, items: {} }; saveSnap(); }
    if (changed) syncNow();
  }

  async function init(h) {
    hooks = h;
    if (!configured) { setState({ phase: 'local' }); return; }
    client = window.supabase.createClient(cfg.url, cfg.anonKey);
    const { data } = await client.auth.getSession();
    onUser(data.session?.user || null);
    client.auth.onAuthStateChange((_event, session) => onUser(session?.user || null));
    window.addEventListener('online', syncNow);
    window.addEventListener('offline', () => setState({ phase: 'offline' }));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  }

  async function signIn(email, password) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  // ログアウトすると、この端末の記録と比較情報を消す（クラウドには残る）
  async function signOut() {
    clearTimeout(timer);
    await client.auth.signOut();
    snap = { userId: null, items: {} };
    saveSnap();
  }

  return { init, signIn, signOut, syncNow, schedule, getState, get configured() { return configured; } };
})();
