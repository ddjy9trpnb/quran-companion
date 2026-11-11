import * as ort from "onnxruntime-web";
import { createRecognitionSession } from "@tilawa/core";
import "./style.css";

const $ = (s) => document.querySelector(s);
const assetUrl = (path) => `${import.meta.env.BASE_URL}${path}`;
const surahSelect = $("#surahSelect");
const ayahSelect = $("#ayahSelect");
const quranText = $("#quranText");
const audioPlayer = $("#audioPlayer");
const setupMessage = $("#setupMessage");
const startButton = $("#startButton");
const stopButton = $("#stopButton");
const feedback = $("#feedback");
const status = $("#status");
let juz = new Map();
let session;
let stream;
let context;
let processor;
let gain;
let active = false;
let lastVerse = 0;
let audioQueue = Promise.resolve();
let reviewEvents = [];
let reviewIssueKeys = new Set();
let detectedVerses = [];
let finalTranscript = "";
let audioSequence = [];
let audioSequenceIndex = 0;
let audioActive = false;

const ar = (n) => Number(n).toLocaleString("ar");
const surahNames = ["النبأ","النازعات","عبس","التكوير","الانفطار","المطففين","الانشقاق","البروج","الطارق","الأعلى","الغاشية","الفجر","البلد","الشمس","الليل","الضحى","الشرح","التين","العلق","القدر","البينة","الزلزلة","العاديات","القارعة","التكاثر","العصر","الهمزة","الفيل","قريش","الماعون","الكوثر","الكافرون","النصر","المسد","الإخلاص","الفلق","الناس"];

async function loadReference() {
  const response = await fetch(assetUrl("data/juz-amma-tanzil.txt"));
  if (!response.ok) throw new Error("تعذر تحميل ملف جزء عمّ المحلي.");
  const text = await response.text();
  for (const line of text.split(/\r?\n/u)) {
    const first = line.indexOf("|");
    const second = line.indexOf("|", first + 1);
    if (first < 1 || second < 0) continue;
    const surah = Number(line.slice(0, first));
    const ayah = Number(line.slice(first + 1, second));
    if (surah < 78 || surah > 114 || !ayah) continue;
    if (!juz.has(surah)) juz.set(surah, []);
    juz.get(surah).push({ number: ayah, text: line.slice(second + 1) });
  }
  for (let number = 78; number <= 114; number += 1) {
    const option = document.createElement("option");
    option.value = String(number);
    option.textContent = `سورة ${surahNames[number - 78]} · ${ar(juz.get(number)?.length || 0)} آية`;
    surahSelect.append(option);
  }
  surahSelect.value = "78";
  fillAyahs();
}

function fillAyahs() {
  const verses = juz.get(Number(surahSelect.value)) || [];
  ayahSelect.replaceChildren();
  for (const verse of verses) {
    const option = document.createElement("option");
    option.value = String(verse.number);
    option.textContent = `الآية ${ar(verse.number)}`;
    ayahSelect.append(option);
  }
  renderVerses();
}

function renderVerses() {
  quranText.replaceChildren();
  const first = Number(ayahSelect.value || 1);
  const verses = juz.get(Number(surahSelect.value)) || [];
  $("#currentSurahTitle").textContent = `سورة ${surahNames[Number(surahSelect.value) - 78]}`;
  $("#currentLocation").textContent = `من الآية ${ar(first)} إلى ${ar(verses.at(-1)?.number || first)}`;
  for (const verse of verses.filter((item) => item.number >= first)) {
    const row = document.createElement("p");
    row.className = "ayah";
    row.textContent = `${verse.text} ﴿${ar(verse.number)}﴾`;
    quranText.append(row);
  }
  quranText.classList.toggle("quran-hidden", $("#hideVerses").checked);
}

surahSelect.addEventListener("change", () => { stopAudioSequence(); fillAyahs(); });
ayahSelect.addEventListener("change", () => { stopAudioSequence(); renderVerses(); });
$("#hideVerses").addEventListener("change", renderVerses);

