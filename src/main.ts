import './style.css';
import { hasGeminiKey } from './config';
import { LINES, carAtX, carCentreX, findStation, getLine, type Direction, type Line, type PlatformLayout, type Station } from './data/network';
import { demandAt, demandLabel, estimateLoads, type CarLoad } from './engine/crowding';
import { NEED_LABELS, directionBetween, recommend, type Need, type Recommendation } from './engine/recommend';
import { composeGuidance, locateOnPlatform, parseRequest, rebuildPlatform, speak, stopSpeaking, type PhotoLocation } from './gemini';
import { VoiceRecorder, imageToMedia, openCamera } from './media';
import { PlatformScene, loadColor, type TrainPhase, type Turn } from './scene';
import { trainSvg } from './trainSvg';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type MappedStation = Station & { layout: PlatformLayout };

const state = {
  line: LINES[0] as Line,
  origin: undefined as MappedStation | undefined,
  destination: undefined as Station | undefined,
  dir: 'east' as Direction,
  needs: new Set<Need>(),
  userX: undefined as number | undefined,
  photo: undefined as PhotoLocation | undefined,
  language: 'en-GB',
  // Live train simulation.
  trainSeed: 1,
  arrivalAt: 0,
  loads: [] as CarLoad[],
  rec: undefined as Recommendation | undefined,
  // How state.userX was set: a recognised photo, a click on the train view, or a simulated entrance.
  userSource: undefined as 'photo' | 'landmark' | 'simulated' | 'entrance' | undefined,
  pickedName: undefined as string | undefined,
  boarded: false,
  lastSpoken: '',
};

const APPROACH_S = 16;
const DWELL_S = 30;
const DEPART_S = 12;

const scene = new PlatformScene($('scene'));
const recorder = new VoiceRecorder();

// ---------- Setup ----------

function mapped(line: Line) {
  return line.stations.filter((s): s is MappedStation => !!s.layout);
}

function renderLines() {
  const host = $('lines');
  host.innerHTML = '';
  for (const line of LINES) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(line.id === state.line.id));
    b.style.setProperty('--line', line.color);
    b.innerHTML = line.available ? line.name : `${line.name} <small>soon</small>`;
    b.disabled = !line.available;
    b.onclick = () => selectLine(line.id);
    host.appendChild(b);
  }
}

function selectLine(id: string) {
  state.line = getLine(id);
  document.documentElement.style.setProperty('--accent', state.line.color);
  renderLines();
  const from = $<HTMLSelectElement>('from');
  const to = $<HTMLSelectElement>('to');
  from.innerHTML = mapped(state.line).map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  to.innerHTML =
    '<option value="">— choose —</option>' +
    state.line.stations.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  // Default demo trips per line.
  const defaults: Record<string, [string, string]> = {
    elizabeth: ['tottenham-court-road', 'liverpool-street'],
    metropolitan: ['baker-street', 'liverpool-street'],
  };
  const [o, d] = defaults[state.line.id] ?? [mapped(state.line)[0]?.id, ''];
  state.origin = undefined;
  setTrip(o, d || null);
  $('credit').textContent = state.line.train.model ? `3D train: ${state.line.train.model.credit}` : '';
}

const NEED_ICONS: Record<Need, string> = {
  wheelchair: '♿',
  pram: '👶',
  luggage: '🧳',
  mobility: '🦯',
  visual: '👁',
  rush: '⏱',
  quiet: '🤫',
};

function renderNeeds() {
  const host = $('needs');
  host.innerHTML = '';
  for (const [need, text] of Object.entries(NEED_LABELS) as [Need, string][]) {
    const b = document.createElement('button');
    b.textContent = `${NEED_ICONS[need]} ${text}`;
    b.setAttribute('aria-pressed', String(state.needs.has(need)));
    b.onclick = () => {
      if (state.needs.has(need)) state.needs.delete(need);
      else state.needs.add(need);
      renderNeeds();
      replan(true);
    };
    host.appendChild(b);
  }
}

