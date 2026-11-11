import * as ort from "onnxruntime-web";
import { createRecognitionSession } from "@tilawa/core";
import "./style.css";

const $ = (s) => document.querySelector(s);
const assetUrl = (path) => `${import.meta.env.BASE_URL}${path}`;
const surahSelect = $("#surahSelect");
const ayahSelect = $("#ayahSelect");
const quranText = $("#quranText");
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

surahSelect.addEventListener("change", fillAyahs);
ayahSelect.addEventListener("change", renderVerses);
$("#hideVerses").addEventListener("change", renderVerses);

function showEvent(event) {
  if (event.type === "verse_match") {
    if (event.surah === Number(surahSelect.value)) {
      lastVerse = event.ayah;
      $("#position").textContent = `الآية ${ar(event.ayah)}`;
      status.textContent = `تم التعرف على الآية ${ar(event.ayah)}.`;
      if (event.ayah > Number(ayahSelect.value)) feedback.textContent = `انتقل التعرف إلى الآية ${ar(event.ayah)}؛ راجع الآيات السابقة للتأكد من عدم سقوط آية.`;
      else feedback.textContent = `تلاوتك تطابق موضعًا من سورة ${surahNames[event.surah - 78]}.`;
    }
  } else if (event.type === "word_progress" && event.surah === Number(surahSelect.value)) {
    $("#position").textContent = `الآية ${ar(event.ayah)} · الكلمة ${ar(event.word_index || 1)}`;
  } else if (event.type === "possible_omission") {
    feedback.textContent = `احتمال سقوط كلمة في الآية ${ar(event.ayah || lastVerse)}. أعدها بهدوء للمراجعة.`;
  } else if (event.type === "possible_substitution") {
    feedback.textContent = `احتمال اختلاف كلمة في الآية ${ar(event.ayah || lastVerse)}. راجع النص ثم أعد التلاوة.`;
  } else if (event.type === "possible_skipped_ayah") {
    feedback.textContent = `احتمال تجاوز آية قرب الآية ${ar(event.ayah || lastVerse)}. راجع تسلسل الآيات.`;
  } else if (event.type === "raw_transcript" && event.text) {
    $("#transcript").textContent = `التعرف الصوتي: ${event.text}`;
  }
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
    session.zipformer?.setExpected({ surah, ayah, ayahEnd: juz.get(surah).at(-1).number });
    session.reset();
    feedback.textContent = "ابدأ القراءة بصوت واضح. تتم المعالجة على هذا الجهاز.";
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

function stop() {
  active = false;
  processor?.disconnect(); processor = null;
  gain?.disconnect(); gain = null;
  stream?.getTracks().forEach((track) => track.stop()); stream = null;
  if (context) { context.close().catch(() => {}); context = null; }
  stopButton.disabled = true;
  startButton.disabled = false;
  if (session) audioQueue = audioQueue.then(() => session.stop()).catch(() => {});
  status.textContent = "انتهى التسميع. يمكنك مراجعة النص والتقدير الصوتي.";
}

startButton.addEventListener("click", begin);
stopButton.addEventListener("click", stop);
$("#listenButton").addEventListener("click", () => {
  const text = (juz.get(Number(surahSelect.value)) || []).find((v) => v.number === Number(ayahSelect.value))?.text;
  if (!text || !window.speechSynthesis) { setupMessage.textContent = "القراءة الصوتية غير متاحة في هذا الجهاز."; return; }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ar-SA";
  speechSynthesis.cancel(); speechSynthesis.speak(utterance);
  setupMessage.textContent = "يقرأ الجهاز نص الآية بصوت عربي آلي؛ ويمكنك الاستماع إلى قارئ من ملفاتك المحلية.";
});

loadReference().catch((error) => { setupMessage.textContent = error.message; });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register(assetUrl("service-worker.js")).catch(() => {}));
