// Network, train and platform data for the demo.
//
// Station layouts are ILLUSTRATIVE: the exit names at each end are real, but landmark
// positions are estimates and must be checked on site (or rebuilt from photos with
// the "Rebuild from photos" feature) before anyone relies on them.
//
// Coordinates: every station is described along its platform from the WEST end (xM = 0)
// to the EAST end (xM = lengthM). Eastbound and westbound platforms are assumed to mirror
// each other, which holds for the Elizabeth line's central section stations.

export type LandmarkType =
  | 'entrance'
  | 'exit'
  | 'interchange'
  | 'lift'
  | 'escalator'
  | 'bench'
  | 'roundel'
  | 'sign'
  | 'help-point'
  | 'wheelchair-mark'
  | 'platform-end';

export interface Landmark {
  id: string;
  name: string;
  type: LandmarkType;
  xM: number;
  stepFree?: boolean;
}

// Station-specific look. Stations without a theme get the generic tunnel.
export type PlatformTheme = 'tcr-elizabeth' | 'ssr';

export interface PlatformLayout {
  theme?: PlatformTheme;
  lengthM: number;
  curved: boolean;
  screenDoors: boolean;
  wallColor: string;
  landmarks: Landmark[];
}

export interface Station {
  id: string;
  name: string;
  // Index along the line from west to east, used to work out the direction of travel.
  order: number;
  layout?: PlatformLayout;
}

export interface TrainSpec {
  name: string;
  cars: number;
  // Car lengths over couplers, front car first.
  carLengthsM: number[];
  doorsPerCar: number;
  doorWidthM: number;
  widthM: number;
  heightM: number; // rail to roof
  floorHeightM: number; // rail to floor
  cabLengthM: number;
  pantographCars: number[];
  // Vehicle type of each car, front first (drives the interior layout).
  carTypes: string[];
  // Measured door centres per car (metres back from the front of each car), when known.
  doorOffsetsM?: number[][];
  // A glTF model to use instead of the procedural train.
  model?: TrainModel;
  // 1-based car numbers counted from the front of the train.
  wheelchairCars: number[];
  multiUseCars: number[];
  // Approximate fixed + tip-up seats in each car, front first.
  seatsPerCar: number[];
}

// How to place a single-car glTF model (a driving car) along the train.
export interface TrainModel {
  url: string;
  credit: string;
  // Model-space z of the cab nose and of the far end of the body, and the floor height.
  noseZ: number;
  rearZ: number;
  // Where the body ends once the cab parts are hidden (intermediate cars).
  cablessFrontZ: number;
  floorY: number;
  // Body lengths from the data sheet; the model is stretched to fit intermediate cars.
  drivingBodyM: number;
  intermediateBodyM: number;
  // Node name prefixes: cab-only parts (hidden on intermediate cars) and heavy, barely
  // visible underframe detail (also hidden on intermediate cars to keep frame rate up).
  cabParts: string[];
  heavyParts: string[];
  // Door leaf groups on each side; 'open' says which way along model z each leaf slides.
  doors: { plusX: { node: string; open: number }[]; minusX: { node: string; open: number }[] };
}

export interface Line {
  id: string;
  name: string;
  color: string;
  available: boolean;
  westLabel: string;
  eastLabel: string;
  train: TrainSpec;
  stations: Station[];
}

// Class 345 from the TfL Class 345 data sheet (FOI-0416-2223): 9 cars, DMS 23.615 m,
// others 22.5 m, 2.772 m wide, 3.76 m high, 1.45 m doorways, three double doors per side.
// Formation DMS-PMS-MS1-MS3-TS(W)-MS3-MS2-PMS-DMS; the 4 wheelchair spaces and 12 extra
// tip-up seats are in the TS(W) car in the middle.
const ELIZABETH_TRAIN: TrainSpec = {
  name: 'Class 345',
  cars: 9,
  carLengthsM: [23.615, 22.5, 22.5, 22.5, 22.5, 22.5, 22.5, 22.5, 23.615],
  doorsPerCar: 3,
  doorWidthM: 1.45,
  widthM: 2.772,
  heightM: 3.76,
  floorHeightM: 1.145,
  cabLengthM: 2.4,
  pantographCars: [2, 8],
  carTypes: ['DMS', 'PMS', 'MS1', 'MS3', 'TS(W)', 'MS3', 'MS2', 'PMS', 'DMS'],
  wheelchairCars: [5],
  multiUseCars: [5],
  seatsPerCar: [44, 50, 50, 50, 48, 50, 50, 50, 44],
};

