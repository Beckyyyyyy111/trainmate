// Estimated per-car crowding. There is no public per-car loading feed, so this is a model:
// time-of-day demand, people bunching near entrances/interchanges where they board,
// emptier end cars, and per-train randomness so every simulated train is different.

import { carCentreX, type Direction, type Line, type PlatformLayout } from '../data/network';

export interface CarLoad {
  car: number; // 1-based from the front
  load: number; // 0..1
  label: string;
  seats: number;
  freeSeats: number;
  noiseDb: number;
}

// Demand at a given time, 0..1.
export function demandAt(date: Date): number {
  const day = date.getDay();
  const h = date.getHours() + date.getMinutes() / 60;
  const weekend = day === 0 || day === 6;
  const bump = (centre: number, width: number, height: number) =>
    height * Math.exp(-(((h - centre) / width) ** 2));
  if (weekend) return clamp(0.2 + bump(14, 4, 0.3), 0.1, 0.6);
  return clamp(0.18 + bump(8.4, 0.9, 0.75) + bump(17.8, 1.1, 0.7) + bump(13, 3, 0.15), 0.08, 0.98);
}

export function demandLabel(d: number) {
  if (d > 0.75) return 'Rush hour';
  if (d > 0.5) return 'Busy';
  if (d > 0.3) return 'Moderate';
  return 'Quiet';
}

export function loadLabel(load: number) {
  if (load < 0.35) return 'Seats likely';
  if (load < 0.6) return 'Standing room';
  if (load < 0.82) return 'Busy';
  return 'Very busy';
}

export function estimateLoads(
  line: Line,
  layout: PlatformLayout,
  dir: Direction,
  when: Date,
  trainSeed: number,
): CarLoad[] {
  const { train } = line;
  const demand = demandAt(when);
  const rand = mulberry32(trainSeed);
  const boardingPoints = layout.landmarks.filter((l) =>
    ['entrance', 'exit', 'interchange', 'escalator', 'lift'].includes(l.type),
  );

  return Array.from({ length: train.cars }, (_, i) => {
    const car = i + 1;
    const x = carCentreX(layout, train, dir, car);
    // Ends of the train are usually emptier than the middle.
    const t = train.cars > 1 ? i / (train.cars - 1) : 0.5;
    const profile = 1 - 0.4 * Math.abs(2 * t - 1) ** 1.4;
    // Passengers board close to where they walked onto the platform.
    const boarding = boardingPoints.reduce(
      (sum, p) => sum + (p.type === 'interchange' ? 0.22 : 0.12) * Math.exp(-(((x - p.xM) / 28) ** 2)),
      0,
    );
    const noise = (rand() - 0.5) * 0.22;
    const load = clamp(0.08 + 0.72 * demand * profile + boarding * demand + noise * (0.4 + demand), 0.04, 1);
    const seats = train.seatsPerCar[car - 1] ?? 40;
    const seatedRatio = clamp(load / 0.58, 0, 1);
    const freeSeats = Math.max(0, Math.round(seats * (1 - seatedRatio)));
    const powered = train.pantographCars.includes(car) || /M|PMS/.test(train.carTypes[car - 1] ?? '');
    const cab = car === 1 || car === train.cars;
    const noiseDb = Math.round(clamp(55 + load * 15 + (powered ? 4 : 0) + (cab ? 2 : 0) + (rand() - 0.5) * 4, 52, 78));
    return { car, load, label: loadLabel(load), seats, freeSeats, noiseDb };
  });
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
