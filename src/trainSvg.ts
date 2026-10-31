// Side-view thumbnail of the train, drawn to scale along its length in the line's livery.
// Each car's windows are tinted by how full it is, with passenger silhouettes inside.

import { carStartFromFront, doorOffsetsInCar, type Line } from './data/network';
import type { CarLoad } from './engine/crowding';

interface Livery {
  body: string;
  roof: string;
  windows: string;
  door: string;
  doorWindow: string;
  lower?: [string, string]; // gradient for the lower body band
  swoosh?: string;
  skirt?: string;
  cab: string;
}

const LIVERIES: Record<string, Livery> = {
  elizabeth: {
    body: '#f3f4f6',
    roof: '#c9ccd2',
    windows: '#151a24',
    door: '#d9dbde',
    doorWindow: '#10161d',
    lower: ['#5b68b4', '#323f86'],
    swoosh: '#8f6ccb',
    cab: '#0c0f13',
  },
  metropolitan: {
    body: '#f4f4f2',
    roof: '#b9bcc2',
    windows: '#151a24',
    door: '#d4252b',
    doorWindow: '#2a0c0d',
    skirt: '#1c3f94',
    cab: '#c81e24',
  },
};

export interface MiniOptions {
  line: Line;
  loads: CarLoad[];
  east: boolean; // eastbound trains are drawn heading right
  best?: number;
  you?: number;
  color: (load: number) => string;
}

const W = 1000;
const H = 180;
const TOP = 52; // roof line
const BOT = 114; // bottom of body