function renderExamples() {
  const examples = [
    "I'm at Liverpool Street going to Bond Street with a pram",
    'Tottenham Court Road to Paddington, I use a wheelchair',
    "I'm blind, at Bond Street, heading to Liverpool Street",
  ];
  const host = $('examples');
  for (const ex of examples) {
    const b = document.createElement('button');
    b.textContent = ex;
    b.onclick = () => {
      $<HTMLTextAreaElement>('askText').value = ex;
      ask({ text: ex });
    };
    host.appendChild(b);
  }
}

// ---------- Trip state ----------

function setTrip(originId?: string, destId?: string | null) {
  const origin = originId ? (findStation(state.line, originId) as MappedStation | undefined) : state.origin;
  const originChanged = origin?.id !== state.origin?.id;
  if (origin?.layout) state.origin = origin;
  if (destId !== undefined) state.destination = destId ? findStation(state.line, destId) : undefined;
  if (state.destination?.id === state.origin?.id) state.destination = undefined;

  $<HTMLSelectElement>('from').value = state.origin?.id ?? '';
  $<HTMLSelectElement>('to').value = state.destination?.id ?? '';

  const dir = state.origin ? directionBetween(state.origin, state.destination) : undefined;
  const dirChanged = !!dir && dir !== state.dir;
  if (dir) state.dir = dir;

  if (originChanged || dirChanged) {
    state.userX = undefined;
    state.photo = undefined;
    $('photoResult').hidden = true;
    rebuildScene();
  }
}

function rebuildScene() {
  if (!state.origin) return;
  scene.build(state.line, state.origin.layout, state.origin.name, state.dir);
  const near = $<HTMLSelectElement>('nearSelect');
  const seen = new Set<string>();
  near.innerHTML =
    '<option value="">— Not sure —</option>' +
    state.origin.layout.landmarks
      .filter((l) => l.type !== 'platform-end' && !seen.has(l.name) && seen.add(l.name))
      .map((l) => `<option value="${l.id}">${l.name.charAt(0).toUpperCase()}${l.name.slice(1)}</option>`)
      .join('');
  $('stationPill').textContent = `${state.origin.name} · ${state.dir === 'east' ? state.line.eastLabel : state.line.westLabel}`;
  $('locationStatus').textContent = 'Your position has not been located yet.';
  newTrain(true);
}

