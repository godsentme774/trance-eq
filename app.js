(function () {
  'use strict';
  const R = window.Rcsp;
  const $ = (id) => document.getElementById(id);

  const SERVICE = '0000ae00-0000-1000-8000-00805f9b34fb';
  const CHAR_WRITE = '0000ae01-0000-1000-8000-00805f9b34fb';
  const CHAR_NOTIFY = '0000ae02-0000-1000-8000-00805f9b34fb';
  const GAIN_MIN = -8; // same range as the official app's sliders
  const GAIN_MAX = 8;
  const STORE_KEY = 'trance-eq-templates-v1';

  const state = {
    transport: null,
    parser: new R.FrameParser(),
    auth: null,
    sn: 1 + Math.floor(Math.random() * 200),
    pending: new Map(),
    freqs: [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    gains: new Array(10).fill(0),
    dynamic: false,
    connected: false,
    dragging: false,
    phase: 'idle',
    activeTpl: null,
    phaseTimer: null,
    templates: [],
  };

  // ------------------------------------------------------------------ log
  function log(msg) {
    const el = $('log');
    const t = new Date().toLocaleTimeString([], { hour12: false });
    el.textContent += t + '  ' + msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(kind, text) {
    const s = $('status');
    s.className = 'pill ' + (kind || '');
    $('statusText').textContent = text;
  }

  // ------------------------------------------------------------ templates
  function loadTemplates() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (e) { /* storage blocked, start empty */ }
    return null;
  }
  function saveTemplates() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.templates)); }
    catch (e) { log('Could not save templates on this browser (storage blocked).'); }
  }
  const uid = () => Math.random().toString(36).slice(2, 10);
  // Built-in curves are written for 10 bands (31 Hz to 16 kHz) and stretched
  // to however many bands the earbuds report. Order = order shown in the list.
  const SEED_VERSION = 2;
  const SEEDS = [
    { name: 'Best All-Round (Start Here)', gains: [6, 5, 3, 0, -1, -1, 1, 3, 4, 3] },
    { name: 'Bass + Clear Vocals', gains: [6, 5, 3, 1, 0, 2, 3, 3, 2, 1] },
    { name: 'Deep Bass', gains: [8, 8, 6, 3, 1, 0, 0, 0, 1, 1] },
    { name: 'Studio Clarity', gains: [2, 1, 0, -1, 0, 1, 2, 3, 3, 2] },
    { name: 'Gaming Footsteps', gains: [2, 1, 0, -1, -1, 1, 4, 5, 3, 1] },
    { name: 'Podcast Voice', gains: [-4, -3, -1, 1, 3, 4, 3, 1, 0, -2] },
    { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  ];
  // first install: everything. Later versions: only add built-ins that are missing,
  // and swap the two weak v1 starters, never touching templates you made yourself.
  function seedTemplates() {
    return SEEDS.map((t) => ({ id: uid(), name: t.name, gains: t.gains.slice(), builtin: true }));
  }
  function upgradeTemplates(list) {
    let ver = 0;
    try { ver = Number(localStorage.getItem(STORE_KEY + '-seed')) || 0; } catch (e) { /* ignore */ }
    if (ver >= SEED_VERSION) return list;
    const oldV1 = {
      'Bass Boost': '7,6,5,3,1,0,0,0,0,0',
      'Vocal Boost': '-2,-2,-1,0,2,4,4,2,0,-1',
      'Treble Lift': '0,0,0,0,0,1,3,5,6,6',
    };
    list = list.filter((t) => !(oldV1[t.name] && t.gains.join(',') === oldV1[t.name]));
    const have = new Set(list.map((t) => t.name.toLowerCase()));
    const fresh = SEEDS.filter((t) => !have.has(t.name.toLowerCase()))
      .map((t) => ({ id: uid(), name: t.name, gains: t.gains.slice(), builtin: true }));
    return fresh.concat(list);
  }
  // stretch or squeeze a curve to a different number of bands
  function resample(arr, n) {
    if (arr.length === n) return arr.slice();
    if (n === 1) return [arr[0]];
    const out = [];
    for (let i = 0; i < n; i++) {
      const pos = (i * (arr.length - 1)) / (n - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(arr.length - 1, lo + 1);
      out.push(Math.round(arr[lo] + (arr[hi] - arr[lo]) * (pos - lo)));
    }
    return out;
  }
  const clamp = (v) => Math.max(GAIN_MIN, Math.min(GAIN_MAX, Math.round(v)));

  // idle | dirty | applying | applied | failed
  function setPhase(phase, text) {
    state.phase = phase;
    const el = $('applyState');
    el.textContent = text || '';
    el.dataset.phase = phase;
    const btn = $('applyBtn');
    btn.textContent = phase === 'applying' ? 'Applying...' : phase === 'applied' ? 'Applied' : phase === 'failed' ? 'Failed, Try Again' : 'Apply To Earbuds';
    btn.dataset.phase = phase;
    btn.disabled = !state.connected || phase === 'applying';
    clearTimeout(state.phaseTimer);
    if (phase === 'applied') {
      state.phaseTimer = setTimeout(() => { if (state.phase === 'applied') setPhase('applied-idle', 'On your earbuds now'); }, 2200);
    }
    renderTemplates();
  }

  function renderTemplates() {
    const box = $('tplList');
    box.textContent = '';
    if (!state.templates.length) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = 'No templates yet. Set the sliders, give it a name and press Save Current.';
      box.appendChild(p);
      return;
    }
    for (const t of state.templates) {
      const row = document.createElement('div');
      row.className = 'tpl';
      const left = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = t.name;
      const spark = document.createElement('div');
      spark.className = 'spark';
      for (const g of t.gains) {
        const i = document.createElement('i');
        i.style.height = 3 + ((g - GAIN_MIN) / (GAIN_MAX - GAIN_MIN)) * 19 + 'px';
        spark.appendChild(i);
      }
      if (t.id === state.activeTpl && state.phase !== 'idle' && state.phase !== 'dirty') {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.dataset.phase = state.phase;
        badge.textContent = state.phase === 'applying' ? 'Applying...' : state.phase === 'failed' ? 'Failed' : 'Applied';
        name.append(' ', badge);
      }
      left.append(name, spark);
      const acts = document.createElement('div');
      acts.className = 'acts';
      const mk = (label, cls, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener('click', fn);
        return b;
      };
      acts.append(
        mk('Use', 'primary', () => useTemplate(t, true)),
        mk('Load', 'ghost', () => useTemplate(t, false)),
        mk('Rename', 'ghost', () => {
          const n = prompt('New name', t.name);
          if (n && n.trim()) { t.name = n.trim().slice(0, 40); saveTemplates(); renderTemplates(); }
        }),
        mk('Delete', 'ghost danger', () => {
          if (confirm('Delete "' + t.name + '"?')) {
            state.templates = state.templates.filter((x) => x.id !== t.id);
            saveTemplates(); renderTemplates();
          }
        })
      );
      row.append(left, acts);
      box.appendChild(row);
    }
  }

  async function useTemplate(t, send) {
    state.gains = resample(t.gains, state.freqs.length).map(clamp);
    state.activeTpl = t.id;
    renderBands();
    if (!send) setPhase('dirty', 'Loaded, not sent to the earbuds yet');
    log('Loaded template "' + t.name + '"');
    if (send) await applyEq();
  }

  // ---------------------------------------------------------------- bands
  const freqLabel = (f) => (f >= 1000 ? String(Math.round(f / 100) / 10).replace(/\.0$/, '') + 'k' : String(f));

  function renderBands() {
    const box = $('bands');
    box.textContent = '';
    state.freqs.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'band';
      const lab = document.createElement('label');
      lab.textContent = freqLabel(f) + ' Hz';
      lab.htmlFor = 'b' + i;
      const rng = document.createElement('input');
      rng.type = 'range';
      rng.id = 'b' + i;
      rng.min = GAIN_MIN; rng.max = GAIN_MAX; rng.step = 1;
      rng.value = state.gains[i] || 0;
      const out = document.createElement('output');
      out.textContent = fmt(rng.value);
      rng.addEventListener('input', () => {
        state.gains[i] = Number(rng.value);
        state.activeTpl = null;
        if (!$('liveChk').checked && state.phase !== 'applying') setPhase('dirty', 'Changed, not sent to the earbuds yet');
        out.textContent = fmt(rng.value);
        if ($('liveChk').checked) liveSend();
      });
      rng.addEventListener('pointerdown', () => { state.dragging = true; });
      rng.addEventListener('pointerup', () => { state.dragging = false; });
      row.append(lab, rng, out);
      box.appendChild(row);
    });
  }
  const fmt = (v) => (Number(v) > 0 ? '+' + v : String(v));

  let liveTimer = null;
  function liveSend() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (state.connected) applyEq(true); }, 250);
  }

  // ----------------------------------------------------------- transport
  function nextSn() {
    state.sn = (state.sn + 1) & 255;
    return state.sn;
  }

  function request(frameBuilder, label) {
    const sn = nextSn();
    const frame = frameBuilder(sn);
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(sn);
        reject(new Error(label + ' timed out'));
      }, 4000);
      state.pending.set(sn, { resolve: (p) => { clearTimeout(timer); resolve(p); } });
      try { await state.transport.write(frame); }
      catch (e) { clearTimeout(timer); state.pending.delete(sn); reject(e); }
    });
  }

  function onNotify(bytes) {
    // Raw handshake values are not wrapped in a frame
    if (!state.parser.pending && R.isAuthData(bytes) && state.auth) {
      state.auth.handle(bytes).catch((e) => log('Auth error: ' + e.message));
      return;
    }
    for (const p of state.parser.push(bytes)) handlePacket(p);
  }

  function handlePacket(p) {
    if (!p.isCommand) {
      const waiter = state.pending.get(p.sn);
      if (waiter) { state.pending.delete(p.sn); waiter.resolve(p); return; }
    }
    if (p.opcode === R.OP_SYS_INFO_AUTO_UPDATE || (p.opcode === R.OP_GET_SYS_INFO && !p.isCommand)) {
      absorbEq(R.readEq(p), !state.dragging);
    }
  }

  function absorbEq(info, redraw) {
    if (info.presets && info.presets.freqs.length) {
      state.freqs = info.presets.freqs;
    }
    if (info.eq) {
      state.dynamic = info.eq.dynamic;
      if (info.eq.dynamic) {
        const n = info.eq.gains.length;
        if (state.freqs.length !== n) state.freqs = defaultFreqs(n);
      } else if (!info.presets) {
        state.freqs = defaultFreqs(10);
      }
      state.gains = info.eq.gains.slice(0, state.freqs.length).map(clamp);
      $('modeNote').textContent = 'Earbuds EQ mode: ' + (info.eq.mode === R.MODE_CUSTOM ? 'Custom' : 'Preset ' + info.eq.mode);
      if (redraw) renderBands();
    }
  }
  function defaultFreqs(n) {
    const base = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    return n === 10 ? base : Array.from({ length: n }, (_, i) => Math.round(60 * Math.pow(16000 / 60, i / (n - 1))));
  }

  async function applyEq(quiet) {
    if (!state.connected || state.phase === 'applying') return;
    const gains = state.gains.map(clamp);
    setPhase('applying', 'Sending to the earbuds...');
    try {
      const resp = await request((sn) => R.buildSetEq(sn, R.MODE_CUSTOM, gains, state.dynamic), 'Apply');
      if (resp.status === 0) {
        if (!quiet) log('Sent to earbuds: ' + gains.map(fmt).join(' '));
        $('modeNote').textContent = 'Earbuds EQ mode: Custom';
        setPhase('applied', 'Applied. The earbuds accepted it');
      } else {
        log('Earbuds refused the change (status ' + resp.status + ').');
        setPhase('failed', 'The earbuds refused it (status ' + resp.status + ')');
      }
    } catch (e) {
      log('Apply failed: ' + e.message);
      setPhase('failed', 'No answer from the earbuds. Check the connection and try again');
    }
  }

  async function readEqFromDevice() {
    const resp = await request((sn) => R.buildGetEq(sn), 'Read EQ');
    if (resp.status !== 0) { log('Could not read EQ (status ' + resp.status + ').'); return; }
    absorbEq(R.readEq(resp), true);
    log('Read EQ from earbuds: ' + state.gains.map(fmt).join(' ') + ' (' + state.freqs.length + ' bands)');
  }

  async function afterConnect() {
    state.connected = true;
    $('connectBtn').hidden = true; $('demoBtn').hidden = true; $('disconnectBtn').hidden = false;
    setPhase('idle', '');
    setStatus('on', 'Connected');
    // handshake
    const ok = await new Promise(async (resolve) => {
      let settled = false;
      const finish = (v, why) => { if (!settled) { settled = true; resolve({ v, why }); } };
      state.auth = new R.AuthSession((b) => state.transport.write(b), (v, why) => finish(v, why));
      try { await state.auth.start(); } catch (e) { finish(false, e.message); }
      setTimeout(() => finish(null, 'no answer'), 4000);
    });
    if (ok.v === true) log('Handshake with earbuds succeeded.');
    else if (ok.v === false) log('Handshake failed: ' + ok.why);
    else log('Earbuds did not answer the handshake, trying without it.');
    try { await readEqFromDevice(); }
    catch (e) { log('Read failed: ' + e.message); }
  }

  function afterDisconnect() {
    state.connected = false;
    state.transport = null;
    state.auth = null;
    state.parser = new R.FrameParser();
    state.pending.clear();
    $('connectBtn').hidden = false; $('demoBtn').hidden = false; $('disconnectBtn').hidden = true;
    setPhase('idle', '');
    $('devName').textContent = '';
    setStatus('', 'Not Connected');
    log('Disconnected.');
  }

  // --------------------------------------------------- real Bluetooth LE
  async function connectBle() {
    try {
      setStatus('warn', 'Connecting');
      const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE] });
      dev.addEventListener('gattserverdisconnected', afterDisconnect);
      log('Connecting to ' + (dev.name || 'device') + ' ...');
      const server = await dev.gatt.connect();
      const svc = await server.getPrimaryService(SERVICE);
      const wr = await svc.getCharacteristic(CHAR_WRITE);
      const nt = await svc.getCharacteristic(CHAR_NOTIFY);
      nt.addEventListener('characteristicvaluechanged', (e) => onNotify(new Uint8Array(e.target.value.buffer.slice(0))));
      await nt.startNotifications();
      state.transport = {
        async write(bytes) {
          // 20 byte chunks fit the default BLE payload on every phone
          for (let i = 0; i < bytes.length; i += 20) {
            const part = bytes.slice(i, i + 20);
            if (wr.writeValueWithoutResponse) await wr.writeValueWithoutResponse(part);
            else await wr.writeValue(part);
          }
        },
        close() { if (dev.gatt.connected) dev.gatt.disconnect(); },
      };
      $('devName').textContent = dev.name || 'Unnamed device';
      await afterConnect();
    } catch (e) {
      log('Connection failed: ' + e.message);
      setStatus('', 'Not Connected');
    }
  }

  // ------------------------------------------------------------ demo mode
  // A pretend pair of earbuds speaking the same protocol, for trying the UI.
  function makeDemoTransport() {
    const dev = { gains: [0, 0, 0, 0, 0, 0, 0, 0], freqs: [60, 150, 400, 1000, 2400, 5000, 9000, 14000], mode: 0 };
    const parser = new R.FrameParser();
    const challenge = Uint8Array.from({ length: 17 }, (_, i) => (i === 0 ? 0 : (i * 37 + 5) & 255));
    const reply = (bytes) => setTimeout(() => onNotify(Uint8Array.from(bytes)), 30);
    const sysInfo = () => {
      const preset = [dev.freqs.length];
      dev.freqs.forEach((f) => preset.push(f >> 8, f & 255));
      for (let m = 0; m < 7; m++) preset.push(m, ...new Array(dev.freqs.length).fill(0));
      return [0xff, dev.gains.length + 3, 4, dev.mode | 0x80, dev.gains.length, ...dev.gains.map((g) => g & 255), preset.length + 1, 12, ...preset];
    };
    const respond = (opcode, sn, body) => {
      const payload = [0, sn, ...body];
      reply([0xfe, 0xdc, 0xba, 0x00, opcode, payload.length >> 8, payload.length & 255, ...payload, 0xef]);
    };
    return {
      async write(bytes) {
        if (R.isAuthData(bytes) && !parser.pending) {
          if (bytes.length === 17 && bytes[0] === 0) {
            reply(R.authAnswer(bytes.subarray(1))); // prove itself
            setTimeout(() => reply(challenge), 80); // then challenge the app
          } else if (bytes.length === 17 && bytes[0] === 1) {
            if (R.toHex(bytes) === R.toHex(R.authAnswer(challenge.subarray(1)))) reply(R.AUTH_PASS);
          }
          return;
        }
        for (const p of parser.push(bytes)) {
          if (!p.isCommand) continue;
          if (p.opcode === R.OP_GET_SYS_INFO) respond(7, p.sn, sysInfo());
          else if (p.opcode === R.OP_SET_SYS_INFO) {
            const eq = R.parseEqAttr(R.parseAttrs(p.data)[0]);
            dev.gains = eq.gains; dev.mode = eq.mode;
            respond(8, p.sn, [0xff]);
          }
        }
      },
      close() { setTimeout(afterDisconnect, 10); },
    };
  }

  async function connectDemo() {
    state.transport = makeDemoTransport();
    $('devName').textContent = 'Demo earbuds (not real)';
    log('Demo mode: talking to a simulated pair of earbuds.');
    await afterConnect();
  }

  // ------------------------------------------------------------- wiring
  function init() {
    if (!('bluetooth' in navigator)) $('unsupported').hidden = false;
    let saved = loadTemplates();
    if (!saved) saved = seedTemplates();
    else saved = upgradeTemplates(saved);
    state.templates = saved;
    saveTemplates();
    try { localStorage.setItem(STORE_KEY + '-seed', String(SEED_VERSION)); } catch (e) { /* ignore */ }
    renderBands();
    renderTemplates();

    $('connectBtn').addEventListener('click', () => {
      if (!('bluetooth' in navigator)) { log('This browser has no Web Bluetooth. Use Bluefy on iPhone, or try Demo Mode.'); return; }
      connectBle();
    });
    $('demoBtn').addEventListener('click', connectDemo);
    $('disconnectBtn').addEventListener('click', () => state.transport && state.transport.close());
    $('applyBtn').addEventListener('click', () => applyEq());
    $('flatBtn').addEventListener('click', () => {
      state.gains = new Array(state.freqs.length).fill(0);
      renderBands();
      if ($('liveChk').checked) liveSend();
    });
    $('saveBtn').addEventListener('click', () => {
      const name = $('tplName').value.trim();
      if (!name) { $('tplName').focus(); return; }
      const existing = state.templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (existing && !confirm('A template called "' + existing.name + '" exists. Replace it?')) return;
      if (existing) existing.gains = state.gains.slice();
      else state.templates.push({ id: uid(), name: name.slice(0, 40), gains: state.gains.slice() });
      saveTemplates(); renderTemplates();
      $('tplName').value = '';
      log('Saved template "' + name + '"');
    });
    $('exportBtn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ app: 'trance-eq', templates: state.templates }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'trance-eq-templates.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const list = Array.isArray(data) ? data : data.templates;
        let added = 0;
        for (const t of list) {
          if (t && typeof t.name === 'string' && Array.isArray(t.gains) && t.gains.length >= 2 && t.gains.length <= 16) {
            state.templates.push({ id: uid(), name: t.name.slice(0, 40), gains: t.gains.map((g) => clamp(Number(g) || 0)) });
            added++;
          }
        }
        saveTemplates(); renderTemplates();
        log('Imported ' + added + ' templates.');
      } catch (err) { log('Import failed: that file is not a template export.'); }
      e.target.value = '';
    });
  }

  init();
})();
