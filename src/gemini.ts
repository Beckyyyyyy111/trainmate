import { GoogleGenAI, type Part } from '@google/genai';
import { GEMINI_API_KEY, MODELS, TTS_VOICE, hasGeminiKey } from './config';
import type { Landmark, LandmarkType, Line, PlatformLayout, Station } from './data/network';
import type { Need } from './engine/recommend';

let client: GoogleGenAI | undefined;
const ai = () => {
  if (!hasGeminiKey()) throw new Error('Missing VITE_GEMINI_API_KEY in .env.local');
  return (client ??= new GoogleGenAI({ apiKey: GEMINI_API_KEY }));
};

export interface InlineMedia {
  base64: string;
  mimeType: string;
}

async function askJson<T>(parts: Part[], schema: object, system: string): Promise<T> {
  const res = await ai().models.generateContent({
    model: MODELS.flash,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      temperature: 0.2,
    },
  });
  const text = res.text;
  if (!text) throw new Error('Gemini returned an empty response');
  return JSON.parse(text) as T;
}

const media = (m: InlineMedia): Part => ({ inlineData: { data: m.base64, mimeType: m.mimeType } });

// ---------- 1. Understand the request (typed or spoken) ----------

export interface Intent {
  transcript: string;
  originStation: string | null;
  destinationStation: string | null;
  needs: Need[];
  language: string;
}

export async function parseRequest(input: { text?: string; audio?: InlineMedia }, line: Line): Promise<Intent> {
  const stations = line.stations.map((s) => s.name).join(', ');
  const parts: Part[] = [];
  if (input.audio) parts.push(media(input.audio), { text: 'The passenger said this (audio above).' });
  if (input.text) parts.push({ text: `The passenger typed: "${input.text}"` });
  return askJson<Intent>(
    parts,
    {
      type: 'object',
      properties: {
        transcript: { type: 'string', description: 'Verbatim transcript or the typed text' },
        originStation: { type: ['string', 'null'], description: 'Exact station name from the list, or null' },
        destinationStation: { type: ['string', 'null'], description: 'Exact station name from the list, or null' },
        needs: {
          type: 'array',
          items: { type: 'string', enum: ['wheelchair', 'pram', 'luggage', 'mobility', 'visual', 'rush', 'quiet'] },
        },
        language: { type: 'string', description: 'BCP-47 code of the language the passenger used' },
      },
      required: ['transcript', 'originStation', 'destinationStation', 'needs', 'language'],
    },
    `You help passengers on the London ${line.name}. Extract where they are, where they are going and any
access needs. Only use these station names: ${stations}. Map synonyms: buggy/stroller/baby -> pram,
suitcase/bags -> luggage, blind/low vision -> visual, crutches/walking stick/elderly -> mobility,
late/hurry -> rush, autistic/autism/sensory/noise-sensitive/quiet -> quiet.`,
  );
}

// ---------- 2. Where am I on the platform? (camera / photo) ----------

export interface PhotoLocation {
  recognised: boolean;
  matchedLandmarkIds: string[];
  estimatedXM: number | null;
  confidence: number;
  whatISee: string;
  platformCrowding: 'empty' | 'light' | 'moderate' | 'busy' | 'packed' | 'unknown';
}

export async function locateOnPlatform(photo: InlineMedia, station: Station & { layout: PlatformLayout }) {
  const landmarks = station.layout.landmarks
    .map((l) => `- id=${l.id} | ${l.name} | type=${l.type} | ${l.xM} m from the west end`)
    .join('\n');
  return askJson<PhotoLocation>(
    [
      media(photo),
      {
        text: `This photo was taken on the ${station.name} platform. Known platform landmarks (west end = 0 m, east end = ${station.layout.lengthM} m):
${landmarks}
Work out which of these landmarks are visible and close to the camera, and estimate where along the platform the photographer stands.`,
      },
    ],
    {
      type: 'object',
      properties: {
        recognised: { type: 'boolean', description: 'False if this is not a platform photo or nothing matches' },
        matchedLandmarkIds: { type: 'array', items: { type: 'string' } },
        estimatedXM: { type: ['number', 'null'] },
        confidence: { type: 'number', description: '0 to 1' },
        whatISee: { type: 'string', description: 'One short sentence describing what is visible, for a blind user' },
        platformCrowding: { type: 'string', enum: ['empty', 'light', 'moderate', 'busy', 'packed', 'unknown'] },
      },
      required: ['recognised', 'matchedLandmarkIds', 'estimatedXM', 'confidence', 'whatISee', 'platformCrowding'],
    },
    'You are a careful visual guide for passengers on London underground platforms. Never invent landmarks that are not in the list. Read signs, roundels, exit signs, lifts and benches in the photo.',
  );
}