function simTime() {
  if ($<HTMLInputElement>('liveTime').checked) return new Date();
  const mins = Number($<HTMLInputElement>('timeSlider').value);
  const d = new Date();
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

function headwayS() {
  return demandAt(simTime()) > 0.6 ? 150 : 240;
}

function newTrain(first = false) {
  state.trainSeed = Math.floor(Math.random() * 1e9);
  state.arrivalAt = Date.now() + (first ? 40 : headwayS()) * 1000;
  replan(false);
}

// ---------- Planning ----------

function replan(announce: boolean) {
  if (!state.origin) return;
  const when = simTime();
  state.loads = estimateLoads(state.line, state.origin.layout, state.dir, when, state.trainSeed);
  state.rec = recommend(
    {
      line: state.line,
      origin: state.origin,
      destination: state.destination,
      dir: state.dir,
      needs: [...state.needs],
      userX: state.userX,
    },
    state.loads,
  );
  scene.setTarget(state.rec.targetX);
  scene.setLoads(state.loads, state.rec.car, state.trainSeed);
  scene.setPlatformCrowd(demandAt(when), state.trainSeed);
  scene.setUser(state.userX);
  const comfort = state.loads[state.rec.car - 1];
  $('comfortPill').textContent = `${comfort.freeSeats}/${comfort.seats} seats free · ${comfort.noiseDb} dB est.`;
  renderCars();
  $('demandPill').textContent = `${demandLabel(demandAt(when))} · ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (announce) guide();
  else showGuidance(baseFacts().short, state.rec.reasons);
}

function minutesToTrain() {
  return Math.max(0, Math.round((state.arrivalAt - Date.now()) / 60000));
}

function baseFacts() {
  const rec = state.rec!;
  const o = state.origin!;
  const m = minutesToTrain();
  const when = m <= 0 ? 'The next train is arriving now.' : `The next train is in about ${m} minute${m === 1 ? '' : 's'}.`;
  const dest = state.destination ? ` to ${state.destination.name}` : '';
  const short = state.destination
    ? `${rec.directions} ${when}`
    : `Where are you heading? Meanwhile, the quietest spot: ${rec.directions.charAt(0).toLowerCase()}${rec.directions.slice(1)}`;
  const facts = [
    `Passenger at ${o.name}, ${state.line.name}, travelling ${state.dir}bound${dest}.`,
    `Needs: ${[...state.needs].map((n) => NEED_LABELS[n]).join(', ') || 'none stated'}.`,
    when,
    `Directions: ${rec.directions}`,
    ...rec.reasons,
    state.photo ? `From their photo: ${state.photo.whatISee} Platform crowding looks ${state.photo.platformCrowding}.` : '',
    state.destination ? '' : 'Destination unknown: ask where they are going.',
  ]
    .filter(Boolean)
    .join('\n');
  return { short, facts };
}

async function guide() {
  if (!state.rec) return;
  const { short, facts } = baseFacts();
  let text = short;
  if (hasGeminiKey()) {
    setStatus('Gemini is writing directions…');
    try {
      text = await composeGuidance(facts, [...state.needs], state.language);
    } catch (e) {
      console.warn(e);
    }
    setStatus('');
  }
  showGuidance(text, state.rec.reasons);
  if ($<HTMLInputElement>('autoSpeak').checked) say(text);
}

function showGuidance(text: string, reasons: string[]) {
  $('sayText').textContent = text;
  state.lastSpoken = text;
  $('reasons').innerHTML = reasons.map((r) => `<li>${r}</li>`).join('');
}

function say(text: string) {
  if (!hasGeminiKey()) {
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-GB';
    speechSynthesis.speak(u);
    return;
  }
  speak(text);
}

function renderCars() {
  renderHero();
  renderMini();
}

// Side view with estimated seats and noise for each part of the train.
let miniYouCar: number | undefined;
// The car you're beside; past either end of the train, the end car nearest you.
function carNear(x: number) {
  const o = state.origin!;
  const t = state.line.train;
  const c = carAtX(o.layout, t, state.dir, x);
  if (c) return c;
  const d1 = Math.abs(carCentreX(o.layout, t, state.dir, 1) - x);
  const dn = Math.abs(carCentreX(o.layout, t, state.dir, t.cars) - x);
  return d1 < dn ? 1 : t.cars;
}

function renderMini() {
  const host = $('trainMini');
  if (!state.loads.length) return;
  if (!scene.walking) miniYouCar = state.userX !== undefined && state.origin ? carNear(state.userX) : undefined;
  const east = state.dir === 'east';
  const busiest = state.loads.reduce((a, b) => (b.load > a.load ? b : a));
  const calmest = state.loads.reduce((a, b) => (b.noiseDb < a.noiseDb ? b : a));
  const pct = (l: number) => `${Math.round(l * 100)}%`;
  const towards = east ? state.line.eastLabel : state.line.westLabel;
  host.innerHTML = `<div class="mhead"><span><b>${state.line.train.name}</b> · ${east ? '' : '◀ '}${towards.split(' (')[0]}${east ? ' ▶' : ''}</span><span><span class="busy">● Busiest area ${pct(busiest.load)}</span> &nbsp; <span class="quiet">● Calmest area ${calmest.noiseDb} dB est.</span></span></div>${trainSvg(
    {
      line: state.line,
      loads: state.loads,
      east,
      best: state.rec?.car,
      you: miniYouCar,
      color: (l) => `#${loadColor(l).getHexString()}`,
    },
  )}`;
  host.setAttribute(
    'aria-label',
    `Train comfort estimates. Busiest area ${pct(busiest.load)}. Calmest area ${calmest.noiseDb} decibels. Recommended waiting spot has ${state.loads[(state.rec?.car ?? 1) - 1].freeSeats} estimated free seats.`,
  );
}

function renderHero() {
  const rec = state.rec;
  if (!rec) return;
  $('heroSpot').textContent = rec.nearestLandmark.name;
  const s = Math.max(0, Math.round((state.arrivalAt - Date.now()) / 1000));
  const next = s > 0 ? `next train ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'train in platform';
  const walk = rec.distanceM !== undefined ? ` · ${rec.distanceM} m walk` : '';
  const comfort = state.loads[rec.car - 1];
  $('heroMeta').textContent = `${comfort.label} · ${comfort.freeSeats}/${comfort.seats} seats free · ${comfort.noiseDb} dB est. · ${next}${walk}`;
}

function setStatus(text: string) {
  $('status').textContent = text;
}

// ---------- Gemini actions ----------

async function ask(input: { text?: string; audio?: { base64: string; mimeType: string } }) {
  if (!hasGeminiKey()) {
    setStatus('Add VITE_GEMINI_API_KEY to .env.local to use voice and text. Use the menus for now.');
    return;
  }
  setStatus(input.audio ? 'Listening to your request…' : 'Understanding your request…');
  try {
    const intent = await parseRequest(input, state.line);
    state.language = intent.language || 'en-GB';
    if (input.audio) $<HTMLTextAreaElement>('askText').value = intent.transcript;
    state.needs = new Set(intent.needs);
    renderNeeds();
    const origin = findStation(state.line, intent.originStation);
    if (origin && !origin.layout) {
      setStatus('');
      const msg = `Sorry, I don't have a platform map for ${origin.name} yet. Try ${mapped(state.line).map((s) => s.name).join(', ')}, or rebuild it from photos.`;
      showGuidance(msg, []);
      if ($<HTMLInputElement>('autoSpeak').checked) say(msg);
      return;
    }
    setTrip(origin?.id, intent.destinationStation ? (findStation(state.line, intent.destinationStation)?.id ?? null) : undefined);
    setStatus('');
    replan(true);
  } catch (e) {
    console.error(e);
    setStatus(`Gemini error: ${(e as Error).message}`);
  }
}

async function handlePhoto(source: Blob | HTMLVideoElement) {
  if (!state.origin) return;
  const img = await imageToMedia(source);
  $<HTMLImageElement>('photoThumb').src = img.url;
  $('photoResult').hidden = false;
  if (!hasGeminiKey()) {
    $('photoText').textContent = 'Add a Gemini API key to recognise photos.';
    return;
  }
  $('photoText').textContent = 'Gemini is looking at your photo…';
  try {
    const loc = await locateOnPlatform(img, state.origin);
    state.photo = loc;
    if (loc.recognised && loc.estimatedXM !== null) {
      state.userX = Math.min(state.origin.layout.lengthM, Math.max(0, loc.estimatedXM));
      state.userSource = 'photo';
      $('photoText').textContent = `${loc.whatISee} (confidence ${Math.round(loc.confidence * 100)}%)`;
      replan(true);
      scene.eyeLevel();
    } else {
      $('photoText').textContent = `${loc.whatISee} I couldn't match this to the ${state.origin.name} platform. Try a photo showing a sign, roundel or exit.`;
    }
  } catch (e) {
    console.error(e);
    $('photoText').textContent = `Gemini error: ${(e as Error).message}`;
  }
}

async function handleRebuild(files: FileList) {
  if (!state.origin || !files.length) return;
  if (!hasGeminiKey()) return setStatus('Add a Gemini API key to rebuild platforms from photos.');
  setStatus(`Gemini is mapping ${files.length} photos…`);
  try {
    const photos = await Promise.all([...files].map((f) => imageToMedia(f, 1024)));
    const layout = await rebuildPlatform(photos, state.origin.name);
    state.origin.layout = layout;
    state.userX = undefined;
    rebuildScene();
    setStatus(`Rebuilt ${state.origin.name} with ${layout.landmarks.length - 2} landmarks from your photos.`);
  } catch (e) {
    console.error(e);
    setStatus(`Gemini error: ${(e as Error).message}`);
  }
}

// ---------- Live simulation loop ----------

function tick() {
  const now = Date.now();
  const s = (now - state.arrivalAt) / 1000;
  let phase: TrainPhase = { phase: 'away' };
  let text: string;
  if (s < -APPROACH_S) {
    const left = Math.ceil(-s);
    text = `Next train ${left >= 60 ? `${Math.floor(left / 60)} min ${left % 60}s` : `${left}s`}`;
  } else if (s < 0) {
    phase = { phase: 'approach', p: 1 + s / APPROACH_S };
    text = 'Train approaching';
  } else if (s < DWELL_S) {
    // Hold the doors (up to 30 s) while the walking passenger is at the door but not yet on.
    if (walk.arrived && !state.boarded && s > DWELL_S * 0.8 && walk.held < 30) {
      walk.held += 0.1;
      state.arrivalAt += 100;
    }
    phase = { phase: 'dwell', p: s / DWELL_S };
    text = 'Doors open';
  } else if (s < DWELL_S + DEPART_S) {
    phase = { phase: 'depart', p: (s - DWELL_S) / DEPART_S };
    text = 'Departing';
  } else if (state.boarded) {
    phase = { phase: 'depart', p: 1 };
    text = 'On your way';
  } else {
    newTrain();
    text = 'Next train updated';
  }
  scene.setTrainPhase(phase);
  $('trainPill').textContent = text;
  renderHero();
}

// ---------- Wiring ----------

// "What's next to you?": locate yourself by a landmark you can see (platforms have no car numbers).
$<HTMLSelectElement>('nearSelect').onchange = (e) => {
  const id = (e.target as HTMLSelectElement).value;
  const lm = state.origin?.layout.landmarks.find((l) => l.id === id);
  if (!lm) {
    if (state.userSource === 'landmark') {
      state.userX = undefined;
      state.userSource = undefined;
      $('locationStatus').textContent = 'Your position has not been located yet.';
    }
  } else {
    state.userX = lm.xM;
    state.userSource = 'landmark';
    state.pickedName = lm.name;
    $('locationStatus').textContent = `Located near ${lm.name}.`;
  }
  replan(true);
};

// Local demo fallback: emulate a positioning service within a realistic walk of the
// suggested boarding area. Alternating sides still exercises different train sections.
let lastSimulatedSide = 1;
$('simulateLocationBtn').onclick = () => {
  if (!state.origin) return;
  lastSimulatedSide *= -1;
  const target = state.rec?.targetX ?? state.origin.layout.lengthM / 2;
  const walkM = 15 + Math.random() * 35;
  state.userX = Math.max(3, Math.min(state.origin.layout.lengthM - 3, target + lastSimulatedSide * walkM));
  state.userSource = 'simulated';
  const landmark = state.origin.layout.landmarks
    .filter((l) => l.type !== 'platform-end')
    .reduce((a, b) => Math.abs(b.xM - state.userX!) < Math.abs(a.xM - state.userX!) ? b : a);
  state.pickedName = landmark.name;
  $('locationStatus').textContent = `Simulated position: near ${landmark.name}. Run again to test another part of the platform.`;
  $<HTMLSelectElement>('nearSelect').value = '';
  replan(true);
  scene.eyeLevel();
};

$('swapBtn').onclick = () => {
  const dest = state.destination;
  if (!state.origin || !dest?.layout) return setStatus(dest ? `No platform map for ${dest.name} yet.` : 'Choose a destination first.');
  setTrip(dest.id, state.origin.id);
  replan(true);
};
$<HTMLSelectElement>('from').onchange = (e) => {
  setTrip((e.target as HTMLSelectElement).value);
  replan(true);
};
$<HTMLSelectElement>('to').onchange = (e) => {
  setTrip(undefined, (e.target as HTMLSelectElement).value || null);
  replan(true);
};
$('askBtn').onclick = () => {
  const text = $<HTMLTextAreaElement>('askText').value.trim();
  if (text) ask({ text });
};
$<HTMLTextAreaElement>('askText').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('askBtn').click();
  }
};
$('micBtn').onclick = async () => {
  const btn = $('micBtn');
  try {
    if (!recorder.recording) {
      stopSpeaking();
      await recorder.start();
      btn.setAttribute('aria-pressed', 'true');
      btn.textContent = '⏹ Stop';
      setStatus('Recording… press Stop when done.');
    } else {
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = '🎤 Speak';
      const audio = await recorder.stop();
      ask({ audio });
    }
  } catch (e) {
    setStatus(`Microphone error: ${(e as Error).message}`);
  }
};
// Ctrl+Space toggles the microphone when focus is not in a text field (handy for screen-reader users).
document.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (e.code === 'Space' && e.ctrlKey && !['TEXTAREA', 'INPUT'].includes(tag)) {
    e.preventDefault();
    $('micBtn').click();
  }
});

