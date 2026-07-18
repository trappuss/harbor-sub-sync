/*
 * harbor-sub-sync — draggable subtitle sync timeline for Harbor
 * https://github.com/harborstremio/harbor
 *
 * Install: Harbor → Settings → Advanced → Custom JS → paste → save.
 * Toggle with the "⇄ CC sync" pill or Ctrl+Shift+Y. See README for usage.
 * Requires the native (mpv) player engine.
 */
(function () {
  "use strict";

  // ── idempotent boot ────────────────────────────────────────────────
  if (window.__fsSyncMod) { try { window.__fsSyncMod.destroy(); } catch (e) {} }

  var TI = window.__TAURI_INTERNALS__;
  if (!TI || typeof TI.invoke !== "function") {
    console.warn("[harbor-sub-sync] Tauri internals not found (web build?) — disabled.");
    return;
  }
  var inv = function (cmd, args) { return TI.invoke(cmd, args || {}); };

  // ── mpv helpers ────────────────────────────────────────────────────
  function prop(name) { return inv("mpv_get_property", { name: name }); }
  function setProp(name, value) { return inv("mpv_set_property", { name: name, value: value }); }
  function num(v, d) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : d; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function seekTo(t) { return inv("mpv_command", { cmd: ["seek", t, "absolute", "exact"] }); }

  // ── subtitle parsing (SRT + VTT) ───────────────────────────────────
  var TIME_RE = /(?:(\d+):)?(\d+):(\d+)[.,](\d{1,3})/;
  function parseTime(s) {
    var m = TIME_RE.exec(s);
    if (!m) return null;
    return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] + +("0." + m[4]);
  }
  function parseSubs(text) {
    text = text.replace(/^﻿/, "").replace(/\r/g, "");
    var blocks = text.split(/\n{2,}/);
    var cues = [];
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split("\n");
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf("-->") !== -1) {
          var parts = lines[j].split("-->");
          var start = parseTime(parts[0]);
          var end = parseTime(parts[1] || "");
          if (start == null || end == null) break;
          var txt = lines.slice(j + 1).join(" ")
            .replace(/<[^>]+>/g, "")
            .replace(/\{\\[^}]*\}/g, "")
            .trim();
          if (txt) cues.push({ start: start, end: end, text: txt });
          break;
        }
      }
    }
    cues.sort(function (a, b) { return a.start - b.start; });
    return cues;
  }

  function withTimeout(p, ms, label) {
    return Promise.race([p, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error(label + " timed out")); }, ms);
    })]);
  }

  async function fetchText(url) {
    var readable = url;
    if (!/^(https?|blob|data|asset|tauri):/i.test(url)) {
      try { readable = TI.convertFileSrc(url); } catch (e) { return null; }
    }
    try {
      var ctl = new AbortController();
      var t = setTimeout(function () { ctl.abort(); }, 10000);
      var r = await fetch(readable, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { return null; }
  }

  // Harbor's subtitle_extract runs ffmpeg Rust-side: no CORS, converts
  // srt/vtt/ass to srt, hard 90s timeout.
  async function extractViaFfmpeg(source, streamIndex) {
    var srt = await inv("subtitle_extract", {
      source: String(source), streamIndex: streamIndex, headers: null,
    });
    return parseSubs(String(srt));
  }

  async function loadCues(onStatus) {
    var errors = [];

    // 1) selected external subtitle file (addon/OpenSubtitles/local)
    var ext = null;
    try { ext = await withTimeout(prop("current-tracks/sub/external-filename"), 4000, "mpv"); }
    catch (e) { /* no sub selected */ }
    if (ext && typeof ext === "string" && ext.trim()) {
      onStatus("Loading cues via ffmpeg...");
      try {
        var c1 = await extractViaFfmpeg(ext, 0);
        if (c1.length) return { cues: c1, source: "external" };
      } catch (e) { errors.push("ffmpeg: " + (e && e.message || e)); }
      onStatus("Loading cues (direct fetch)...");
      var t1 = await fetchText(ext);
      if (t1) { var c1b = parseSubs(t1); if (c1b.length) return { cues: c1b, source: "external" }; }
      errors.push("fetch failed/empty");
    }

    // 2) embedded track → live harvest + scan + background extraction
    try {
      var listRaw = await withTimeout(prop("track-list"), 4000, "mpv");
      var list = typeof listRaw === "string" ? JSON.parse(listRaw) : listRaw;
      if (Array.isArray(list)) {
        var embedded = list.filter(function (t) { return t.type === "sub" && !t.external; });
        var idx = embedded.findIndex(function (t) { return t.selected; });
        if (idx >= 0) {
          var src = await prop("path");
          return { cues: [], embedded: { src: String(src), idx: idx } };
        } else if (!ext) {
          errors.push("no subtitle track selected");
        }
      }
    } catch (e) { errors.push("tracks: " + (e && e.message || e)); }

    return { cues: [], error: errors.join(" / ") };
  }

  // ── live cue harvesting ────────────────────────────────────────────
  function harvestCue(start, end, text) {
    if (!isFinite(start) || !isFinite(end) || !text) return false;
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return false;
    var cues = S.cues;
    var lo = 0, hi = cues.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; (cues[mid].start < start - 0.05) ? lo = mid + 1 : hi = mid; }
    if (cues[lo] && Math.abs(cues[lo].start - start) < 0.05) {
      cues[lo].end = end; cues[lo].text = text;
      return false;
    } else if (cues.length < 20000) {
      cues.splice(lo, 0, { start: start, end: end, text: text });
      return true;
    }
    return false;
  }

  async function readCurrentCue() {
    try {
      var r = await Promise.all([prop("sub-start"), prop("sub-end"), prop("sub-text")]);
      var added = harvestCue(num(r[0], NaN), num(r[1], NaN), String(r[2] || ""));
      if (added) saveCues();
      return added;
    } catch (e) { return false; } // no sub displayed right now
  }

  async function pollHarvest() {
    if (!S.open || !S.harvest || S.scanning) return;
    readCurrentCue();
  }

  // ── state ──────────────────────────────────────────────────────────
  var S = {
    open: false, cues: [], delay: 0, time: 0, duration: 0, paused: true,
    zoom: 60, lastPoll: 0, playerAlive: false, pollTimer: null, raf: 0,
    dragging: false, panning: false, dragX: 0, dragDelay: 0, panStart: 0,
    moved: 0, setPending: false, cueEls: [], harvest: false,
    panOff: 0, tick: 0, mediaKey: null, cueSource: "none",
    scanning: false, scanCancel: false, dismissed: false,
  };
  try {
    var z = parseFloat(localStorage.getItem("fss-zoom"));
    if (isFinite(z)) S.zoom = Math.min(600, Math.max(10, z));
  } catch (e) {}

  // ── per-title persistence (delay + harvested cues, LRU 12) ─────────
  function lruTouch(k) {
    try {
      var idx = JSON.parse(localStorage.getItem("fss-cues-index") || "[]");
      idx = idx.filter(function (x) { return x !== k; });
      idx.unshift(k);
      idx.slice(12).forEach(function (x) { try { localStorage.removeItem(x); } catch (e) {} });
      localStorage.setItem("fss-cues-index", JSON.stringify(idx.slice(0, 12)));
    } catch (e) {}
  }

  var saveTimer = null;
  function saveDelay() {
    if (!S.mediaKey) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        if (Math.abs(S.delay) < 0.001) localStorage.removeItem(S.mediaKey);
        else localStorage.setItem(S.mediaKey, String(S.delay));
      } catch (e) {}
    }, 800);
  }

  var cueSaveTimer = null;
  function saveCues() {
    if (!S.mediaKey || !S.harvest || cueSaveTimer) return;
    cueSaveTimer = setTimeout(saveCuesNow, 3000);
  }
  function saveCuesNow() {
    if (cueSaveTimer) { clearTimeout(cueSaveTimer); cueSaveTimer = null; }
    if (!S.mediaKey || !S.harvest || !S.cues.length) return;
    try {
      var arr = S.cues.slice(0, 4000).map(function (c) {
        return [Math.round(c.start * 100) / 100, Math.round(c.end * 100) / 100, c.text];
      });
      var k = "fss-cues:" + S.mediaKey;
      localStorage.setItem(k, JSON.stringify(arr));
      lruTouch(k);
    } catch (e) {}
  }
  function loadCachedCues() {
    try {
      var raw = localStorage.getItem("fss-cues:" + S.mediaKey);
      if (!raw) return null;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return null;
      return arr.map(function (a) { return { start: a[0], end: a[1], text: String(a[2] || "") }; });
    } catch (e) { return null; }
  }

  function flashPill(text) {
    if (!pillLabel) return;
    pillLabel.textContent = text;
    setTimeout(function () { pillLabel.textContent = "⇄ CC sync"; }, 4000);
  }

  async function checkMedia() {
    if (S.scanning) return;
    try {
      var fn = String(await prop("filename"));
      var key = "fss-delay:" + fn + "|" + Math.round(S.duration);
      if (key === S.mediaKey) return;
      S.mediaKey = key;
      S.cues = []; S.cueSource = "none"; S.harvest = false;
      S.dismissed = false; // new title → pill comes back
      var saved = NaN;
      try { saved = parseFloat(localStorage.getItem(key)); } catch (e) {}
      if (isFinite(saved) && Math.abs(saved) > 0.001 && Math.abs(S.delay) < 0.001) {
        S.delay = saved;
        setProp("sub-delay", saved).catch(function () {});
        flashPill("⇄ restored " + fmtOff(saved));
      }
      if (S.open) reloadCues();
    } catch (e) { /* mpv busy */ }
  }

  // ── styles ─────────────────────────────────────────────────────────
  var css = document.createElement("style");
  css.textContent =
    "#fss-pill{position:fixed;right:18px;bottom:132px;z-index:2147483000;display:none;" +
    "align-items:center;gap:8px;" +
    "background:rgba(20,22,28,.92);color:#eee;border:1px solid rgba(255,255,255,.18);" +
    "border-radius:999px;padding:6px 8px 6px 14px;font:600 12px system-ui,sans-serif;" +
    "user-select:none;backdrop-filter:blur(6px)}" +
    "#fss-pill-label{cursor:pointer}" +
    "#fss-pill:hover{background:rgba(40,44,54,.95)}" +
    "#fss-pill-x{cursor:pointer;opacity:.5;padding:0 5px;border-radius:999px;font-size:13px;line-height:1}" +
    "#fss-pill-x:hover{opacity:1;background:rgba(255,255,255,.15)}" +
    "#fss-panel{position:fixed;left:12px;right:12px;bottom:96px;z-index:2147483001;display:none;" +
    "background:rgba(14,16,20,.94);border:1px solid rgba(255,255,255,.14);border-radius:10px;" +
    "color:#e8e8e8;font:12px system-ui,sans-serif;backdrop-filter:blur(8px);user-select:none}" +
    "#fss-head{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,.08);flex-wrap:wrap}" +
    "#fss-head b{font-size:12px}#fss-off{min-width:76px;text-align:center;font:700 13px ui-monospace,monospace;color:#7dd3fc}" +
    "#fss-info{opacity:.55;font-size:11px}" +
    ".fss-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#ddd;" +
    "border-radius:6px;padding:3px 9px;cursor:pointer;font:600 11px system-ui}" +
    ".fss-btn:hover{background:rgba(255,255,255,.18)}" +
    "#fss-recenter{display:none;color:#fbbf24;border-color:rgba(251,191,36,.4)}" +
    "#fss-scan{display:none;color:#86efac;border-color:rgba(134,239,172,.35)}" +
    "#fss-hint{margin-left:auto;opacity:.5;font-size:11px}" +
    "#fss-tl{position:relative;height:74px;overflow:hidden;cursor:grab;touch-action:none}" +
    "#fss-tl.drag{cursor:grabbing}#fss-tl.pan{cursor:all-scroll}" +
    "#fss-ticks{position:absolute;inset:0;pointer-events:none}" +
    ".fss-tick{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.07)}" +
    ".fss-tick span{position:absolute;top:2px;left:3px;font-size:9px;opacity:.45}" +
    ".fss-cue{position:absolute;top:24px;height:30px;background:rgba(56,132,255,.30);" +
    "border:1px solid rgba(120,180,255,.55);border-radius:4px;overflow:hidden;white-space:nowrap;" +
    "font-size:10px;line-height:28px;padding:0 4px;color:#dbeafe;pointer-events:auto;cursor:pointer}" +
    ".fss-cue:hover{background:rgba(56,132,255,.5)}" +
    "#fss-ph{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#f87171;pointer-events:none}" +
    "#fss-ph:after{content:'';position:absolute;top:0;left:-4px;border:5px solid transparent;border-top-color:#f87171}" +
    "#fss-status{position:absolute;left:0;right:0;top:44%;text-align:center;opacity:.55;pointer-events:none}";
  document.head.appendChild(css);

  // ── DOM ────────────────────────────────────────────────────────────
  var pill = document.createElement("div");
  pill.id = "fss-pill";
  pill.innerHTML =
    '<span id="fss-pill-label" title="Subtitle sync timeline (Ctrl+Shift+Y)">⇄ CC sync</span>' +
    '<span id="fss-pill-x" title="Hide until the next title (Ctrl+Shift+Y brings it back)">✕</span>';
  document.body.appendChild(pill);
  var pillLabel = pill.querySelector("#fss-pill-label");

  var panel = document.createElement("div");
  panel.id = "fss-panel";
  panel.innerHTML =
    '<div id="fss-head"><b>Subtitle Sync</b><span id="fss-off">+0.000s</span>' +
    '<span id="fss-info"></span>' +
    '<button class="fss-btn" data-n="-0.5">−0.5s</button>' +
    '<button class="fss-btn" data-n="-0.05">−50ms</button>' +
    '<button class="fss-btn" data-n="0.05">+50ms</button>' +
    '<button class="fss-btn" data-n="0.5">+0.5s</button>' +
    '<button class="fss-btn" id="fss-reset">Reset</button>' +
    '<button class="fss-btn" id="fss-reload">Reload cues</button>' +
    '<button class="fss-btn" id="fss-scan">Scan +5min</button>' +
    '<button class="fss-btn" id="fss-recenter">⟲ recenter</button>' +
    '<span id="fss-hint" title="Drag = shift subs. Shift+click cue = align that line to NOW. ' +
    'Click cue = seek to it. Double-click empty = seek there. Alt+drag = pan view. ' +
    'Wheel = zoom, Shift+wheel = 10ms nudge. Alt+Arrows = 10ms (with Shift 100ms). ' +
    'Scan steps through the next 5 minutes collecting cues, then returns.">' +
    'drag shift · ⇧click align · alt-drag pan · wheel zoom · hover for help</span>' +
    '<button class="fss-btn" id="fss-close">✕</button></div>' +
    '<div id="fss-tl"><div id="fss-ticks"></div><div id="fss-status"></div><div id="fss-ph"></div></div>';
  document.body.appendChild(panel);

  var tl = panel.querySelector("#fss-tl");
  var ticks = panel.querySelector("#fss-ticks");
  var offEl = panel.querySelector("#fss-off");
  var infoEl = panel.querySelector("#fss-info");
  var statusEl = panel.querySelector("#fss-status");
  var phEl = panel.querySelector("#fss-ph");
  var recenterBtn = panel.querySelector("#fss-recenter");
  var scanBtn = panel.querySelector("#fss-scan");

  function fmtOff(v) { return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(3) + "s"; }

  // ── polling clock ──────────────────────────────────────────────────
  async function poll() {
    if (S.scanning) return; // scan owns the player while running
    try {
      var d = num(await prop("duration"), 0);
      S.playerAlive = d > 0;
      if (S.playerAlive) {
        S.duration = d;
        S.time = num(await prop("time-pos"), S.time);
        S.paused = String(await prop("pause")) !== "no";
        if (!S.dragging && !S.setPending) S.delay = num(await prop("sub-delay"), S.delay);
        S.lastPoll = performance.now();
        pollHarvest();
        if (S.tick++ % 5 === 0) checkMedia(); // every ~2s
      } else {
        S.mediaKey = null;
      }
    } catch (e) { S.playerAlive = false; S.mediaKey = null; }
    // only show while Harbor's player view is actually on screen
    var uiOpen = !!document.querySelector("[data-harbor-player]");
    var show = S.playerAlive && uiOpen && !S.dismissed;
    pill.style.display = show ? "inline-flex" : "none";
    if ((!S.playerAlive || !uiOpen) && S.open) close();
  }

  function nowTime() {
    if (S.paused || S.dragging || S.scanning) return S.time;
    return S.time + (performance.now() - S.lastPoll) / 1000;
  }

  // ── auto-scan (embedded tracks): seek-step and harvest ─────────────
  async function toggleScan() {
    if (S.scanning) { S.scanCancel = true; return; }
    if (!S.harvest) return;
    S.scanning = true; S.scanCancel = false;
    scanBtn.textContent = "Stop scan";
    var origPos = nowTime();
    var origPaused = S.paused;
    var origMute = "no";
    try { origMute = String(await prop("mute")); } catch (e) {}
    try {
      await setProp("pause", true); S.paused = true;
      await setProp("mute", true);
      var from = Math.max(0, origPos - 15);
      var to = Math.min(S.duration - 1, origPos + 300);
      for (var t = from; t <= to && !S.scanCancel; t += 2.5) {
        try {
          await seekTo(t);
          S.time = t; // keep timeline following the scan
          var deadline = performance.now() + 800;
          while (performance.now() < deadline) {
            await sleep(110);
            var p = num(await prop("time-pos"), -1);
            if (Math.abs(p - t) < 1.5) { S.time = p; break; }
          }
          await sleep(70);
          await readCurrentCue();
          statusEl.textContent = "Scanning " + fmtTime(t) + " → " + fmtTime(to) +
            " · " + S.cues.length + " cues (click Stop scan to cancel)";
        } catch (e) { /* keep stepping */ }
      }
    } finally {
      try {
        await seekTo(origPos);
        S.time = origPos;
        await setProp("mute", origMute === "yes");
        await setProp("pause", origPaused);
        S.paused = origPaused;
      } catch (e) {}
      S.scanning = false; S.scanCancel = false;
      scanBtn.textContent = "Scan +5min";
      statusEl.textContent = "";
      saveCuesNow();
    }
  }

  // ── rendering ──────────────────────────────────────────────────────
  var lastInfo = "";
  function render() {
    if (!S.open) return;
    var center = Math.min(nowTime(), S.duration) + S.panOff;
    var half = S.zoom / 2;
    var min = center - half, max = center + half;

    var step = niceStep(S.zoom / 10);
    var html = "";
    for (var tt = Math.ceil(min / step) * step; tt <= max; tt += step) {
      if (tt < 0 || tt > S.duration) continue;
      var x = ((tt - min) / S.zoom) * 100;
      html += '<div class="fss-tick" style="left:' + x + '%"><span>' + fmtTime(tt) + "</span></div>";
    }
    ticks.innerHTML = html;

    var phX = ((nowTime() - min) / S.zoom) * 100;
    phEl.style.left = Math.min(100, Math.max(0, phX)) + "%";
    phEl.style.opacity = (phX < 0 || phX > 100) ? "0.25" : "1";
    recenterBtn.style.display = Math.abs(S.panOff) > 0.01 ? "inline-block" : "none";
    scanBtn.style.display = (S.harvest || S.scanning) ? "inline-block" : "none";

    var vis = [];
    var cues = S.cues, dl = S.delay;
    for (var i = 0; i < cues.length; i++) {
      var cs = cues[i].start + dl, ce = cues[i].end + dl;
      if (ce < min) continue;
      if (cs > max) break;
      vis.push(cues[i]);
    }
    while (S.cueEls.length < vis.length) {
      var el = document.createElement("div");
      el.className = "fss-cue";
      el.addEventListener("click", onCueClick);
      tl.appendChild(el);
      S.cueEls.push(el);
    }
    for (var k = 0; k < S.cueEls.length; k++) {
      var box = S.cueEls[k];
      if (k >= vis.length) { box.style.display = "none"; continue; }
      var c = vis[k];
      box.style.display = "block";
      box.style.left = (((c.start + dl - min) / S.zoom) * 100) + "%";
      box.style.width = (Math.max(0.15, ((c.end - c.start) / S.zoom) * 100)) + "%";
      if (box.__cue !== c) { box.textContent = c.text; box.title = c.text; box.__cue = c; }
    }

    offEl.textContent = fmtOff(S.delay);
    var srcLabel = S.harvest
      ? (S.cueSource === "cached" ? "cached+live" : "live")
      : S.cueSource;
    var info = S.cues.length ? S.cues.length + " cues (" + srcLabel + ")"
      : (S.harvest ? "live (waiting for lines)" : "");
    if (info !== lastInfo) { lastInfo = info; infoEl.textContent = info; }

    S.raf = requestAnimationFrame(render);
  }
  function niceStep(raw) {
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= raw) return steps[i];
    return 600;
  }
  function fmtTime(s) {
    s = Math.round(s);
    var m = Math.floor(s / 60), sec = s % 60;
    var h = Math.floor(m / 60); m %= 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
  }

  // ── delay application (throttled) ─────────────────────────────────
  function applyDelay(v) {
    S.delay = Math.round(v * 1000) / 1000;
    saveDelay();
    if (S.setPending) return;
    S.setPending = true;
    setTimeout(function () {
      S.setPending = false;
      setProp("sub-delay", S.delay).catch(function () {});
    }, 50);
  }

  // ── interactions ───────────────────────────────────────────────────
  tl.addEventListener("pointerdown", function (e) {
    S.moved = 0; S.dragX = e.clientX;
    if (e.altKey) {
      S.panning = true; S.panStart = S.panOff;
      tl.classList.add("pan");
    } else {
      S.dragging = true; S.dragDelay = S.delay;
      tl.classList.add("drag");
    }
    tl.setPointerCapture(e.pointerId);
  });
  tl.addEventListener("pointermove", function (e) {
    var dx = e.clientX - S.dragX;
    if (S.dragging) {
      S.moved = Math.max(S.moved, Math.abs(dx));
      applyDelay(S.dragDelay + (dx / (tl.clientWidth || 1)) * S.zoom);
    } else if (S.panning) {
      S.moved = Math.max(S.moved, Math.abs(dx));
      S.panOff = S.panStart - (dx / (tl.clientWidth || 1)) * S.zoom;
    }
  });
  function endDrag() {
    if (S.dragging) setProp("sub-delay", S.delay).catch(function () {});
    S.dragging = false; S.panning = false;
    tl.classList.remove("drag"); tl.classList.remove("pan");
  }
  tl.addEventListener("pointerup", endDrag);
  tl.addEventListener("pointercancel", endDrag);

  tl.addEventListener("wheel", function (e) {
    e.preventDefault();
    if (e.shiftKey) { applyDelay(S.delay + (e.deltaY > 0 ? -0.01 : 0.01)); return; }
    S.zoom = Math.min(600, Math.max(10, S.zoom * (e.deltaY > 0 ? 1.25 : 0.8)));
    try { localStorage.setItem("fss-zoom", String(S.zoom)); } catch (err) {}
  }, { passive: false });

  tl.addEventListener("dblclick", function (e) {
    if (S.scanning) return;
    if (e.target && e.target.classList && e.target.classList.contains("fss-cue")) return;
    var rect = tl.getBoundingClientRect();
    var frac = (e.clientX - rect.left) / (rect.width || 1);
    var center = Math.min(nowTime(), S.duration) + S.panOff;
    var t = Math.max(0, Math.min(S.duration, center - S.zoom / 2 + frac * S.zoom));
    seekTo(t).catch(function () {});
    S.panOff = 0;
  });

  function onCueClick(e) {
    if (S.moved > 4 || S.scanning) return;
    e.stopPropagation();
    var c = e.currentTarget.__cue;
    if (!c) return;
    if (e.shiftKey) {
      // align this line's start to the playhead
      applyDelay(nowTime() - c.start);
      return;
    }
    seekTo(Math.max(0, c.start + S.delay - 1)).catch(function () {});
  }

  panel.querySelectorAll(".fss-btn[data-n]").forEach(function (b) {
    b.addEventListener("click", function () {
      applyDelay(S.delay + parseFloat(b.getAttribute("data-n")));
    });
  });
  panel.querySelector("#fss-reset").addEventListener("click", function () { applyDelay(0); });
  panel.querySelector("#fss-close").addEventListener("click", close);
  panel.querySelector("#fss-reload").addEventListener("click", function () { reloadCues(); });
  recenterBtn.addEventListener("click", function () { S.panOff = 0; });
  scanBtn.addEventListener("click", function () { toggleScan(); });

  var loadToken = 0;
  async function reloadCues() {
    if (S.scanning) return;
    var token = ++loadToken;
    var prevCues = S.cues, prevSrc = S.cueSource;
    S.harvest = false;
    S.cueSource = "none";
    statusEl.textContent = "Loading cues...";
    var res;
    try {
      res = await withTimeout(
        loadCues(function (msg) { if (token === loadToken) statusEl.textContent = msg; }),
        120000, "cue loading");
    } catch (e) {
      res = { cues: [], error: (e && e.message) || String(e) };
    }
    if (token !== loadToken) return; // superseded by a newer reload
    S.cues = res.cues;
    S.cueSource = res.source || "none";

    if (res.embedded) {
      // Embedded track: keep cached/previously harvested cues, harvest
      // live, and try full ffmpeg extraction in the background (succeeds
      // for local files; usually times out for remote streams — use Scan).
      var cached = loadCachedCues();
      if (cached) { S.cues = cached; S.cueSource = "cached"; }
      else if (prevSrc === "cached" || prevSrc === "live") { S.cues = prevCues; S.cueSource = prevSrc; }
      S.harvest = true;
      statusEl.textContent = S.cues.length
        ? ""
        : "Live mode: boxes appear as lines display - or click Scan +5min to map ahead.";
      extractViaFfmpeg(res.embedded.src, res.embedded.idx).then(function (full) {
        if (token !== loadToken || !full.length) return;
        S.cues = full;
        S.cueSource = "full";
        statusEl.textContent = "";
        saveCuesNow();
        S.harvest = false;
      }).catch(function () {
        if (token !== loadToken) return;
        if (!S.cues.length) {
          statusEl.textContent =
            "Live mode: full extraction unavailable for this stream - play, seek, or Scan to map cues.";
          setTimeout(function () { if (token === loadToken && S.harvest) statusEl.textContent = ""; }, 8000);
        }
      });
      return;
    }

    statusEl.textContent = res.cues.length ? "" :
      "No cues (" + (res.error || "unknown") + ") - drag/nudge still works.";
  }

  async function open() {
    if (S.open) return;
    await poll();
    if (!S.playerAlive) return;
    S.open = true;
    S.panOff = 0;
    panel.style.display = "block";
    render();
    reloadCues();
  }
  function close() {
    if (S.scanning) S.scanCancel = true;
    S.open = false;
    S.harvest = false;
    S.panOff = 0;
    panel.style.display = "none";
    cancelAnimationFrame(S.raf);
    saveCuesNow();
  }
  pill.querySelector("#fss-pill-label").addEventListener("click", function () {
    S.open ? close() : open();
  });
  pill.querySelector("#fss-pill-x").addEventListener("click", function (e) {
    e.stopPropagation();
    S.dismissed = true;
    pill.style.display = "none";
    if (S.open) close();
  });

  function onKey(e) {
    if (e.ctrlKey && e.shiftKey && (e.key === "Y" || e.key === "y")) {
      e.preventDefault();
      S.dismissed = false; // hotkey always brings it back
      S.open ? close() : open();
      return;
    }
    if (!S.open || !e.altKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      var step = (e.shiftKey ? 0.1 : 0.01) * (e.key === "ArrowLeft" ? -1 : 1);
      applyDelay(S.delay + step);
    }
  }
  window.addEventListener("keydown", onKey, true);

  S.pollTimer = setInterval(poll, 400);
  poll();

  // ── cleanup (Harbor calls __harborCustomCleanup when custom JS changes)
  var prevCleanup = window.__harborCustomCleanup;
  function destroy() {
    S.scanCancel = true;
    clearInterval(S.pollTimer);
    cancelAnimationFrame(S.raf);
    window.removeEventListener("keydown", onKey, true);
    pill.remove(); panel.remove(); css.remove();
    window.__fsSyncMod = undefined;
  }
  window.__fsSyncMod = { destroy: destroy, open: open, close: close };
  window.__harborCustomCleanup = function () {
    destroy();
    if (typeof prevCleanup === "function") { try { prevCleanup(); } catch (e) {} }
  };
})();