function showEvent(event) {
  reviewEvents.push(event);
  if (event.type === "verse_match") {
    if (event.surah === Number(surahSelect.value)) {
      lastVerse = event.ayah;
      if (!detectedVerses.length || detectedVerses.at(-1).ayah !== event.ayah) detectedVerses.push({ surah: event.surah, ayah: event.ayah, confidence: event.confidence });
      $("#position").textContent = `الآية ${ar(event.ayah)}`;
      if (active) status.textContent = `أتابع تلاوتك · وصلت إلى الآية ${ar(event.ayah)}.`;
    }
  } else if (event.type === "word_progress" && event.surah === Number(surahSelect.value)) {
    $("#position").textContent = `الآية ${ar(event.ayah)} · الكلمة ${ar(event.word_index || 1)}`;
  } else if (event.type === "final_sequence" && Array.isArray(event.verses)) {
    detectedVerses = event.verses.filter((item) => item.surah === Number(surahSelect.value));
  } else if (event.type === "correction_note" && event.issue) {
    rememberIssue(event.issue);
  } else if (event.type === "correction" && event.state?.issue) {
    rememberIssue(event.state.issue);
    // Continue listening without interrupting; include this possible issue in the end report.
    if (event.state.phase === "error") {
      try {
        const continuation = session?.zipformer?.correct?.("continue");
        if (continuation?.catch) continuation.catch(() => {});
      } catch { /* Keep the recitation running if this SDK version has no continue action. */ }
    }
  } else if (event.type?.startsWith("possible_")) {
    rememberIssue(event);
  } else if (event.type === "raw_transcript" && event.text) {
    finalTranscript = event.text;
  }
}

function rememberIssue(issue) {
  const key = `${issue.kind || issue.type}:${issue.surah || surahSelect.value}:${issue.ayah || lastVerse}:${issue.word ?? issue.wordIndex ?? ""}`;
  if (reviewIssueKeys.has(key)) return;
  reviewIssueKeys.add(key);
  reviewEvents.push({ type: "review_issue", issue: { ...issue } });
}

function issueLabel(issue) {
  const kind = issue.kind || issue.type;
  const labels = {
    possible_omission: "احتمال سقوط كلمة",
    possible_substitution: "احتمال اختلاف كلمة",
    possible_vowel: "احتمال اختلاف حركة",
    possible_repetition: "احتمال تكرار كلمة",
    possible_skipped_ayah: "احتمال تجاوز آية",
    unclear_ayah: "لم أتمكن من التحقق من آية",
  };
  const ayah = Number(issue.ayah || lastVerse);
  const rawWord = issue.word;
  const word = rawWord !== undefined && rawWord !== null && Number.isFinite(Number(rawWord)) ? `، قرب الكلمة ${ar(Number(rawWord) + 1)}` : "";
  let message = `${labels[kind] || "ملاحظة تحتاج مراجعة"} في الآية ${ar(ayah)}${word}`;
  if (["possible_omission", "possible_substitution", "possible_vowel"].includes(kind) && rawWord !== undefined && rawWord !== null) {
    const verseText = juz.get(Number(issue.surah || surahSelect.value))?.find((item) => item.number === ayah)?.text;
    const expectedWord = verseText?.trim().split(/\s+/u)[Number(rawWord)];
    if (expectedWord) message += ` — الكلمة حسب النص: ${expectedWord}`;
  }
  return message;
}

function renderReview() {
  const items = $("#reviewItems");
  items.replaceChildren();
  const selectedSurah = Number(surahSelect.value);
  const startAyah = Number(ayahSelect.value);
  const verses = detectedVerses.filter((item) => item.surah === selectedSurah);
  const issues = reviewEvents.filter((event) => event.type === "review_issue").map((event) => event.issue);
  const inferredGaps = [];
  if (verses.length) {
    if (verses[0].ayah > startAyah) inferredGaps.push(...Array.from({ length: verses[0].ayah - startAyah }, (_, i) => startAyah + i));
    for (let i = 1; i < verses.length; i += 1) {
      for (let ayah = verses[i - 1].ayah + 1; ayah < verses[i].ayah; ayah += 1) inferredGaps.push(ayah);
    }
  }
  const warnings = [...issues.map(issueLabel), ...[...new Set(inferredGaps)].map((ayah) => `احتمال عدم قراءة الآية ${ar(ayah)}؛ راجع التسلسل.`)];
  if (warnings.length) {
    $("#feedback").textContent = `انتهت القراءة. رصدت ${ar(warnings.length)} ملاحظة محتملة؛ راجعها بهدوء مع النص:`;
    for (const warning of warnings) { const li = document.createElement("li"); li.textContent = warning; items.append(li); }
    items.hidden = false;
  } else if (verses.length) {
    $("#feedback").textContent = `انتهت القراءة. تعرّف النموذج على ${ar(verses.length)} آية، ولم يرصد تنبيهًا واضحًا. هذا تقدير آلي ولا يؤكد صحة كل كلمة أو أحكام التجويد.`;
    items.hidden = true;
  } else {
    $("#feedback").textContent = "انتهت القراءة، لكن النموذج لم يتعرف على آيات كافية لإعطاء مراجعة موثوقة. جرّب القراءة قريبًا من الميكروفون وبصوت أوضح.";
    items.hidden = true;
  }
  $("#transcript").textContent = verses.length
    ? `الآيات التي تعرف عليها النموذج: ${verses.map((item) => ar(item.ayah)).join("، ")}${finalTranscript ? `\nالتفريغ الصوتي التقريبي: ${finalTranscript}` : ""}`
    : finalTranscript ? `التفريغ الصوتي التقريبي: ${finalTranscript}` : "";
}