$<HTMLInputElement>('photoInput').onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) handlePhoto(file);
  (e.target as HTMLInputElement).value = '';
};
$<HTMLInputElement>('rebuildInput').onchange = (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (files) handleRebuild(files);
  (e.target as HTMLInputElement).value = '';
};

let closeCamera: (() => void) | undefined;
$('cameraBtn').onclick = async () => {
  try {
    $('cameraBox').hidden = false;
    closeCamera = await openCamera($<HTMLVideoElement>('video'));
  } catch (e) {
    $('cameraBox').hidden = true;
    setStatus(`Camera error: ${(e as Error).message}`);
  }
};
$('captureBtn').onclick = () => handlePhoto($<HTMLVideoElement>('video'));
$('closeCamBtn').onclick = () => {
  closeCamera?.();
  $('cameraBox').hidden = true;
};

function setView(v: string) {
  if (v === 'overview') scene.overview();
  if (v === 'eye') scene.eyeLevel();
  if (v === 'train') scene.trainView();
  if (v === 'walk') startWalkDemo();
  const walking = v === 'walk';
  $('walkPad').hidden = !walking;
  $('walkHint').hidden = !walking;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  if (walking) $('scene').focus();
  else renderMini();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) b.onclick = () => setView(b.dataset.view!);

// ---------- Walk to the train: turn-by-turn guidance ending on board ----------

