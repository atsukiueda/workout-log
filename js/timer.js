// レスト（セット間の休憩）タイマー
//   終了時刻で管理するので、画面を離れたり再読み込みしたりしても残り時間がずれない。
//   計測中は画面が消えないようにし（Wake Lock 対応端末のみ）、終了時に音と振動で知らせる。
'use strict';

const RestTimer = (() => {
  const KEY = 'workout-log.rest.v1';
  const OVERTIME_HIDE = 120; // 終了後この秒数たったら自動で閉じる
  let st = load();           // { end: ms, total: 秒, label } | null
  let alerted = st ? Date.now() >= st.end : false;
  let tick = null, wake = null, audio = null;
  let opts = { sound: () => true };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  }
  function save() {
    try { st ? localStorage.setItem(KEY, JSON.stringify(st)) : localStorage.removeItem(KEY); } catch { /* 保存できなくても計測は続ける */ }
  }

  const remaining = () => (st ? (st.end - Date.now()) / 1000 : 0);
  const fmt = sec => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // ---- 音（iOS は操作の中で AudioContext を作る必要があるため、最初のタップで準備する）
  function unlockAudio() {
    if (audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = new AC();
    const b = audio.createBuffer(1, 1, 22050), s = audio.createBufferSource();
    s.buffer = b; s.connect(audio.destination); s.start(0);
  }
  function beep() {
    if (!audio || !opts.sound()) return;
    audio.resume?.();
    [0, 0.25, 0.5].forEach((t, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = i === 2 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.4, audio.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.18);
      o.connect(g); g.connect(audio.destination);
      o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.2);
    });
  }
  function notify() {
    beep();
    navigator.vibrate?.([200, 100, 200, 100, 400]);
  }

  // ---- 画面消灯を防ぐ
  async function keepAwake() {
    try { if (st && !wake && 'wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } }
    catch { /* 対応していない・許可されない端末では何もしない */ }
  }
  function releaseAwake() { wake?.release().catch(() => {}); wake = null; }

  // ---- 表示
  function render() {
    const bar = document.getElementById('restBar');
    if (!bar) return;
    document.body.classList.toggle('rest-on', Boolean(st));
    bar.hidden = !st;
    if (!st) return;
    const rem = remaining();
    const done = rem <= 0;
    bar.classList.toggle('done', done);
    bar.querySelector('.rest-time').textContent = done ? `+${fmt(-rem)}` : fmt(rem);
    bar.querySelector('.rest-label').textContent = done ? 'レスト終了' : 'レスト';
    bar.querySelector('.rest-stop').textContent = done ? '閉じる' : 'スキップ';
    bar.querySelector('.rest-ex').textContent = st.label || '';
    bar.querySelector('.rest-progress span').style.width = `${Math.min(100, (1 - rem / st.total) * 100)}%`;
  }

  function loop() {
    clearInterval(tick);
    if (!st) { render(); return; }
    tick = setInterval(() => {
      const rem = remaining();
      if (rem <= 0 && !alerted) { alerted = true; notify(); }
      if (rem <= -OVERTIME_HIDE) { stop(); return; }
      render();
    }, 250);
    render();
  }

  function start(sec, label = '') {
    unlockAudio();
    st = { end: Date.now() + sec * 1000, total: sec, label };
    alerted = false;
    save(); keepAwake(); loop();
  }
  function adjust(delta) {
    if (!st) return;
    st.end += delta * 1000;
    st.total = Math.max(1, st.total + delta);
    if (remaining() > 0) alerted = false;
    save(); render();
  }
  function stop() {
    st = null; clearInterval(tick);
    save(); releaseAwake(); render();
  }

  function init(o = {}) {
    opts = { ...opts, ...o };
    document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !st) return;
      keepAwake();
      // 裏にいる間に終わっていた場合は、戻ったときに知らせる
      if (remaining() <= 0 && !alerted) { alerted = true; notify(); }
      render();
    });
    document.getElementById('restBar')?.addEventListener('click', e => {
      const b = e.target.closest('[data-rest]');
      if (!b) return;
      if (b.dataset.rest === 'stop') stop(); else adjust(Number(b.dataset.rest));
    });
    if (st && remaining() <= -OVERTIME_HIDE) st = null;
    loop();
  }

  return { init, start, adjust, stop, fmt, get running() { return Boolean(st); } };
})();
