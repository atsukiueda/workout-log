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
  let opts = { sound: () => true, ignoreSilent: () => false, repeat: () => 3 };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  }
  function save() {
    try { st ? localStorage.setItem(KEY, JSON.stringify(st)) : localStorage.removeItem(KEY); } catch { /* 保存できなくても計測は続ける */ }
  }

  const remaining = () => (st ? (st.end - Date.now()) / 1000 : 0);
  const fmt = sec => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // ---- 音
  //   iPhone の Safari は「タップが完了した操作」（touchend / click）の中でしか音声を有効にできない。
  //   アプリを裏に回したり、システムのポップアップ（シェイクで取り消し・着信など）が出たりすると
  //   音声が中断（interrupted / suspended）され、その後 resume() しても戻らないことがある。
  //   そのため、止まっていればタップのたびに音声を作り直す。
  const AC = window.AudioContext || window.webkitAudioContext;
  const audioReady = () => Boolean(audio) && audio.state === 'running';

  function createAudio() {
    if (audio) {
      const old = audio;
      old.onstatechange = null;
      old.close?.().catch(() => {});
    }
    audio = new AC();
    audio.onstatechange = () => render(); // 中断されたら表示に反映
    const b = audio.createBuffer(1, 1, 22050), s = audio.createBufferSource();
    s.buffer = b; s.connect(audio.destination); s.start(0);
    if (audio.state !== 'running') audio.resume?.().then(render).catch(() => {});
  }
  // タップ操作の中で呼ぶ
  function unlockAudio() {
    if (!AC) return;
    if (!audioReady()) { createAudio(); render(); }
  }
  // 操作なしでの復帰の試み（ポップアップが閉じた・画面に戻ったとき）。iPhone では効かないこともある
  function tryResume() {
    if (audio && !audioReady()) audio.resume?.().then(render).catch(() => {});
  }
  // 消音モードでも鳴らす（Safari の Audio Session API）。鳴らす間だけ playback にして、終わったら戻す
  function setSessionForBeep(on) {
    if (!navigator.audioSession || !opts.ignoreSilent()) return;
    try { navigator.audioSession.type = on ? 'playback' : 'auto'; } catch { /* 未対応 */ }
  }
  function playTones() {
    const t0 = audio.currentTime + 0.05;
    [0, 0.25, 0.5].forEach((t, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = i === 2 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t0 + t);
      g.gain.exponentialRampToValueAtTime(0.6, t0 + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.2);
      o.connect(g); g.connect(audio.destination);
      o.start(t0 + t); o.stop(t0 + t + 0.22);
    });
    setTimeout(() => setSessionForBeep(false), 1200);
  }
  function beep(force = false) {
    if (!audio || (!force && !opts.sound())) return;
    setSessionForBeep(true);
    if (audioReady()) playTones();
    else audio.resume?.().then(() => { if (audioReady()) playTones(); }).catch(() => {});
  }
  // 終了の合図を repeat 回くり返す（約2秒おき）。スキップ・閉じる・次のタイマー開始で止まる
  const REPEAT_GAP = 2000;
  let repeatTimers = [];
  function cancelRepeat() { repeatTimers.forEach(clearTimeout); repeatTimers = []; }
  function notify(force = false) {
    cancelRepeat();
    const n = Math.max(1, Number(opts.repeat()) || 1);
    const signal = () => { beep(force); navigator.vibrate?.([200, 100, 200, 100, 400]); };
    signal(); // 1回目はすぐ（タップ操作の中で鳴らせるように）
    for (let i = 1; i < n; i++) repeatTimers.push(setTimeout(signal, i * REPEAT_GAP));
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
    // 音が出せない状態なら知らせる（タップすると作り直して復帰する）
    const mute = bar.querySelector('.rest-mute');
    if (mute) mute.hidden = !(AC && opts.sound() && !audioReady());
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
    cancelRepeat();
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
    st = null; clearInterval(tick); cancelRepeat();
    save(); releaseAwake(); render();
  }

  function init(o = {}) {
    opts = { ...opts, ...o };
    for (const type of ['touchend', 'click', 'keydown']) document.addEventListener(type, unlockAudio, { capture: true, passive: true });
    // ポップアップが閉じた・アプリに戻ったときに復帰を試みる
    window.addEventListener('focus', tryResume);
    window.addEventListener('pageshow', tryResume);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tryResume();
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

  // 設定画面の「音を試す」。タップ操作の中で呼ぶ
  function testSound() {
    unlockAudio();
    notify(true);
  }

  // ---- 端末ごとの設定（クラウド同期しない）
  //   timer: 'auto'（スマホ・タブレットのみ）| 'on' | 'off'、ignoreSilent: 消音モードでも鳴らす
  const DEVICE_KEY = 'workout-log.device.v1';
  function device() {
    try { return { timer: 'auto', ignoreSilent: false, ...JSON.parse(localStorage.getItem(DEVICE_KEY)) }; }
    catch { return { timer: 'auto', ignoreSilent: false }; }
  }
  function setDevice(patch) {
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...device(), ...patch })); } catch { /* 保存できなければ既定値のまま */ }
    if (!enabled()) stop();
  }
  const isTouchDevice = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;
  function enabled() {
    const m = device().timer;
    return m === 'on' || (m === 'auto' && isTouchDevice());
  }

  return {
    init, start, adjust, stop, fmt, testSound, device, setDevice, enabled, isTouchDevice,
    get running() { return Boolean(st); },
    get audioSessionSupported() { return Boolean(navigator.audioSession); },
  };
})();