const walk = {
  arrived: false,
  doorsAnnounced: false,
  lastTurn: '' as Turn | '',
  lastCue: 0,
  held: 0,
};

// Where the passenger walks onto the platform: from the photo if we have one, otherwise
// the lift (step-free needs) or the nearest street exit / interchange to the spot.
function walkEntry() {
  const o = state.origin!;
  const rec = state.rec!;
  void rec;
  if (state.userX !== undefined && state.userSource === 'photo') return { x: state.userX, name: 'the spot in your photo' };
  if (state.userX !== undefined && ['landmark', 'simulated'].includes(state.userSource ?? '')) return { x: state.userX, name: state.pickedName ?? 'your located position' };
  // People reach the platform by different stairs, lifts and passages: pick one at random.
  const stepFree = ['wheelchair', 'pram', 'luggage', 'mobility'].some((n) => state.needs.has(n as Need));
  const types = stepFree ? ['lift'] : ['exit', 'interchange', 'entrance', 'lift', 'escalator'];
  const options = o.layout.landmarks.filter((l) => types.includes(l.type));
  const pick = options[Math.floor(Math.random() * options.length)];
  return pick ? { x: pick.xM, name: pick.name } : { x: o.layout.lengthM / 2, name: 'the platform entrance' };
}

function routeSummary(entry: { x: number; name: string }) {
  const rec = state.rec!;
  const o = state.origin!;
  const lo = Math.min(entry.x, rec.targetX);
  const hi = Math.max(entry.x, rec.targetX);
  const towardsEast = rec.targetX > entry.x;
  const passing = o.layout.landmarks
    .filter((l) => l.xM > lo + 1 && l.xM < hi - 1 && ['bench', 'help-point', 'roundel', 'interchange', 'lift', 'exit'].includes(l.type))
    .sort((a, b) => (towardsEast ? a.xM - b.xM : b.xM - a.xM))
    .slice(0, 2)
    .map((l) => `the ${l.name}`);
  // x grows to the east; standing with your back to the wall facing the track (+z), +x is on your left.
  const side = towardsEast ? 'left' : 'right';
  const metres = Math.round(Math.abs(rec.targetX - entry.x));
  const past = passing.length ? `, past ${passing.join(' and ')},` : '';
  return `You're near ${entry.name}. Turn ${side} and walk about ${metres} metres along the platform${past}. Stop at the green circle by the doors.`;
}

