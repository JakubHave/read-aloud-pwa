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
  openFile: $("openFile"), fileInput: $("fileInput"),
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

// Chrome's SpeechSynthesis silently stops after a few sentences on long
// utterances. The canonical workaround is to chunk the text into many short
// utterances and let speak() queue them — each chunk is its own checkpoint.
// The regex preserves every character so concatenating chunks reproduces the
// input exactly, which keeps onboundary's per-chunk charIndex alignable with
// the global text via a precomputed chunkOffset[].
const MAX_CHUNK_CHARS = 600;
function splitIntoChunks(text) {
  if (!text) return [];
  const re = /[^.!?]+[.!?]*|[.!?]+/g;
  const sentences = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0]) sentences.push(m[0]);
  }
  if (sentences.length === 0) return [text];
  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && buf.length + s.length > MAX_CHUNK_CHARS) {
      chunks.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
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

  const voice  = findVoice(el.voice.value);
  const rate   = parseFloat(el.rate.value);
  const pitch  = parseFloat(el.pitch.value);
  const volume = parseFloat(el.volume.value);

  const chunks = splitIntoChunks(text);
  const offsets = [];
  let acc = 0;
  for (const c of chunks) { offsets.push(acc); acc += c.length; }

  // Shared error handler: bump curUtterId first so the cascade of error
  // events on the remaining queued chunks all see the stale id and skip.
  const onError = () => {
    if (myId !== curUtterId) return;
    curUtterId++;
    try { window.speechSynthesis.cancel(); } catch (_) {}
    finishText("idle", false);
  };

  for (let i = 0; i < chunks.length; i++) {
    const utter = new SpeechSynthesisUtterance(chunks[i]);
    utter.rate = rate;
    utter.pitch = pitch;
    utter.volume = volume;
    if (voice) utter.voice = voice;

    const chunkOffset = offsets[i];
    const isFirst = i === 0;
    const isLast  = i === chunks.length - 1;

    utter.onboundary = (e) => {
      if (myId !== curUtterId) return;
      if (e.name && e.name !== "word") return;
      realBoundary = true;
      stopEstimator();
      highlight(chunkOffset + e.charIndex);
    };
    // Only the first chunk starts the estimator; only the last chunk ends
    // the read. Everything in between is just a continuation of the queue.
    if (isFirst) {
      utter.onstart = () => {
        if (myId !== curUtterId) return;
        startEstimator(rate, voice ? voice.name : (el.voice.value || ""), text.length);
        renderState("playing");
      };
    }
    if (isLast) {
      utter.onend = () => { if (myId === curUtterId) finishText("idle", true); };
    }
    utter.onerror = onError;

    window.speechSynthesis.speak(utter);
  }
  renderState("playing");

  // Belt-and-suspenders: even chunked, a long queued read can drift if the
  // engine pauses internally. The 9s pause/resume nudge keeps it ticking.
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
  // Web Speech can't change voice mid-utterance, and opening a fresh file
  // mid-read would silently swap the text being spoken. Both lock until idle.
  el.voice.disabled    = playing || paused;
  el.openFile.disabled = playing || paused;

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

// --- file loading (PDF / DOCX / TXT) --------------------------------------
// Libraries are lazy-loaded so the initial PWA shell stays tiny. After the
// first use the service worker has them in cache, so subsequent uses are
// instant and work offline.
let pdfjsPromise = null;
let mammothPromise = null;

function getPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = import("./vendor/pdfjs/pdf.min.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
    return m;
  }).catch((e) => { pdfjsPromise = null; throw e; });
  return pdfjsPromise;
}

function getMammoth() {
  if (mammothPromise) return mammothPromise;
  mammothPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "./vendor/mammoth/mammoth.browser.min.js";
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => {
      mammothPromise = null;  // allow retry after a network blip
      reject(new Error("mammoth.js failed to load"));
    };
    document.head.appendChild(s);
  });
  return mammothPromise;
}

async function extractPdfText(file) {
  const pdfjs = await getPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((it) => it.str).join(" "));
  }
  return out.join("\n\n");
}

async function extractDocxText(file) {
  const mammoth = await getMammoth();
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value || "";
}

async function loadFile(file) {
  showHint("");
  flashStatus("Extracting…");
  el.openFile.disabled  = true;
  el.speakText.disabled = true;
  el.text.disabled      = true;
  try {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const type = file.type || "";
    let text;
    if (ext === "pdf" || type === "application/pdf") {
      text = await extractPdfText(file);
    } else if (
      ext === "docx" ||
      type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      text = await extractDocxText(file);
    } else if (ext === "txt" || type.startsWith("text/")) {
      text = await file.text();
    } else {
      throw new Error("Unsupported file type — try PDF, DOCX, or TXT.");
    }
    text = (text || "").trim();
    el.text.value = text;
    el.count.textContent = text.length;
    try { localStorage.setItem(DRAFT_KEY, text); } catch (_) {}
    if (text) {
      flashStatus("Ready — tap Read text");
    } else {
      flashStatus("Idle");
      showHint("This file has no extractable text (image-only PDF or empty document).");
    }
  } catch (e) {
    flashStatus("Idle");
    showHint("Couldn't read file: " + (e && e.message ? e.message : "unknown error"));
  } finally {
    el.openFile.disabled  = false;
    el.speakText.disabled = false;
    el.text.disabled      = false;
  }
}

// --- Web Share Target pickup ----------------------------------------------
// SW handled POST /share/ -> stashed the file in the share-pending cache and
// redirected to ./?share=1. We pull it out here and feed it through loadFile.
async function checkPendingShare() {
  const params = new URLSearchParams(location.search);
  if (params.get("share") !== "1") return;
  const name = params.get("name") || "shared";
  const type = params.get("type") || "";
  // Strip the query so a refresh doesn't re-trigger.
  history.replaceState({}, "", location.pathname);
  try {
    if (!("caches" in window)) return;
    const cache = await caches.open("share-pending");
    const resp = await cache.match("shared-file");
    if (!resp) return;
    const blob = await resp.blob();
    await cache.delete("shared-file");
    await loadFile(new File([blob], name, { type }));
  } catch (_) {
    showHint("Couldn't load the shared file.");
  }
}

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

  // File picker -> hidden <input type="file"> -> extractor.
  el.openFile.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";  // allow re-selecting the same file
    if (f) loadFile(f);
  });

  // If we got here via the Web Share Target, pick up the file the SW stashed.
  checkPendingShare();

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