const simpleTrain = (name: string, cars: number, len: number, doors: number): TrainSpec => ({
  name,
  cars,
  carLengthsM: Array(cars).fill(len),
  doorsPerCar: doors,
  doorWidthM: 1.3,
  widthM: 2.6,
  heightM: 2.9,
  floorHeightM: 0.7,
  cabLengthM: 2,
  pantographCars: [],
  carTypes: Array(cars).fill('car'),
  wheelchairCars: [],
  multiUseCars: [],
  seatsPerCar: Array(cars).fill(42),
});

const elizabethPlatform = (landmarks: Landmark[]): PlatformLayout => ({
  lengthM: 250,
  curved: false,
  screenDoors: true,
  wallColor: '#cfd2d6',
  landmarks,
});

// Tottenham Court Road: dark perforated wall panels, tinted screen doors under a continuous
// light box, and clusters of steel cylinder lights in the ceiling.
const tcrPlatform = (landmarks: Landmark[]): PlatformLayout => ({
  ...elizabethPlatform(landmarks),
  theme: 'tcr-elizabeth',
});

// S8 Stock (Metropolitan line), from the TfL S Stock information sheet (FOI-0158-2021):
// 8 cars DM-M1-M2-MS-MS-M2-M1-DM, DM 17.439 m and others 15.434 m over body ends,
// 2.92 m wide over doors, 3.682 m high, three double doorways per side.
// The 3D model is a driving car: "Bombardier S Stock London Underground" by timblewee
// (Sketchfab, CC-BY-4.0). Door centres below were measured from that model.
const S8_GAP = 0.36; // coupler gap at each end of a car
const S8_TRAIN: TrainSpec = {
  name: 'S8 Stock',
  cars: 8,
  carLengthsM: [17.439, 15.434, 15.434, 15.434, 15.434, 15.434, 15.434, 17.439].map((l) => l + 2 * S8_GAP),
  doorsPerCar: 3,
  doorWidthM: 1.61,
  widthM: 2.92,
  heightM: 3.61,
  floorHeightM: 0.98,
  cabLengthM: 2.2,
  pantographCars: [],
  carTypes: ['DM', 'M1', 'M2', 'MS', 'MS', 'M2', 'M1', 'DM'],
  doorOffsetsM: [
    [4.52, 9.58, 14.8].map((u) => u + S8_GAP),
    ...Array.from({ length: 6 }, () => [3.4, 8.11, 12.97].map((u) => u + S8_GAP)),
    [2.64, 7.86, 12.92].map((u) => u + S8_GAP),
  ],
  // The MS cars carry the multi-use / wheelchair areas (verify against the car diagrams).
  wheelchairCars: [4, 5],
  multiUseCars: [4, 5],
  seatsPerCar: [36, 44, 44, 40, 40, 44, 44, 36],
  model: {
    url: '/models/s8-stock/scene.gltf',
    credit: '"Bombardier S Stock London Underground" by timblewee, CC-BY-4.0',
    noseZ: 9.55,
    rearZ: -7.89,
    cablessFrontZ: 8.68,
    floorY: 1.12,
    drivingBodyM: 17.439,
    intermediateBodyM: 15.434,
    cabParts: [
      'Front End', 'Windscreen', 'Front Vents', 'Front Door', 'Firont Hand Rails', 'Headlight', 'Bumpers',
      'Fog Lights', 'Front Sign', 'Arial', 'Cockpit', 'Driver Doors', 'Driver Door', 'Door Handle', 'Couplers',
    ],
    heavyParts: ['Undercarriage', 'Springs', 'Pickups', 'Roof Bolts', 'Roof Grilles', 'Rear Bogie'],
    doors: {
      plusX: [{ node: 'Doors_6', open: 1 }, { node: 'Doors.001_56', open: -1 }],
      minusX: [{ node: 'Doors.003_59', open: 1 }, { node: 'Doors.002_58', open: -1 }],
    },
  },
};

// Sub-surface platform: no screen doors, yellow line and tactile strip at the edge.
const ssrPlatform = (landmarks: Landmark[]): PlatformLayout => ({
  theme: 'ssr',
  lengthM: 145,
  curved: false,
  screenDoors: false,
  wallColor: '#e8e2d0',
  landmarks,
});