function startWalkDemo() {
  if (!state.origin || !state.rec) return;
  state.boarded = false;
  $('doneCard').hidden = true;
  Object.assign(walk, { arrived: false, doorsAnnounced: false, lastTurn: '', lastCue: 0, held: 0 });
  const entry = walkEntry();
  // The recommendation takes where you start into account (a closer good car beats a far one).
  if (!['photo', 'landmark', 'simulated'].includes(state.userSource ?? '')) {
    state.userX = entry.x;
    state.userSource = 'entrance';
  }
  replan(false);
  scene.startWalk(entry.x);
  miniYouCar = carNear(entry.x);
  renderMini();
  speakCue(routeSummary(entry), true);
}

// Short spoken cues use the browser voice so they come instantly while walking.
function speakCue(text: string, important = false) {
  if (!$<HTMLInputElement>('autoSpeak').checked) return;
  const now = Date.now();
  if (!important && now - walk.lastCue < 2500) return;
  walk.lastCue = now;
  if (important && hasGeminiKey()) return say(text);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-GB';
  speechSynthesis.speak(u);
}

scene.onWalk = (info) => {
  if (info.boarded) return;
  // Which car you are standing next to, for the train thumbnail.
  const youCar = state.origin ? carNear(info.stationX) : undefined;
  if (youCar !== miniYouCar) {
    miniYouCar = youCar;
    renderMini();
  }
  const hint = $('walkHint');
  const secs = Math.round((state.arrivalAt - Date.now()) / 1000);
  let main: string;
  let sub = '';
  if (info.arrived && info.doorsOpen) {
    walk.arrived = true;
    main = '▲ Doors open — step forward to board';
    if (!walk.doorsAnnounced) {
      walk.doorsAnnounced = true;
      speakCue('The doors are open. Step forward to board.', true);
    }
  } else if (info.arrived) {
    main = '✓ Stop here · the train doors will open in front of you';
    sub = secs > 0 ? `Train arriving in ${secs} s · stand behind the yellow line` : 'Train arriving';
    if (!walk.arrived) {
      walk.arrived = true;
      // Demo pacing: bring the next train in shortly once you're in place.
      if (secs > 20) state.arrivalAt = Date.now() + 15000;
      speakCue('Stop here. The train doors will open in front of you. The train is arriving shortly.', true);
    }
  } else {
    if (info.distance > 2.5) walk.arrived = false;
    const close = info.along <= 1.5;
    const arrow = { ahead: '↑', left: '←', right: '→', around: '↓' }[info.turn];
    const m = Math.max(1, Math.round(close ? info.distance : info.along));
    main = close
      ? `${arrow} The green circle is ${m} m ${info.turn === 'ahead' ? 'ahead' : info.turn === 'around' ? 'behind you' : `to your ${info.turn}`}`
      : info.turn === 'ahead'
        ? `↑ Keep walking · ${m} m to the waiting spot`
        : `${arrow} Turn ${info.turn === 'around' ? 'around' : info.turn}, then walk ${m} m`;
    if (info.next) sub = `Next: ${info.next.name} in ${Math.round(info.next.distance)} m`;
    if (info.passed) speakCue(`Passing the ${info.passed}. ${m} metres to go.`);
    if (info.turn === 'around' && walk.lastTurn === 'ahead') speakCue("You've gone past it. Turn around.");
    walk.lastTurn = info.turn;
  }
  hint.innerHTML = `<strong>${main}</strong>${sub ? `<small>${sub}</small>` : ''}`;
  hint.classList.toggle('ok', info.arrived);
};

