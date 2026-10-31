// Picks the best place to wait and turns it into landmark-based directions.

import {
  carCentreX,
  carStartFromFront,
  doorOffsetsInCar,
  fromFrontToX,
  type Direction,
  type Landmark,
  type Line,
  type PlatformLayout,
  type Station,
} from '../data/network';
import type { CarLoad } from './crowding';

export type Need = 'wheelchair' | 'pram' | 'luggage' | 'mobility' | 'visual' | 'rush' | 'quiet';

export const NEED_LABELS: Record<Need, string> = {
  wheelchair: 'Wheelchair',
  pram: 'Pram / buggy',
  luggage: 'Large luggage',
  mobility: 'Limited mobility',
  visual: 'Visual impairment',
  rush: 'In a hurry',
  quiet: 'Need a quiet space',
};

const STEP_FREE_NEEDS: Need[] = ['wheelchair', 'pram', 'luggage', 'mobility'];

interface Weights {
  crowd: number;
  dest: number;
  walk: number;
  quiet: number;
}

const WEIGHTS: Record<Need | 'default', Weights> = {
  default: { crowd: 0.6, dest: 0.8, walk: 0.3, quiet: 0 },
  rush: { crowd: 0.3, dest: 1.2, walk: 0.5, quiet: 0 },
  wheelchair: { crowd: 0.7, dest: 0.8, walk: 0.5, quiet: 0 },
  pram: { crowd: 0.9, dest: 0.7, walk: 0.4, quiet: 0 },
  luggage: { crowd: 1.0, dest: 0.6, walk: 0.4, quiet: 0 },
  mobility: { crowd: 0.9, dest: 0.6, walk: 0.9, quiet: 0 },
  visual: { crowd: 0.6, dest: 0.4, walk: 1.1, quiet: 0 },
  quiet: { crowd: 0.8, dest: 0.35, walk: 0.35, quiet: 1.5 },
};

export interface Trip {
  line: Line;
  origin: Station & { layout: PlatformLayout };
  destination?: Station;
  dir: Direction;
  needs: Need[];
  // Where the user currently is on the platform, if known (station x in metres).
  userX?: number;
}

export interface Recommendation {
  car: number;
  targetX: number;
  load: number;
  reasons: string[];
  destTarget?: Landmark;
  nearestLandmark: Landmark;
  directions: string;
  distanceM?: number;
  scores: { car: number; score: number }[];
}

export function directionBetween(origin: Station, destination?: Station): Direction | undefined {
  if (!destination || destination.order === origin.order) return undefined;
  return destination.order > origin.order ? 'east' : 'west';
}

export function recommend(trip: Trip, loads: CarLoad[]): Recommendation {
  const { line, origin, destination, dir, needs, userX } = trip;
  const { train } = line;
  const layout = origin.layout;
  const w = combineWeights(needs);
  const stepFree = needs.some((n) => STEP_FREE_NEEDS.includes(n));

  // Where the user wants to come out at the other end.
  const destLayout = destination?.layout;
  const destTarget = destLayout ? pickDestinationTarget(destLayout, stepFree) : undefined;

  const scores = loads.map(({ car, load, noiseDb }) => {
    let score = w.crowd * (1 - load);
    score += w.quiet * (1 - (noiseDb - 52) / 26);
    if (destLayout && destTarget) {
      const d = Math.abs(carCentreX(destLayout, train, dir, car) - destTarget.xM);
      score += w.dest * Math.exp(-d / 60);
    }
    const start = userX ?? defaultStartX(layout, stepFree);
    if (start !== undefined) {
      score += w.walk * Math.exp(-Math.abs(carCentreX(layout, train, dir, car) - start) / 70);
    }
    // The dedicated spaces outweigh a short level walk along the platform.
    const spaceCar = train.multiUseCars.includes(car) || train.wheelchairCars.includes(car);
    if (needs.includes('wheelchair')) score += train.wheelchairCars.includes(car) ? 2 : -0.5;
    if (needs.includes('pram')) score += spaceCar ? 1.3 : 0;
    else if (needs.includes('luggage')) score += spaceCar ? 0.7 : 0;
    return { car, score };
  });

  const best = scores.reduce((a, b) => (b.score > a.score ? b : a));
  const load = loads[best.car - 1].load;
  // Wait in front of the middle door of the chosen car.
  const doors = doorOffsetsInCar(train, best.car);
  const targetX = fromFrontToX(layout, train, dir, carStartFromFront(train, best.car) + doors[Math.floor(doors.length / 2)]);

  const reasons: string[] = [];
  reasons.push(`This part of the platform is expected to be ${loads[best.car - 1].label.toLowerCase()}.`);
  reasons.push(`Estimated ${loads[best.car - 1].freeSeats} free of ${loads[best.car - 1].seats} seats, around ${loads[best.car - 1].noiseDb} dB.`);
  if (needs.includes('quiet')) reasons.push('This is one of the calmer estimated areas for passengers who are sensitive to noise.');
  if (train.wheelchairCars.includes(best.car)) reasons.push(`It's the ${train.carTypes[best.car - 1]} car with the wheelchair spaces and extra tip-up seats.`);
  else if (train.multiUseCars.includes(best.car)) reasons.push('It has a multi-use area for prams and luggage.');
  if (destTarget && destination) reasons.push(`It stops close to the ${destTarget.name} at ${destination.name}.`);
  if (layout.screenDoors) reasons.push('This platform has screen doors and level boarding.');

  const nearestLandmark = nearestTo(layout, targetX);
  const { text, distanceM } = describeWalk(dir, targetX, nearestLandmark, userX);

  return { car: best.car, targetX, load, reasons, destTarget, nearestLandmark, directions: text, distanceM, scores };
}