export const LINES: Line[] = [
  {
    id: 'elizabeth',
    name: 'Elizabeth line',
    color: '#6950a1',
    available: true,
    westLabel: 'Westbound (towards Paddington / Reading / Heathrow)',
    eastLabel: 'Eastbound (towards Abbey Wood / Shenfield)',
    train: ELIZABETH_TRAIN,
    stations: [
      { id: 'paddington', name: 'Paddington', order: 0 },
      {
        id: 'bond-street',
        name: 'Bond Street',
        order: 1,
        layout: elizabethPlatform([
          { id: 'end-w', name: 'West end of platform', type: 'platform-end', xM: 0 },
          { id: 'davies-st', name: 'Davies Street exit', type: 'exit', xM: 18 },
          { id: 'lift-w', name: 'Lift to Davies Street', type: 'lift', xM: 30, stepFree: true },
          { id: 'interchange', name: 'Way to Central & Jubilee lines', type: 'interchange', xM: 45 },
          { id: 'bench-1', name: 'first bench', type: 'bench', xM: 70 },
          { id: 'roundel-1', name: 'Bond Street roundel', type: 'roundel', xM: 95 },
          { id: 'help-1', name: 'help point', type: 'help-point', xM: 118 },
          { id: 'bench-2', name: 'middle bench', type: 'bench', xM: 128 },
          { id: 'roundel-2', name: 'Bond Street roundel', type: 'roundel', xM: 160 },
          { id: 'bench-3', name: 'third bench', type: 'bench', xM: 185 },
          { id: 'lift-e', name: 'Lift to Hanover Square', type: 'lift', xM: 215, stepFree: true },
          { id: 'hanover-sq', name: 'Hanover Square exit', type: 'exit', xM: 232 },
          { id: 'end-e', name: 'East end of platform', type: 'platform-end', xM: 250 },
        ]),
      },
      {
        id: 'tottenham-court-road',
        name: 'Tottenham Court Road',
        order: 2,
        layout: tcrPlatform([
          { id: 'end-w', name: 'West end of platform', type: 'platform-end', xM: 0 },
          { id: 'bench-0', name: 'bench at the west end', type: 'bench', xM: 8 },
          { id: 'dean-st', name: 'Dean Street exit', type: 'exit', xM: 20 },
          { id: 'lift-w', name: 'Lift to Dean Street', type: 'lift', xM: 34, stepFree: true },
          { id: 'roundel-0', name: 'first roundel sign', type: 'roundel', xM: 48 },
          { id: 'bench-1', name: 'first bench', type: 'bench', xM: 62 },
          { id: 'roundel-1', name: 'Tottenham Court Road roundel', type: 'roundel', xM: 90 },
          { id: 'roundel-m', name: 'middle roundel sign', type: 'roundel', xM: 112 },
          { id: 'bench-2', name: 'middle bench', type: 'bench', xM: 125 },
          { id: 'help-1', name: 'help point', type: 'help-point', xM: 135 },
          { id: 'roundel-2', name: 'Tottenham Court Road roundel', type: 'roundel', xM: 165 },
          { id: 'roundel-3', name: 'roundel by the interchange', type: 'roundel', xM: 190 },
          { id: 'interchange', name: 'Way to Northern & Central lines', type: 'interchange', xM: 205 },
          { id: 'lift-e', name: 'Lift to Oxford Street', type: 'lift', xM: 218, stepFree: true },
          { id: 'oxford-st', name: 'Oxford Street exit', type: 'exit', xM: 235 },
          { id: 'end-e', name: 'East end of platform', type: 'platform-end', xM: 250 },
        ]),
      },
      { id: 'farringdon', name: 'Farringdon', order: 3 },
      {
        id: 'liverpool-street',
        name: 'Liverpool Street',
        order: 4,
        layout: elizabethPlatform([
          { id: 'end-w', name: 'West end of platform', type: 'platform-end', xM: 0 },
          { id: 'moorgate', name: 'Moorgate exit & interchange', type: 'interchange', xM: 16 },
          { id: 'lift-w', name: 'Lift to Moorgate', type: 'lift', xM: 32, stepFree: true },
          { id: 'bench-1', name: 'first bench', type: 'bench', xM: 66 },
          { id: 'roundel-1', name: 'Liverpool Street roundel', type: 'roundel', xM: 92 },
          { id: 'bench-2', name: 'middle bench', type: 'bench', xM: 124 },
          { id: 'help-1', name: 'help point', type: 'help-point', xM: 140 },
          { id: 'roundel-2', name: 'Liverpool Street roundel', type: 'roundel', xM: 168 },
          { id: 'lift-e', name: 'Lift to Liverpool Street concourse', type: 'lift', xM: 212, stepFree: true },
          { id: 'interchange', name: 'Way to National Rail & Central line', type: 'interchange', xM: 230 },
          { id: 'end-e', name: 'East end of platform', type: 'platform-end', xM: 250 },
        ]),
      },
      { id: 'whitechapel', name: 'Whitechapel', order: 5 },
      { id: 'canary-wharf', name: 'Canary Wharf', order: 6 },
      { id: 'stratford', name: 'Stratford', order: 7 },
    ],
  },
  {
    id: 'metropolitan',
    name: 'Metropolitan line',
    color: '#9b0056',
    available: true,
    westLabel: 'Westbound (towards Baker Street / Amersham / Uxbridge)',
    eastLabel: 'Eastbound (towards Aldgate)',
    train: S8_TRAIN,
    stations: [
      { id: 'harrow-on-the-hill', name: 'Harrow-on-the-Hill', order: -3 },
      { id: 'wembley-park', name: 'Wembley Park', order: -2 },
      { id: 'finchley-road', name: 'Finchley Road', order: -1 },
      {
        id: 'baker-street',
        name: 'Baker Street',
        order: 0,
        layout: ssrPlatform([
          { id: 'end-w', name: 'West end of platform', type: 'platform-end', xM: 0 },
          { id: 'exit-marylebone', name: 'Marylebone Road exit', type: 'exit', xM: 14 },
          { id: 'bench-1', name: 'first bench', type: 'bench', xM: 34 },
          { id: 'roundel-1', name: 'Baker Street roundel', type: 'roundel', xM: 48 },
          { id: 'interchange', name: 'Way to Bakerloo & Jubilee lines', type: 'interchange', xM: 66 },
          { id: 'lift', name: 'Lift to street', type: 'lift', xM: 80, stepFree: true },
          { id: 'bench-2', name: 'middle bench', type: 'bench', xM: 96 },
          { id: 'roundel-2', name: 'Baker Street roundel', type: 'roundel', xM: 112 },
          { id: 'exit-baker', name: 'Baker Street exit', type: 'exit', xM: 132 },
          { id: 'end-e', name: 'East end of platform', type: 'platform-end', xM: 145 },
        ]),
      },
      { id: 'kings-cross', name: "King's Cross St Pancras", order: 1 },
      {
        id: 'farringdon',
        name: 'Farringdon',
        order: 2,
        layout: ssrPlatform([
          { id: 'end-w', name: 'West end of platform', type: 'platform-end', xM: 0 },
          { id: 'exit-cowcross', name: 'Cowcross Street exit', type: 'exit', xM: 16 },
          { id: 'lift-w', name: 'Lift to ticket hall', type: 'lift', xM: 28, stepFree: true },
          { id: 'roundel-1', name: 'Farringdon roundel', type: 'roundel', xM: 46 },
          { id: 'bench-1', name: 'first bench', type: 'bench', xM: 60 },
          { id: 'roundel-2', name: 'Farringdon roundel', type: 'roundel', xM: 82 },
          { id: 'bench-2', name: 'middle bench', type: 'bench', xM: 98 },
          { id: 'interchange', name: 'Way to Elizabeth line & Thameslink', type: 'interchange', xM: 122 },
          { id: 'end-e', name: 'East end of platform', type: 'platform-end', xM: 145 },
        ]),
      },
      { id: 'barbican', name: 'Barbican', order: 3 },
      { id: 'moorgate', name: 'Moorgate', order: 4 },
      {
        id: 'liverpool-street',
        name: 'Liverpool Street',
        order: 5,
        layout: ssrPlatform([
          { id: 'end-w', name: 'West end of platform', type: 'platform-end', xM: 0 },
          { id: 'exit-moorgate', name: 'Moorgate end exit', type: 'exit', xM: 14 },
          { id: 'bench-1', name: 'first bench', type: 'bench', xM: 36 },
          { id: 'roundel-1', name: 'Liverpool Street roundel', type: 'roundel', xM: 52 },
          { id: 'bench-2', name: 'middle bench', type: 'bench', xM: 72 },
          { id: 'roundel-2', name: 'Liverpool Street roundel', type: 'roundel', xM: 92 },
          { id: 'lift', name: 'Lift to Liverpool Street concourse', type: 'lift', xM: 112, stepFree: true },
          { id: 'interchange', name: 'Way to Central & Elizabeth lines', type: 'interchange', xM: 128 },
          { id: 'end-e', name: 'East end of platform', type: 'platform-end', xM: 145 },
        ]),
      },
      { id: 'aldgate', name: 'Aldgate', order: 6 },
    ],
  },
  {
    id: 'central',
    name: 'Central line',
    color: '#dc241f',
    available: false,
    westLabel: 'Westbound',
    eastLabel: 'Eastbound',
    train: simpleTrain('1992 Stock', 8, 16.25, 2),
    stations: [],
  },
  {
    id: 'dlr',
    name: 'DLR',
    color: '#00a4a7',
    available: false,
    westLabel: 'Westbound',
    eastLabel: 'Eastbound',
    train: simpleTrain('B92 Stock', 3, 28, 4),
    stations: [],
  },
];

