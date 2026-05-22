// Read Aloud PWA — typed text only, Web Speech API.
// Lifted from the Chrome extension's sidepanel.js with chrome.* APIs replaced
// by localStorage and the page-selection / messaging paths removed.
//
// Why the time-based estimator, per-voice calibration, and 9s keep-alive
// nudge exist: see notes at the top of the Chrome extension's content.js.
// Same Chrome SpeechSynthesis quirks apply to the PWA.

const DEFAULTS = { voiceName: "", rate: 1.0, pitch: 1.0, volume: 1.0 };
const SETTINGS_KEY = "ra_settings";
const DRAFT_KEY = "ra_draft";
const CAL_KEY = "ra_voice_cal";

const $ = (id) => document.getElementById(id);
const el = {
  text: $("text"), preview: $("preview"), count: $("count"), status: $("status"),
  speakText: $("speakText"),
  pause: $("pause"), resume: $("resume"), stop: $("stop"),
  voice: $("voice"), rate: $("rate"), pitch: $("pitch"), volume: $("volume"),
  rateVal: $("rateVal"), pitchVal: $("pitchVal"), volumeVal: $("volumeVal"),
  hint: $("hint"),
};

// --- typed-text playback state ---
let words = [];        // [{ span, start, end }]
let curIdx = -1;
let curRange = [];
let keepAlive = null;
let curUtterId = 0;    // bumped per read; stale-utterance events check before acting

// --- time-based highlight fallback (cloud voices skip `onboundary`) ---
let estTimer = null;
let estDelay = null;
let estStart = 0;
let estPausedAt = 0;
let estPausedDur = 0;
let estRate = 1;
let realBoundary = false;
let curVoiceName = "";
let curTotalChars = 0;
const DEFAULT_CPS = 14;
const HL_WINDOW_EST = 3;
const HL_WINDOW_REAL = 1;

// --- localStorage helpers --------------------------------------------------
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}
function readString(key) {
  // iOS Safari private mode can throw SecurityError on localStorage access.
  try { return localStorage.getItem(key) || ""; } catch (_) { return ""; }
}

// --- per-voice EMA calibration --------------------------------------------
let voiceCal = readJSON(CAL_KEY, {});
function cpsFor(name) {
  const v = name && voiceCal[name];
  return (typeof v === "number" && v > 0) ? v : DEFAULT_CPS;
}
function recordCalibration() {
  if (realBoundary || !curVoiceName || !curTotalChars || !estStart) return;
  const elapsed = (performance.now() - estStart - estPausedDur) / 1000;
  // Clear before the elapsed gate so a re-entrant finishText (cancel() also
  // fires onerror, then doStop calls us again) records at most once per read.
  estStart = 0;
  if (elapsed < 0.8) return;
  const observed = curTotalChars / (elapsed * (estRate || 1));
  if (!isFinite(observed) || observed <= 2 || observed > 60) return;
  const prev = voiceCal[curVoiceName] || DEFAULT_CPS;
  voiceCal[curVoiceName] = prev * 0.6 + observed * 0.4;
  writeJSON(CAL_KEY, voiceCal);
}

// --- settings persistence --------------------------------------------------
let saveTimer;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeJSON(SETTINGS_KEY, {
      voiceName: el.voice.value,
      rate: parseFloat(el.rate.value),
      pitch: parseFloat(el.pitch.value),
      volume: parseFloat(el.volume.value),
    });
  }, 200);
}

function refreshLabels() {
  el.rateVal.textContent = parseFloat(el.rate.value).toFixed(1) + "×";
  el.pitchVal.textContent = parseFloat(el.pitch.value).toFixed(1);
  el.volumeVal.textContent = Math.round(parseFloat(el.volume.value) * 100) + "%";
}

function showHint(text) {
  if (!text) { el.hint.hidden = true; el.hint.textContent = ""; return; }
  el.hint.textContent = text;
  el.hint.hidden = false;
}

function flashStatus(text) {
  el.status.textContent = text;
  el.status.className = "status";
}