async function ensureModel() {
  if (session) return;
  status.textContent = "جارٍ تحميل نموذج التصحيح المحلي لأول مرة…";
  ort.env.wasm.numThreads = 1;
  session = await createRecognitionSession({
    ort,
    model: () => fetch(assetUrl("models/zipformer_a0w_ep1_a05.int8.onnx")).then((r) => { if (!r.ok) throw new Error("تعذر تحميل النموذج المحلي."); return r.arrayBuffer(); }),
    corpus: () => fetch(assetUrl("data/zipformer_quran.json")).then((r) => { if (!r.ok) throw new Error("تعذر تحميل بيانات التعرف المحلية."); return r.json(); }),
    onEvent: showEvent,
  });
  session.zipformer?.setMode("correction");
}

function resampleFloat(input, fromRate, toRate = 16000) {
  if (fromRate === toRate) return new Float32Array(input);
  const length = Math.floor(input.length * toRate / fromRate);
  const output = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i += 1) {
    const p = i * step;
    const left = Math.floor(p);
    const fraction = p - left;
    output[i] = input[left] * (1 - fraction) + (input[Math.min(left + 1, input.length - 1)] || 0) * fraction;
  }
  return output;
}

async function begin() {
  setupMessage.textContent = "";
  if (!window.isSecureContext) { setupMessage.textContent = "يلزم فتح الصفحة عبر HTTPS لتشغيل الميكروفون على الآيفون."; return; }
  if (!navigator.mediaDevices?.getUserMedia) { setupMessage.textContent = "هذا المتصفح لا يتيح الميكروفون. افتح الصفحة في Safari."; return; }
  startButton.disabled = true;
  try {
    await ensureModel();
    const surah = Number(surahSelect.value);
    const ayah = Number(ayahSelect.value);
    session.reset();
    session.zipformer?.setMode("correction");
    session.zipformer?.setExpected({ surah, ayah, ayahEnd: juz.get(surah).at(-1).number });
    reviewEvents = [];
    reviewIssueKeys = new Set();
    detectedVerses = [];
    finalTranscript = "";
    $("#reviewItems").replaceChildren();
    $("#reviewItems").hidden = true;
    feedback.textContent = "أقرأ الآن بصمت؛ سأعرض مراجعتي بعد إنهاء الجلسة.";
    $("#transcript").textContent = "";
    $("#recitationPanel").hidden = false;
    renderVerses();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    gain = context.createGain(); gain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!active) return;
      const chunk = resampleFloat(event.inputBuffer.getChannelData(0), context.sampleRate);
      audioQueue = audioQueue.then(() => session.feed(chunk)).catch((error) => { feedback.textContent = `تعذر تحليل الصوت: ${error.message}`; });
    };
    source.connect(processor); processor.connect(gain); gain.connect(context.destination);
    active = true;
    stopButton.disabled = false;
    status.textContent = "الميكروفون يعمل؛ التلاوة تُعالج محليًا.";
  } catch (error) {
    setupMessage.textContent = `تعذر بدء التسميع: ${error.message}`;
    startButton.disabled = false;
    stop();
  }
}