export const getLine = (id: string) => LINES.find((l) => l.id === id) ?? LINES[0];

export const findStation = (line: Line, nameOrId: string | undefined | null) => {
  if (!nameOrId) return undefined;
  const key = nameOrId.toLowerCase().replace(/[^a-z]/g, '');
  return line.stations.find(
    (s) => s.id.replace(/-/g, '') === key || s.name.toLowerCase().replace(/[^a-z]/g, '') === key,
  );
};

export type Direction = 'east' | 'west';

export const trainLength = (train: TrainSpec) => train.carLengthsM.reduce((a, b) => a + b, 0);

// Distance from the front of the train to the front of car n (1-based).
export const carStartFromFront = (train: TrainSpec, car: number) =>
  train.carLengthsM.slice(0, car - 1).reduce((a, b) => a + b, 0);

// Door centres of car n, measured from the front of that car. Cab ends lose their cab length.
export const doorOffsetsInCar = (train: TrainSpec, car: number) => {
  if (train.doorOffsetsM) return train.doorOffsetsM[car - 1];
  const len = train.carLengthsM[car - 1];
  const head = car === 1 ? train.cabLengthM : 0;
  const tail = car === train.cars ? train.cabLengthM : 0;
  const usable = len - head - tail;
  return Array.from({ length: train.doorsPerCar }, (_, d) => head + ((d + 0.5) / train.doorsPerCar) * usable);
};