export function trainSvg(o: MiniOptions) {
  const { line, loads, east } = o;
  const train = line.train;
  const lv = LIVERIES[line.id] ?? LIVERIES.elizabeth;
  const total = train.carLengthsM.reduce((a, b) => a + b, 0);
  const scale = (W - 40) / total;
  const busiest = loads.reduce((a, b) => (b.load > a.load ? b : a));
  const quietest = loads.reduce((a, b) => (b.load < a.load ? b : a));
  const parts: string[] = [];
  const defs: string[] = [];

  if (lv.lower) {
    defs.push(`<linearGradient id="lower" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lv.lower[0]}"/><stop offset="1" stop-color="${lv.lower[1]}"/></linearGradient>`);
  }
  defs.push(`<filter id="glow" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);

  // Rail.
  parts.push(`<rect x="10" y="${BOT + 9}" width="${W - 20}" height="3" rx="1.5" fill="#3a3f48"/>`);

  for (const { car, load, seats, freeSeats, noiseDb } of loads) {
    const len = train.carLengthsM[car - 1] * scale;
    const fromFront = carStartFromFront(train, car) * scale;
    // x of this car's left edge, with the front of the train on the right when eastbound.
    const x0 = east ? W - 20 - fromFront - len : 20 + fromFront;
    const x1 = x0 + len - 3;
    const noseRight = (car === 1 && east) || (car === train.cars && !east);
    const noseLeft = (car === 1 && !east) || (car === train.cars && east);
    const isFront = car === 1;
    const fill = o.color(load);
    const best = car === o.best;

    // Body outline, with a sloped cab at either end of the train.
    const r = 7;
    const body = [
      `M ${noseLeft ? x0 + 18 : x0 + r} ${TOP}`,
      `H ${noseRight ? x1 - 18 : x1 - r}`,
      noseRight ? `Q ${x1 - 3} ${TOP + 2} ${x1} ${TOP + 24} V ${BOT - 5} Q ${x1} ${BOT} ${x1 - 5} ${BOT}` : `Q ${x1} ${TOP} ${x1} ${TOP + r} V ${BOT - r} Q ${x1} ${BOT} ${x1 - r} ${BOT}`,
      `H ${x0 + (noseLeft ? 5 : r)}`,
      noseLeft ? `Q ${x0} ${BOT} ${x0} ${BOT - 5} V ${TOP + 24} Q ${x0 + 3} ${TOP + 2} ${x0 + 18} ${TOP}` : `Q ${x0} ${BOT} ${x0} ${BOT - r} V ${TOP + r} Q ${x0} ${TOP} ${x0 + r} ${TOP}`,
      'Z',
    ].join(' ');
    if (best) parts.push(`<path d="${body}" fill="none" stroke="#4ade80" stroke-width="7" opacity="0.55" filter="url(#glow)"/>`);
    parts.push(`<path d="${body}" fill="${lv.body}"/>`);
    parts.push(`<clipPath id="c${car}"><path d="${body}"/></clipPath>`);
    const g: string[] = [];
    // Roof line.
    g.push(`<rect x="${x0}" y="${TOP}" width="${len}" height="5" fill="${lv.roof}"/>`);
    // Lower band (Elizabeth) or skirt (S8).
    if (lv.lower) g.push(`<rect x="${x0}" y="${BOT - 30}" width="${len}" height="30" fill="url(#lower)"/>`);
    if (lv.skirt) g.push(`<rect x="${x0}" y="${BOT - 8}" width="${len}" height="8" fill="${lv.skirt}"/>`);
    // Purple swoosh at the No.2 (rear) end of each car.
    if (lv.swoosh && car < train.cars) {
      const rearX = east ? x0 : x1;
      const d = east ? 1 : -1;
      g.push(`<path d="M ${rearX} ${BOT - 30} L ${rearX + d * 9} ${BOT - 30} L ${rearX + d * 3} ${BOT} L ${rearX} ${BOT} Z" fill="${lv.swoosh}"/>`);
    }
    // Window band, tinted by how full the car is, with passenger silhouettes.
    const wy = TOP + 10;
    const wh = 22;
    const wx0 = x0 + (noseLeft ? 22 : 4);
    const wx1 = x1 - (noseRight ? 22 : 4);
    g.push(`<rect x="${wx0}" y="${wy}" width="${wx1 - wx0}" height="${wh}" rx="3" fill="${lv.windows}"/>`);
    g.push(`<rect x="${wx0}" y="${wy}" width="${wx1 - wx0}" height="${wh}" rx="3" fill="${fill}" opacity="0.42"/>`);
    const people = Math.round(load * 12);
    for (let i = 0; i < people; i++) {
      const px = wx0 + ((i + 0.5) / people) * (wx1 - wx0) + (((i * 37) % 7) - 3);
      const tall = (i * 13) % 3;
      g.push(`<circle cx="${px}" cy="${wy + 7 + tall}" r="2.6" fill="#0b0d12" opacity="0.75"/>`);
      g.push(`<rect x="${px - 3}" y="${wy + 10 + tall}" width="6" height="${wh - 10 - tall}" rx="2.5" fill="#0b0d12" opacity="0.75"/>`);
    }
    // Doors.
    for (const off of doorOffsetsInCar(train, car)) {
      const cx = east ? x1 + 3 - off * scale : x0 + off * scale;
      const dw = Math.max(5, train.doorWidthM * scale);
      g.push(`<rect x="${cx - dw / 2}" y="${TOP + 7}" width="${dw}" height="${BOT - TOP - 9}" rx="1.5" fill="${lv.door}" stroke="#00000033" stroke-width="0.6"/>`);
      g.push(`<rect x="${cx - dw / 2 + 1.2}" y="${TOP + 11}" width="${dw / 2 - 1.8}" height="18" rx="1" fill="${lv.doorWindow}"/>`);
      g.push(`<rect x="${cx + 0.6}" y="${TOP + 11}" width="${dw / 2 - 1.8}" height="18" rx="1" fill="${lv.doorWindow}"/>`);
    }
    // Cab windscreen and lights.
    for (const [nose, right] of [[noseRight, true], [noseLeft, false]] as const) {
      if (!nose) continue;
      const ex = right ? x1 : x0;
      const s = right ? -1 : 1;
      g.push(`<path d="M ${ex + s * 18} ${TOP + 1} Q ${ex + s * 3} ${TOP + 3} ${ex + s * 0.5} ${TOP + 24} L ${ex + s * 0.5} ${TOP + 34} L ${ex + s * 16} ${TOP + 34} Z" fill="${lv.cab}"/>`);
      // Headlights on the leading cab, tail lights on the rear one.
      g.push(`<circle cx="${ex + s * 4}" cy="${BOT - 16}" r="2.4" fill="${isFront ? '#fff8d6' : '#ff3b30'}"/>`);
    }
    parts.push(`<g clip-path="url(#c${car})">${g.join('')}</g>`);
    if (best) parts.push(`<path d="${body}" fill="none" stroke="#4ade80" stroke-width="2.5"/>`);

    // Bogies.
    for (const bx of [x0 + len * 0.14, x1 - len * 0.14]) {
      parts.push(`<rect x="${bx - 11}" y="${BOT + 1}" width="22" height="5" rx="2" fill="#2a2d33"/>`);
      parts.push(`<circle cx="${bx - 6}" cy="${BOT + 7}" r="3.6" fill="#1b1d22"/><circle cx="${bx + 6}" cy="${BOT + 7}" r="3.6" fill="#1b1d22"/>`);
    }

    // Passenger-facing comfort estimates for each train area.
    const mid = (x0 + x1) / 2;
    parts.push(`<text x="${mid}" y="${TOP - 19}" text-anchor="middle" class="metric" fill="#eef1f6">${freeSeats}/${seats} free</text>`);
    parts.push(`<text x="${mid}" y="${TOP - 7}" text-anchor="middle" class="noise" fill="${noiseDb <= 62 ? '#4ade80' : noiseDb <= 69 ? '#fbbf24' : '#f87171'}">${noiseDb} dB</text>`);
    const badge = best ? ['★ Board here', '#22c55e', '#052e16'] : car === busiest.car ? ['Busiest', '#ef4444', '#fff'] : car === quietest.car ? ['Quietest', '#a7f3d0', '#064e3b'] : undefined;
    if (badge) {
      const bw = badge[0].length * 6.6 + 14;
      parts.push(`<rect x="${mid - bw / 2}" y="2" width="${bw}" height="17" rx="8.5" fill="${badge[1]}"/>`);
      parts.push(`<text x="${mid}" y="14.5" text-anchor="middle" class="badge" fill="${badge[2]}">${badge[0]}</text>`);
    }
    if (car === o.you) {
      parts.push(`<path d="M ${mid} ${BOT + 14} l 6 8 h -6 z M ${mid} ${BOT + 14} l -6 8 h 6 z" fill="#3b82f6"/>`);
      parts.push(`<rect x="${mid - 18}" y="${BOT + 21}" width="36" height="17" rx="8.5" fill="#3b82f6"/>`);
      parts.push(`<text x="${mid}" y="${BOT + 33.5}" text-anchor="middle" class="badge" fill="#fff">You</text>`);
    }
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}