async function stop() {
  const wasActive = active;
  active = false;
  processor?.disconnect(); processor = null;
  gain?.disconnect(); gain = null;
  stream?.getTracks().forEach((track) => track.stop()); stream = null;
  if (context) { context.close().catch(() => {}); context = null; }
  stopButton.disabled = true;
  if (!wasActive) { startButton.disabled = false; return; }
  startButton.disabled = true;
  status.textContent = "انتهت القراءة؛ أجهّز مراجعة الأخطاء المحتملة…";
  try {
    await audioQueue;
    if (session) await session.stop();
    renderReview();
    status.textContent = "اكتملت مراجعة التلاوة.";
  } catch (error) {
    feedback.textContent = `انتهى التسجيل، لكن تعذر إعداد المراجعة: ${error.message}`;
    status.textContent = "تعذرت مراجعة هذه الجلسة.";
  } finally {
    startButton.disabled = false;
  }
}

startButton.addEventListener("click", begin);
stopButton.addEventListener("click", stop);
const listenButton = $("#listenButton");
const listenLabel = $("#listenLabel");

function updateListenLabel(label, icon = "▶") {
  listenLabel.textContent = label;
  listenButton.querySelector(".listen-icon").textContent = icon;
}

function stopAudioSequence() {
  audioActive = false;
  audioSequence = [];
  audioSequenceIndex = 0;
  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
  audioPlayer.load();
  updateListenLabel($("#playWholeSurah").checked ? "استمع للسورة" : "استمع للآية");
}

function playAudioSequenceItem() {
  if (!audioActive || audioSequenceIndex >= audioSequence.length) {
    audioActive = false;
    updateListenLabel("اكتمل الاستماع");
    setupMessage.textContent = "اكتمل الاستماع لتلاوة أحمد العجمي.";
    return;
  }
  const { surah, ayah } = audioSequence[audioSequenceIndex];
  const fileName = `${String(surah).padStart(3, "0")}${String(ayah).padStart(3, "0")}.mp3`;
  audioPlayer.src = `https://everyayah.com/data/ahmed_ibn_ali_al_ajamy_128kbps/${fileName}`;
  audioPlayer.load();
  audioPlayer.play().catch(() => {
    audioActive = false;
    updateListenLabel("إعادة الاستماع");
    setupMessage.textContent = "تعذر تشغيل التلاوة. تحقق من الإنترنت واضغط زر الاستماع مجددًا.";
  });
  if (audioSequence.length > 1) setupMessage.textContent = `تلاوة أحمد العجمي · الآية ${ar(ayah)} من سورة ${surahNames[surah - 78]}`;
}

audioPlayer.addEventListener("ended", () => {
  if (!audioActive) return;
  audioSequenceIndex += 1;
  playAudioSequenceItem();
});

audioPlayer.addEventListener("error", () => {
  if (!audioActive) return;
  audioActive = false;
  updateListenLabel("إعادة الاستماع");
  setupMessage.textContent = "تعذر تحميل ملف التلاوة من EveryAyah. تحقق من اتصال الإنترنت.";
});

listenButton.addEventListener("click", () => {
  if (audioActive) { stopAudioSequence(); setupMessage.textContent = "تم إيقاف الاستماع."; return; }
  const surah = Number(surahSelect.value);
  const ayah = Number(ayahSelect.value);
  if (!juz.get(surah)?.some((verse) => verse.number === ayah)) {
    setupMessage.textContent = "اختر السورة والآية أولاً.";
    return;
  }
  const verses = juz.get(surah);
  audioSequence = $("#playWholeSurah").checked
    ? [{ surah, ayah: 0 }, ...verses.map((verse) => ({ surah, ayah: verse.number }))]
    : [{ surah, ayah }];
  audioSequenceIndex = 0;
  audioActive = true;
  audioPlayer.hidden = false;
  updateListenLabel("إيقاف الاستماع", "■");
  setupMessage.textContent = `تلاوة أحمد العجمي من EveryAyah؛ يلزم اتصال بالإنترنت.`;
  playAudioSequenceItem();
});

$("#playWholeSurah").addEventListener("change", () => {
  if (audioActive) stopAudioSequence();
  updateListenLabel($("#playWholeSurah").checked ? "استمع للسورة" : "استمع للآية");
});

loadReference().catch((error) => { setupMessage.textContent = error.message; });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register(assetUrl("service-worker.js")).catch(() => {}));