// --- voices ----------------------------------------------------------------
function loadVoices() {
  const voices = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  // Preserve any saved value across re-renders.
  const persisted = readJSON(SETTINGS_KEY, DEFAULTS).voiceName;
  const chosen = el.voice.value || persisted;
  el.voice.innerHTML = "";

  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Browser default";
  el.voice.appendChild(def);

  voices
    .slice()
    .sort((a, b) =>
      (a.lang || "").localeCompare(b.lang || "") ||
      (a.name || "").localeCompare(b.name || ""))
    .forEach((v) => {
      const o = document.createElement("option");
      o.value = v.name;
      const tag = v.localService ? "" : " · cloud";
      o.textContent = (v.lang ? v.name + " (" + v.lang + ")" : v.name) + tag;
      el.voice.appendChild(o);
    });

  if (chosen && [...el.voice.options].some((o) => o.value === chosen)) {
    el.voice.value = chosen;
  }
}

function findVoice(name) {
  const voices = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  if (!voices.length || !name) return null;
  return voices.find((v) => v.name === name) || null;
}

// --- typed-text reading ----------------------------------------------------
function buildPreview(text) {
  // Render the text into #preview with each word in its own span and record
  // [start, end) character offsets so onboundary's charIndex maps back to a span.
  el.preview.innerHTML = "";
  words = [];
  curIdx = -1;
  curRange = [];
  let cursor = 0;

  text.split(/(\s+)/).forEach((tok) => {
    if (!tok) return;
    if (/^\s+$/.test(tok)) {
      el.preview.appendChild(document.createTextNode(tok));
    } else {
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = tok;
      el.preview.appendChild(span);
      words.push({ span, start: cursor, end: cursor + tok.length });
    }
    cursor += tok.length;
  });
}

function highlight(charIndex) {
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= charIndex) idx = i;
    else break;
  }
  if (idx === -1 || idx === curIdx) return;

  curRange.forEach((i) => {
    if (words[i]) words[i].span.classList.remove("hl");
  });
  curIdx = idx;

  // 3-word band while approximating (forgives drift); 1-word once real
  // boundary events fire.
  const winSize = realBoundary ? HL_WINDOW_REAL : HL_WINDOW_EST;
  curRange = [];
  for (let i = curIdx; i < Math.min(curIdx + winSize, words.length); i++) {
    words[i].span.classList.add("hl");
    curRange.push(i);
  }
  words[curIdx].span.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function showPreview(on) {
  el.preview.hidden = !on;
  el.text.hidden = on;
}