function combineWeights(needs: Need[]): Weights {
  const list = needs.length ? needs.map((n) => WEIGHTS[n]) : [WEIGHTS.default];
  return {
    crowd: Math.max(...list.map((x) => x.crowd)),
    dest: Math.max(...list.map((x) => x.dest)),
    walk: Math.max(...list.map((x) => x.walk)),
    quiet: Math.max(...list.map((x) => x.quiet)),
  };
}

function pickDestinationTarget(layout: PlatformLayout, stepFree: boolean) {
  const types = stepFree ? ['lift'] : ['exit', 'interchange', 'escalator'];
  const candidates = layout.landmarks.filter((l) => types.includes(l.type));
  // With two candidate ends we cannot know which street exit they want; prefer the first listed.
  return candidates[0];
}

function defaultStartX(layout: PlatformLayout, stepFree: boolean) {
  const lift = layout.landmarks.find((l) => l.type === 'lift');
  if (stepFree && lift) return lift.xM;
  return undefined;
}

export function nearestTo(layout: PlatformLayout, x: number, exclude: string[] = ['platform-end']) {
  return layout.landmarks
    .filter((l) => !exclude.includes(l.type))
    .reduce((a, b) => (Math.abs(b.xM - x) < Math.abs(a.xM - x) ? b : a));
}

// Human directions. "Front" = the end the train is heading towards.
function describeWalk(
  dir: Direction,
  targetX: number,
  landmark: Landmark,
  userX?: number,
) {
  const offset = Math.round(targetX - landmark.xM);
  const towardsFront = (delta: number) => (dir === 'east' ? delta > 0 : delta < 0);
  let at: string;
  if (Math.abs(offset) < 6) at = `right by the ${landmark.name}`;
  else {
    const side = towardsFront(offset) ? 'towards the front of the train' : 'towards the back of the train';
    at = `about ${Math.abs(offset)} metres past the ${landmark.name}, ${side}`;
  }

  if (userX === undefined) {
    return { text: `Wait ${at}.`, distanceM: undefined };
  }
  const delta = targetX - userX;
  const distanceM = Math.round(Math.abs(delta));
  if (distanceM < 8) return { text: `You're already in a good spot. Wait ${at}.`, distanceM };
  const heading = towardsFront(delta)
    ? `towards the front of the train (the ${dir === 'east' ? 'east' : 'west'} end)`
    : `towards the back of the train (the ${dir === 'east' ? 'west' : 'east'} end)`;
  const steps = Math.round(distanceM / 0.75);
  return { text: `Walk about ${distanceM} metres (roughly ${steps} steps) ${heading}, then wait ${at}.`, distanceM };
}