// ---------- 3. Rebuild a platform layout from photos ----------

interface RebuiltPlatform {
  lengthM: number;
  curved: boolean;
  screenDoors: boolean;
  wallColor: string;
  landmarks: { name: string; type: LandmarkType; xM: number }[];
}

export async function rebuildPlatform(photos: InlineMedia[], stationName: string): Promise<PlatformLayout> {
  const types: LandmarkType[] = [
    'entrance', 'exit', 'interchange', 'lift', 'escalator', 'bench', 'roundel', 'sign', 'help-point', 'wheelchair-mark',
  ];
  const r = await askJson<RebuiltPlatform>(
    [
      ...photos.map(media),
      {
        text: `These ${photos.length} photos were taken walking along one platform at ${stationName}, in order from the west end to the east end.
Build an approximate map of the platform: every landmark you can see with an estimated distance from the west end in metres.`,
      },
    ],
    {
      type: 'object',
      properties: {
        lengthM: { type: 'number', description: 'Estimated platform length in metres (Elizabeth line is about 250)' },
        curved: { type: 'boolean' },
        screenDoors: { type: 'boolean' },
        wallColor: { type: 'string', description: 'Dominant wall colour as a #rrggbb hex' },
        landmarks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: types },
              xM: { type: 'number' },
            },
            required: ['name', 'type', 'xM'],
          },
        },
      },
      required: ['lengthM', 'curved', 'screenDoors', 'wallColor', 'landmarks'],
    },
    'You turn photos of London underground platforms into structured maps. Be conservative: only include landmarks you can actually see.',
  );
  const lengthM = Math.min(300, Math.max(80, r.lengthM || 250));
  const landmarks: Landmark[] = [
    { id: 'end-w', name: 'West end of platform', type: 'platform-end', xM: 0 },
    ...r.landmarks.map((l, i) => ({ ...l, id: `photo-${i}`, xM: Math.min(lengthM, Math.max(0, l.xM)) })),
    { id: 'end-e', name: 'East end of platform', type: 'platform-end', xM: lengthM },
  ];
  return {
    lengthM,
    curved: r.curved,
    screenDoors: r.screenDoors,
    wallColor: /^#[0-9a-f]{6}$/i.test(r.wallColor) ? r.wallColor : '#cfd2d6',
    landmarks,
  };
}

// ---------- 4. Friendly spoken guidance ----------

export async function composeGuidance(facts: string, needs: Need[], language: string): Promise<string> {
  const res = await ai().models.generateContent({
    model: MODELS.flash,
    contents: [{ role: 'user', parts: [{ text: facts }] }],
    config: {
      temperature: 0.5,
      systemInstruction: `You are TrainMate, a calm, warm guide on the London Underground and Elizabeth line.
Rewrite the facts into 2 to 4 short spoken sentences in language "${language}".
Lead with the action (where to walk and wait). Mention landmarks, not car numbers, as the main cue.
${needs.includes('visual') ? 'The passenger is blind or has low vision: give step counts, mention tactile paving and the platform edge, never rely on colours or "over there".' : ''}
No markdown, no lists. Never invent facts that are not given.`,
    },
  });
  return res.text?.trim() || facts;
}

// ---------- 5. Expressive speech ----------

let audioCtx: AudioContext | undefined;
let currentSource: AudioBufferSourceNode | undefined;

export function stopSpeaking() {
  currentSource?.stop();
  currentSource = undefined;
  speechSynthesis.cancel();
}

export async function speak(text: string, style = 'calm, warm and clear, like a friendly station assistant') {
  stopSpeaking();
  try {
    const res = await ai().models.generateContent({
      model: MODELS.tts,
      contents: [{ role: 'user', parts: [{ text: `Say in a ${style} voice: ${text}` }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
      },
    });
    const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!data?.data) throw new Error('No audio returned');
    await playAudio(data.data, data.mimeType ?? 'audio/L16;rate=24000');
  } catch (err) {
    console.warn('Gemini TTS failed, using browser speech', err);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-GB';
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }
}

async function playAudio(base64: string, mimeType: string) {
  audioCtx ??= new AudioContext();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  let buffer: AudioBuffer;
  if (/wav|mpeg|mp3|ogg/i.test(mimeType)) {
    buffer = await audioCtx.decodeAudioData(bytes.buffer);
  } else {
    // Raw 16-bit little-endian mono PCM.
    const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
    const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
    buffer = audioCtx.createBuffer(1, samples.length, rate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);
  currentSource = src;
  src.start();
}