scene.onBoard = (car) => {
  state.boarded = true;
  const dest = state.destination?.name;
  const wheelchair = state.line.train.wheelchairCars.includes(car);
  $('doneTitle').textContent = "You're on board";
  $('doneText').textContent = [
    dest ? `Next stop on the way to ${dest}.` : '',
    'You boarded from the guided waiting spot.',
    wheelchair ? 'The wheelchair and buggy space is just inside these doors.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  $('doneCard').hidden = false;
  $('walkHint').hidden = true;
  speakCue(`You're on board. ${wheelchair ? 'The wheelchair and buggy space is just inside the doors. ' : ''}${dest ? `Have a good journey to ${dest}.` : ''}`, true);
  // Ride along for a few seconds, then the demo ends back on the overview.
  setTimeout(() => {
    $('doneCard').classList.add('fade');
    setTimeout(() => {
      $('doneCard').hidden = true;
      $('doneCard').classList.remove('fade');
      state.boarded = false;
      setView('overview');
      newTrain(true);
    }, 600);
  }, 5000);
};

// On-screen arrow pad: press and hold.
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-key]')) {
  const key = b.dataset.key!;
  b.onpointerdown = (e) => {
    e.preventDefault();
    scene.setKey(key, true);
  };
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) b.addEventListener(ev, () => scene.setKey(key, false));
}
$('skipBtn').onclick = () => {
  // Jump to a few seconds before the next arrival.
  state.arrivalAt = Date.now() + (APPROACH_S + 2) * 1000;
};
$('repeatBtn').onclick = () => say(state.lastSpoken);
$<HTMLInputElement>('contrast').onchange = (e) => document.body.classList.toggle('contrast', (e.target as HTMLInputElement).checked);