function stopKeepAlive() {
  if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

function tickEstimator() {
  if (realBoundary) { stopEstimator(); return; }
  const elapsed = (performance.now() - estStart - estPausedDur) / 1000;
  highlight(Math.floor(elapsed * cpsFor(curVoiceName) * estRate));
}

function startEstimator(rate, voiceName, totalChars) {
  stopEstimator();
  realBoundary = false;
  estRate = rate || 1;
  curVoiceName = voiceName || "";
  curTotalChars = totalChars || 0;
  estStart = performance.now();
  estPausedDur = 0;
  estPausedAt = 0;
  // Yield to real onboundary events if they fire — they almost always show up
  // in the first few hundred ms when the voice supports them.
  estDelay = setTimeout(() => {
    estDelay = null;
    if (!realBoundary) estTimer = setInterval(tickEstimator, 80);
  }, 400);
}

function stopEstimator() {
  if (estDelay) { clearTimeout(estDelay); estDelay = null; }
  if (estTimer) { clearInterval(estTimer); estTimer = null; }
  estPausedAt = 0;
}

function pauseEstimator() {
  if (estPausedAt) return;
  estPausedAt = performance.now();
  if (estTimer) { clearInterval(estTimer); estTimer = null; }
}

function resumeEstimator() {
  if (!estPausedAt) return;
  estPausedDur += performance.now() - estPausedAt;
  estPausedAt = 0;
  if (!realBoundary && !estTimer) estTimer = setInterval(tickEstimator, 80);
}

function finishText(state, naturalEnd) {
  // naturalEnd separates onend from cancel/error. Only natural ends feed the
  // calibration EMA — a stopped mid-read has elapsed << expected and would
  // inflate the observed chars/sec, throwing future estimator runs ahead of audio.
  if (state === "idle" && naturalEnd) recordCalibration();
  stopKeepAlive();
  stopEstimator();
  curRange = [];
  showPreview(false);
  renderState(state || "idle");
}

function readText() {
  if (!window.speechSynthesis) {
    showHint("This browser doesn't support speech synthesis.");
    return;
  }
  const text = el.text.value.trim();
  if (!text) { flashStatus("Nothing to read — type some text"); return; }
  showHint("");

  // Bump before cancel() so any pending events from the just-cancelled
  // utterance compare their captured myId against the new curUtterId and skip.
  const myId = ++curUtterId;
  window.speechSynthesis.cancel();
  buildPreview(text);
  showPreview(true);

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = parseFloat(el.rate.value);
  utter.pitch = parseFloat(el.pitch.value);
  utter.volume = parseFloat(el.volume.value);
  const voice = findVoice(el.voice.value);
  if (voice) utter.voice = voice;

  utter.onboundary = (e) => {
    if (myId !== curUtterId) return;
    if (e.name && e.name !== "word") return;
    realBoundary = true;
    stopEstimator();
    highlight(e.charIndex);
  };
  utter.onstart = () => {
    if (myId !== curUtterId) return;
    startEstimator(utter.rate, voice ? voice.name : (el.voice.value || ""), text.length);
    renderState("playing");
  };
  utter.onend   = () => { if (myId === curUtterId) finishText("idle", true);  };
  utter.onerror = () => { if (myId === curUtterId) finishText("idle", false); };

  window.speechSynthesis.speak(utter);
  renderState("playing");

  // Chrome silently stops long utterances; a 9s pause/resume nudge resets its
  // timer. Only nudge while actively speaking — never un-pause a deliberate pause.
  stopKeepAlive();
  keepAlive = setInterval(() => {
    const ss = window.speechSynthesis;
    if (ss && ss.speaking && !ss.paused) { ss.pause(); ss.resume(); }
  }, 9000);
}

// --- transport state -> UI -------------------------------------------------
function renderState(state) {
  const playing = state === "playing";
  const paused  = state === "paused";
  el.pause.disabled  = !playing;
  el.resume.disabled = !paused;
  el.stop.disabled   = !(playing || paused);
  // Web Speech can't change voice mid-utterance, so block the picker until idle.
  el.voice.disabled  = playing || paused;

  el.status.className = "status" +
    (playing ? " is-active" : paused ? " is-paused" : "");
  el.status.textContent = playing ? "Reading aloud"
                       : paused  ? "Paused"
                                 : "Idle";

  if (state === "idle") showPreview(false);
}

function doPause()  { window.speechSynthesis.pause();  pauseEstimator();  renderState("paused"); }
function doResume() { window.speechSynthesis.resume(); resumeEstimator(); renderState("playing"); }
function doStop()   { curUtterId++; window.speechSynthesis.cancel(); finishText("idle", false); }

// --- init ------------------------------------------------------------------
function init() {
  if (!window.speechSynthesis) {
    showHint("Speech synthesis isn't available in this browser. The reader controls are disabled.");
    el.speakText.disabled = true;
  } else {
    loadVoices();
    // getVoices() is async-populated; Chrome's first call may return [].
    if ("onvoiceschanged" in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  const s = Object.assign({}, DEFAULTS, readJSON(SETTINGS_KEY, {}));
  el.rate.value   = s.rate;
  el.pitch.value  = s.pitch;
  el.volume.value = s.volume;
  refreshLabels();
  // Defer voice apply: the list may still be filling in.
  setTimeout(() => {
    if ([...el.voice.options].some((o) => o.value === s.voiceName)) {
      el.voice.value = s.voiceName;
    }
  }, 60);

  el.text.value = readString(DRAFT_KEY);
  el.count.textContent = el.text.value.length;
  renderState("idle");

  // Persist draft as the user types (debounced).
  let draftTimer;
  el.text.addEventListener("input", () => {
    el.count.textContent = el.text.value.length;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, el.text.value); } catch (_) {}
    }, 300);
  });

  [el.rate, el.pitch, el.volume].forEach((input) => {
    input.addEventListener("input", () => { refreshLabels(); saveSettings(); });
  });
  el.voice.addEventListener("change", saveSettings);

  el.speakText.addEventListener("click", readText);
  el.pause.addEventListener("click", doPause);
  el.resume.addEventListener("click", doResume);
  el.stop.addEventListener("click", doStop);

  // Clean up if the document is being torn down (tab close / navigation).
  window.addEventListener("pagehide", () => {
    curUtterId++;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
    stopKeepAlive();
    stopEstimator();
  });
}

// --- service worker registration ------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* offline still optional */ });
  });
}

document.addEventListener("DOMContentLoaded", init);