// Point where the FRONT of the train stops. Trains are centred on the platform so the
// screen doors line up with the train doors.
export const trainFrontX = (layout: PlatformLayout, train: TrainSpec, dir: Direction) => {
  const margin = (layout.lengthM - trainLength(train)) / 2;
  return dir === 'east' ? layout.lengthM - margin : margin;
};

// Convert a distance measured back from the front of the train into station coordinates.
export const fromFrontToX = (layout: PlatformLayout, train: TrainSpec, dir: Direction, d: number) => {
  const front = trainFrontX(layout, train, dir);
  return dir === 'east' ? front - d : front + d;
};

// Centre of car n (1-based from the front) in station coordinates.
export const carCentreX = (layout: PlatformLayout, train: TrainSpec, dir: Direction, car: number) =>
  fromFrontToX(layout, train, dir, carStartFromFront(train, car) + train.carLengthsM[car - 1] / 2);

// Every door centre along the platform, in station coordinates.
export const doorXs = (layout: PlatformLayout, train: TrainSpec, dir: Direction) =>
  Array.from({ length: train.cars }, (_, i) =>
    doorOffsetsInCar(train, i + 1).map((o) => fromFrontToX(layout, train, dir, carStartFromFront(train, i + 1) + o)),
  ).flat();

// Which car (1-based) stops opposite station position x, or undefined if outside the train.
export const carAtX = (layout: PlatformLayout, train: TrainSpec, dir: Direction, x: number) => {
  const front = trainFrontX(layout, train, dir);
  const fromFront = dir === 'east' ? front - x : x - front;
  let start = 0;
  for (let c = 1; c <= train.cars; c++) {
    const end = start + train.carLengthsM[c - 1];
    if (fromFront >= start && fromFront < end) return c;
    start = end;
  }
  return undefined;
};