const updateTimeOut = () => {
  const m = Number($<HTMLInputElement>('timeSlider').value);
  $('timeOut').textContent = $<HTMLInputElement>('liveTime').checked
    ? ''
    : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
$<HTMLInputElement>('liveTime').onchange = (e) => {
  $<HTMLInputElement>('timeSlider').disabled = (e.target as HTMLInputElement).checked;
  updateTimeOut();
  replan(false);
};
$<HTMLInputElement>('timeSlider').oninput = () => {
  updateTimeOut();
  replan(false);
};

renderNeeds();
renderExamples();
selectLine('elizabeth');
if (!hasGeminiKey()) setStatus('Demo mode: no Gemini key found. Menus and 3D work; add a key for voice, text and photos.');
setInterval(tick, 100);

// Debug / screenshot helpers: ?view=overview|eye|walk|train and ?train=here.
const params = new URLSearchParams(location.search);
if (params.get('line')) selectLine(params.get('line')!);
if (params.get('train') === 'here') state.arrivalAt = Date.now() - 4000;
const view = params.get('view');
if (view) {
  setTimeout(() => {
    setView(view);
    scene.snap();
  }, 1200);
}
// ?hold=ArrowRight:2000 holds a walk key for a while (for testing walk mode headlessly).
const hold = params.get('hold');
if (hold) {
  const [key, ms] = hold.split(':');
  setTimeout(() => {
    scene.setKey(key, true);
    setTimeout(() => scene.setKey(key, false), Number(ms));
  }, 1500);
}
// ?needs=pram,luggage preselects access needs.
const needsParam = params.get('needs');
if (needsParam) {
  state.needs = new Set(needsParam.split(',') as Need[]);
  renderNeeds();
  replan(false);
}
// ?autowalk=1 follows the guidance automatically (testing, or a hands-free demo).
if (params.get('autowalk')) {
  const keys = ['ArrowUp', 'ArrowLeft', 'ArrowRight'];
  const onWalk = scene.onWalk!;
  scene.onWalk = (info) => {
    onWalk(info);
    for (const k of keys) scene.setKey(k, false);
    if (info.boarded) return;
    if (info.arrived && !info.doorsOpen) return;
    if (info.arrived) return scene.setKey('ArrowUp', true);
    if (info.turn === 'left' || info.turn === 'around') scene.setKey('ArrowLeft', true);
    else if (info.turn === 'right') scene.setKey('ArrowRight', true);
    else scene.setKey('ArrowUp', true);
  };
}
// ?atspot=1 starts walk mode already on the wait spot (testing the boarding step).
if (params.get('atspot')) setTimeout(() => scene.debugPlaceAtTarget(), 1300);
if (params.get('speed')) scene.speedScale = Number(params.get('speed'));
// ?board=1 boards as soon as the doors open (testing the ending).
if (params.get('board')) {
  setTimeout(() => {
    const timer = setInterval(() => scene.debugBoard() && clearInterval(timer), 300);
  }, 2000);
}
