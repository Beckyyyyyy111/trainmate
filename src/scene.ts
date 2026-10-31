// Procedural 3D platform built from a PlatformLayout, drawn as an architectural cut-away.
// World axes: x runs along the platform (west -> east), z points from the back wall
// towards the track, y is up. The platform floor is at y = 0.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  carAtX,
  carCentreX,
  carStartFromFront,
  doorOffsetsInCar,
  doorXs,
  trainFrontX,
  type Direction,
  type Landmark,
  type Line,
  type PlatformLayout,
  type TrainSpec,
} from './data/network';
import type { CarLoad } from './engine/crowding';
import { loadPeople, type PersonTemplate } from './people';

const WALL_Z = -5; // back of the platform
const EDGE_Z = 3; // platform edge / screen doors
// Train side sits ~0.25 m behind the screen doors (Class 345 is 2.772 m wide).
const TRACK_Z = 4.65;
const TUNNEL_C = 1.5; // tunnel arc centre (z)
const TUNNEL_R = 6.5;
const MAX_PLATFORM_PEOPLE = 260;
const PEOPLE_PER_FULL_CAR = 34;
const TRACK_EXTRA = 600;
const TCR_CEIL = 4.4;
// How many of the closest people (per crowd) are drawn with the scanned models.
const NEAR_PEOPLE = 36;

const EYE_HEIGHT = 1.65;
const WALK_SPEED = 1.4; // m/s, a normal walking pace
const TARGET_Z = EDGE_Z - 1.2; // where the wait-spot ring sits

export type Turn = 'ahead' | 'left' | 'right' | 'around';

export interface WalkInfo {
  stationX: number;
  // Distance along the platform to the wait spot, and the straight-line distance.
  along: number;
  distance: number;
  // Which way to turn to face the way you need to walk.
  turn: Turn;
  // The next landmark you will pass, and one you have just passed.
  next?: { name: string; distance: number };
  passed?: string;
  arrived: boolean;
  doorsOpen: boolean;
  boarded: boolean;
}

export type TrainPhase = { phase: 'away' } | { phase: 'approach' | 'dwell' | 'depart'; p: number };


export class PlatformScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private station = new THREE.Group();
  private train = new THREE.Group();
  private carLabels: THREE.Sprite[] = [];
  private carDisplays: CarDisplay[] = [];
  private trainDoors: { obj: THREE.Object3D; base: number; dir: number; width: number; axis: 'x' | 'z' }[] = [];
  private buildToken = 0;
  private trainPeople?: Crowd;
  private platformPeople?: Crowd;
  private doorLeaves: { obj: THREE.Object3D; baseX: number; dirX: number }[] = [];
  private target = new THREE.Group();
  private user = new THREE.Group();
  private layout?: PlatformLayout;
  private line?: Line;
  private dir: Direction = 'east';
  private half = 0;
  private camGoal?: { pos: THREE.Vector3; look: THREE.Vector3; speed: number };
  private clock = new THREE.Clock();
  private host: HTMLElement;
  private peopleTemplates: PersonTemplate[] = [];
  private peopleGroupTemplates: THREE.Object3D[] = [];
  private lodAt = 0;
  private userShown = false;
  // First-person walking on the platform. yaw 0 = facing the track (+z).
  private walk = {
    active: false,
    pos: new THREE.Vector3(),
    yaw: 0,
    pitch: -0.06,
    keys: new Set<string>(),
    bob: 0,
    lastReport: 0,
    lastX: 0,
    reportX: 0,
    boardYaw0: 0,
    boardYaw1: 0,
  };
  onWalk?: (info: WalkInfo) => void;
  onBoard?: (car: number) => void;
  private doorsOpen = 0;
  private boarded = false;
  private boardOffset = 0;
  private boardingT = -1;
  // Testing aid: multiplies walking speed.
  speedScale = 1;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-hidden', 'true');

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1500);
    this.camera.position.set(-60, 30, 60);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 260;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('start', () => (this.camGoal = undefined));
    this.bindWalkInput();
    loadPeople()
      .then((t) => {
        this.peopleTemplates = t;
        this.platformPeople?.setTemplates(t, NEAR_PEOPLE);
        this.trainPeople?.setTemplates(t, NEAR_PEOPLE);
      })
      .catch((err) => console.info('Scanned people not available; synthetic fallback is disabled', err));
    Promise.all([
      loadGltf('/models/people-family.glb'),
      loadGltf('/models/people-colleagues.glb'),
      loadGltf('/models/people-queue.glb'),
    ])
      .then((models) => {
        this.peopleGroupTemplates = models.map((gltf) => gltf.scene);
        this.addPeopleGroups();
      })
      .catch((err) => console.info('CC0 people groups not available', err));

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    this.scene.background = new THREE.Color('#07090d');
    this.scene.fog = new THREE.Fog('#07090d', 160, 420);
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#202430', 0.55));
    const key = new THREE.DirectionalLight('#fff4e0', 0.5);
    key.position.set(40, 80, 60);
    this.scene.add(key);
    this.scene.add(this.station, this.train, this.target, this.user);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.35, 0.95));
    this.composer.addPass(new OutputPass());

    this.buildMarkers();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- Station ----------

  build(line: Line, layout: PlatformLayout, stationName: string, dir: Direction) {
    this.line = line;
    this.layout = layout;
    this.dir = dir;
    this.half = layout.lengthM / 2;
    disposeGroup(this.station);
    this.doorLeaves = [];
    this.carDisplays = [];
    const L = layout.lengthM;
    const s = this.station;

    // Polished terrazzo floor with a subtle tile grid.
    const floorTex = layout.theme === 'tcr-elizabeth' ? gridTexture('#d3d4d6', '#c2c3c6', 6) : gridTexture('#b9bcc1', '#a7abb1', 8);
    floorTex.repeat.set(L / 2, (EDGE_Z - WALL_Z) / 2);
    s.add(
      meshAt(
        new THREE.BoxGeometry(L, 1.2, EDGE_Z - WALL_Z),
        new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.7, metalness: 0 }),
        0, -0.6, (EDGE_Z + WALL_Z) / 2,
      ),
    );
    // Section cut: dark concrete below the platform, visible in the cut-away.
    s.add(box(L + 2, 6, 14, '#1b1e24', 0, -4.25, 2));

    // Track bed, rails and sleepers.
    // Rail tops sit one train floor-height below the platform (level boarding).
    const fh = line.train.floorHeightM;
    s.add(box(L + TRACK_EXTRA, 0.3, 4.6, '#2a2c31', 0, -fh - 0.355, TRACK_Z));
    for (const dz of [-0.72, 0.72]) s.add(box(L + TRACK_EXTRA, 0.16, 0.1, '#c9ccd2', 0, -fh - 0.08, TRACK_Z + dz, 0.95, 0.25));
    s.add(sleepers(L + TRACK_EXTRA, -fh - 0.185));

    if (layout.theme === 'tcr-elizabeth') this.buildTcr(L);
    else if (layout.theme === 'ssr') this.buildSsr(L, line);
    else this.buildTunnel(L, layout.wallColor);
    this.addFillLights();
    if (layout.screenDoors) this.buildScreenDoors(line, layout);
    else s.add(box(L, 0.03, 0.12, '#f2c200', 0, 0.01, EDGE_Z - 0.35));
    for (const lm of layout.landmarks) this.buildLandmark(lm, line, stationName);

    // Direction of travel painted on the floor.
    const arrow = floorDecal(dir === 'east' ? 'TRAINS THIS WAY  →' : '←  TRAINS THIS WAY');
    arrow.position.set(0, 0.02, -1);
    s.add(arrow);

    this.platformPeople = new Crowd(MAX_PLATFORM_PEOPLE, undefined, true, true);
    if (this.peopleTemplates.length) this.platformPeople.setTemplates(this.peopleTemplates, NEAR_PEOPLE);
    s.add(this.platformPeople.group);
    this.addPeopleGroups();

    this.buildTrain(line);
    this.intro();
  }

  private addPeopleGroups() {
    if (!this.peopleGroupTemplates.length || !this.layout) return;
    const old = this.station.getObjectByName('real-families');
    if (old) this.station.remove(old);
    const families = new THREE.Group();
    families.name = 'real-families';
    const positions = [0.2, 0.52, 0.82];
    for (const [i, modelTemplate] of this.peopleGroupTemplates.entries()) {
      const ratio = positions[i] ?? (i + 1) / (this.peopleGroupTemplates.length + 1);
      const model = modelTemplate.clone(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const centre = bounds.getCenter(new THREE.Vector3());
      model.position.set(-centre.x, -bounds.min.y, -centre.z);
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = false;
          o.receiveShadow = true;
        }
      });
      const wrapper = new THREE.Group();
      wrapper.add(model);
      wrapper.position.set(this.wx(this.layout.lengthM * ratio), 0, -1.8 - (i % 2) * 1.1);
      wrapper.rotation.y = i % 2 ? Math.PI : 0;
      families.add(wrapper);
    }
    this.station.add(families);
  }

  private buildTunnel(L: number, wallColor: string) {
    // Curved lining from the floor at the back wall, over the platform, ending above the track
    // so the camera can look in from the track side.
    const a0 = 0;
    const a1 = Math.PI * 0.6;
    const tex = gridTexture(wallColor, shade(wallColor, -0.08), 4, true);
    tex.repeat.set(L / 3, 6);
    this.station.add(arcSurface(L, TUNNEL_R, a0, a1, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, side: THREE.DoubleSide })));
    this.station.add(arcSurface(L, TUNNEL_R + 0.6, a0, a1, new THREE.MeshStandardMaterial({ color: '#15171c', roughness: 1, side: THREE.DoubleSide })));

    // Continuous light lines along the vault.
    for (const a of [0.34, 0.47]) {
      const ang = Math.PI * a;
      const r = TUNNEL_R - 0.08;
      const strip = meshAt(
        new THREE.BoxGeometry(L, 0.12, 0.22),
        new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6e6', emissiveIntensity: 2.4 }),
        0, r * Math.sin(ang), TUNNEL_C - r * Math.cos(ang),
      );
      strip.rotation.x = -(Math.PI / 2 - ang);
      this.station.add(strip);
    }
    // Tunnel portals at both ends of the platform.
    for (const side of [-1, 1]) {
      const end = new THREE.Mesh(
        new THREE.RingGeometry(2.6, TUNNEL_R + 0.6, 48, 1, 0, Math.PI),
        new THREE.MeshStandardMaterial({ color: '#2a2d34', side: THREE.DoubleSide }),
      );
      end.rotation.y = Math.PI / 2;
      end.position.set(side * this.half, 0, TUNNEL_C);
      this.station.add(end);
      const mouth = new THREE.Mesh(new THREE.CircleGeometry(2.6, 32, 0, Math.PI), new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide }));
      mouth.rotation.y = Math.PI / 2;
      mouth.position.set(side * (this.half + 0.05), -1.4, TRACK_Z);
      this.station.add(mouth);
    }
  }

  // Soft fill so the floor picks up the ceiling lighting.
  private addFillLights() {
    for (let x = -this.half + 20; x < this.half; x += 40) {
      const p = new THREE.PointLight('#fff2dc', 7, 26, 1.6);
      p.position.set(x, 3.8, 0);
      this.station.add(p);
    }
  }

  // Tottenham Court Road (Elizabeth line): a squarer box than the generic tunnel.
  // Ceiling, light box and end walls only face inwards, so the overview camera can see in
  // from above while the eye-level view still sees a closed room.
  private buildTcr(L: number) {
    const s = this.station;
    const depth = EDGE_Z - WALL_Z;
    const midZ = (EDGE_Z + WALL_Z) / 2;

    // Back wall: black panels perforated with white dot patterns, steel skirting, pale band above.
    const dots = dotPanelTexture();
    dots.repeat.set(L / 3.2, 1);
    s.add(meshAt(new THREE.BoxGeometry(L, 2.55, 0.2), new THREE.MeshStandardMaterial({ map: dots, roughness: 0.45, metalness: 0.3 }), 0, 0.2 + 1.275, WALL_Z - 0.1));
    s.add(box(L, 0.2, 0.24, '#8d9095', 0, 0.1, WALL_Z, 0.8, 0.35));
    const band = panelTexture('#dcdddf', '#b5b7bb', 4, 2);
    band.repeat.set(L / 4.8, 1);
    s.add(meshAt(new THREE.BoxGeometry(L, 0.9, 0.2), new THREE.MeshStandardMaterial({ map: band, roughness: 0.6 }), 0, 3.2, WALL_Z - 0.1));
    s.add(box(L, TCR_CEIL - 3.65, 0.2, '#c9cacc', 0, (3.65 + TCR_CEIL) / 2, WALL_Z - 0.1, 0, 0.9));

    // Ceiling soffit with a recessed channel.
    const ceilTex = panelTexture('#c7c8ca', '#b3b5b8', 2, 1);
    ceilTex.repeat.set(L / 2.4, 1);
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(L, depth + 0.2), new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.85 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, TCR_CEIL, midZ);
    s.add(ceiling);

    // Clusters of stainless steel cylinder lights hanging from the ceiling.
    s.add(cylinderLights(L, -1.4));

    // Continuous light box above the screen doors.
    const lightBox = new THREE.Mesh(
      new THREE.PlaneGeometry(L, TCR_CEIL - 3.1),
      new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#f4f8ff', emissiveIntensity: 1.2 }),
    );
    lightBox.rotation.y = Math.PI;
    lightBox.position.set(0, (3.1 + TCR_CEIL) / 2, EDGE_Z + 0.02);
    s.add(lightBox);

    // Ribbed, fan-shaped end walls.
    const fan = fanTexture();
    for (const side of [-1, 1]) {
      const end = new THREE.Mesh(new THREE.PlaneGeometry(depth, TCR_CEIL), new THREE.MeshStandardMaterial({ map: fan, roughness: 0.6 }));
      end.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      end.position.set(side * this.half, TCR_CEIL / 2, midZ);
      s.add(end);
      const mouth = new THREE.Mesh(new THREE.CircleGeometry(2.6, 32, 0, Math.PI), new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide }));
      mouth.rotation.y = Math.PI / 2;
      mouth.position.set(side * (this.half + 0.05), -1.4, TRACK_Z);
      s.add(mouth);
    }
  }

  // Sub-surface (Metropolitan line) platform: brick and cream-tiled retaining wall, a
  // canopy on steel beams, and an open edge with a white line, yellow line and tactile strip.
  private buildSsr(L: number, line: Line) {
    const s = this.station;
    const depth = EDGE_Z - WALL_Z;
    const midZ = (EDGE_Z + WALL_Z) / 2;
    const bricks = brickTexture();
    bricks.repeat.set(L / 4, 1);
    s.add(meshAt(new THREE.BoxGeometry(L, 1.3, 0.3), new THREE.MeshStandardMaterial({ map: bricks, roughness: 0.9 }), 0, 0.65, WALL_Z - 0.15));
    const tiles = panelTexture('#ece6d4', '#cfc7b0', 8, 4);
    tiles.repeat.set(L / 2.4, 1);
    s.add(meshAt(new THREE.BoxGeometry(L, 2.2, 0.3), new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.35 }), 0, 2.4, WALL_Z - 0.15));
    s.add(box(L, 0.18, 0.32, line.color, 0, 1.38, WALL_Z - 0.14, 0, 0.4));
    s.add(box(L, 0.9, 0.3, '#3b3f46', 0, 3.95, WALL_Z - 0.15, 0.3, 0.6));

    // Canopy: one-sided underside so the overview can look in from above.
    const canopy = new THREE.Mesh(new THREE.PlaneGeometry(L, depth + 1.2), new THREE.MeshStandardMaterial({ color: '#d9d6cf', roughness: 0.8 }));
    canopy.rotation.x = Math.PI / 2;
    canopy.position.set(0, TCR_CEIL, midZ + 0.4);
    s.add(canopy);
    for (let x = -L / 2 + 3; x < L / 2; x += 6) {
      s.add(box(0.18, 0.35, depth + 1.2, '#2f343c', x, TCR_CEIL - 0.18, midZ + 0.4, 0.6, 0.4));
    }
    for (let x = -L / 2 + 9; x < L / 2 - 4; x += 12) {
      s.add(box(0.22, TCR_CEIL, 0.22, '#2f343c', x, TCR_CEIL / 2, WALL_Z + 1.0, 0.6, 0.4));
    }
    // Strip lights along the platform under the canopy.
    const strip = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff8ea', emissiveIntensity: 1.6 });
    for (let x = -L / 2 + 2; x < L / 2 - 2; x += 4) s.add(meshAt(new THREE.BoxGeometry(2.4, 0.06, 0.16), strip, x, TCR_CEIL - 0.45, 0.2));

    // Platform edge: white edge line, tactile strip, yellow line.
    s.add(box(L, 0.03, 0.12, '#f4f4f4', 0, 0.012, EDGE_Z - 0.07));
    s.add(meshAt(new THREE.BoxGeometry(L, 0.02, 0.4), new THREE.MeshStandardMaterial({ map: tactileTexture(L), roughness: 0.9 }), 0, 0.012, EDGE_Z - 0.55));
    s.add(box(L, 0.025, 0.1, '#f2c200', 0, 0.014, EDGE_Z - 0.9));

    // Open cutting beyond the track: dark ballast and a low retaining wall.
    s.add(box(L + TRACK_EXTRA, 0.2, 10, '#26282c', 0, -1.6, TRACK_Z + 5));
  }

  private buildScreenDoors(line: Line, layout: PlatformLayout) {
    const tcr = layout.theme === 'tcr-elizabeth';
    const glass = tcr
      ? new THREE.MeshPhysicalMaterial({ color: '#2b333b', transparent: true, opacity: 0.38, roughness: 0.06, metalness: 0.5, depthWrite: false })
      : new THREE.MeshPhysicalMaterial({ color: '#d7ecf7', transparent: true, opacity: 0.22, roughness: 0.05, depthWrite: false });
    const frame = new THREE.MeshStandardMaterial({ color: '#2d3038', metalness: 0.7, roughness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color: line.color, emissive: line.color, emissiveIntensity: 0.6 });
    const doors = this.doorPositions(layout);
    const L = layout.lengthM;
    const H = 2.55;

    // Fixed glass between door openings.
    const edges = [0, ...doors.flatMap((d) => [d - 0.9, d + 0.9]), L];
    for (let i = 0; i < edges.length; i += 2) {
      const [a, b] = [edges[i], edges[i + 1]];
      if (b - a < 0.2) continue;
      this.station.add(meshAt(new THREE.BoxGeometry(b - a, H, 0.05), glass, this.wx((a + b) / 2), H / 2, EDGE_Z));
      if (tcr && b - a > 3) {
        // Roundel manifestation on the glass, seen from the platform.
        const badge = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.68), new THREE.MeshBasicMaterial({ map: roundelTexture('', line.color), transparent: true }));
        badge.rotation.y = Math.PI;
        badge.position.set(this.wx((a + b) / 2), 1.45, EDGE_Z - 0.04);
        this.station.add(badge);
      }
      for (let x = a; x <= b; x += 2.6) this.station.add(meshAt(new THREE.BoxGeometry(0.06, H, 0.12), frame, this.wx(x), H / 2, EDGE_Z));
    }
    // Header bulkhead with a line-colour band.
    this.station.add(meshAt(new THREE.BoxGeometry(L, 0.55, 0.35), frame, 0, H + 0.27, EDGE_Z));
    this.station.add(meshAt(new THREE.BoxGeometry(L, 0.07, 0.37), accent, 0, H + 0.05, EDGE_Z));
    // Per-car crowding displays in the header, facing the platform.
    const { train } = line;
    for (let c = 1; c <= train.cars; c++) {
      const display = new CarDisplay(Math.min(6, train.carLengthsM[c - 1] - 4), train.wheelchairCars.includes(c) ? ' ♿' : '');
      display.mesh.position.set(this.wx(carCentreX(layout, train, this.dir, c)), H + 0.3, EDGE_Z - 0.19);
      display.mesh.rotation.y = Math.PI;
      this.station.add(display.mesh);
      this.carDisplays.push(display);
    }

    // Sliding door leaves, plus a door marker on the floor.
    const leafMat = tcr ? glass : new THREE.MeshPhysicalMaterial({ color: '#dff1fb', transparent: true, opacity: 0.3, roughness: 0.05, depthWrite: false });
    for (const d of doors) {
      for (const side of [-1, 1]) {
        const leaf = new THREE.Group();
        leaf.add(new THREE.Mesh(new THREE.BoxGeometry(0.9, H - 0.05, 0.04), leafMat));
        leaf.add(meshAt(new THREE.BoxGeometry(0.05, H - 0.05, 0.08), accent, side * -0.43, 0, 0));
        const baseX = this.wx(d) + side * 0.45;
        leaf.position.set(baseX, H / 2, EDGE_Z + 0.06);
        this.station.add(leaf);
        this.doorLeaves.push({ obj: leaf, baseX, dirX: side });
      }
      this.station.add(meshAt(new THREE.BoxGeometry(1.7, 0.01, 0.5), accent, this.wx(d), 0.006, EDGE_Z - 0.35));
    }
  }

  private doorPositions(layout: PlatformLayout) {
    return doorXs(layout, this.line!.train, this.dir).sort((a, b) => a - b);
  }

  private buildLandmark(lm: Landmark, line: Line, stationName: string) {
    const g = new THREE.Group();
    g.position.x = this.wx(lm.xM);
    // Themed stations have a straight back wall; the generic tunnel curves.
    const tcr = !!this.layout?.theme;
    const ringColor = this.layout?.theme === 'ssr' ? '#dc241f' : line.color;
    const wallAt = (y: number) => (tcr ? WALL_Z : TUNNEL_C - Math.sqrt(TUNNEL_R ** 2 - y ** 2));
    if (tcr && lm.type === 'roundel') {
      // White wayfinding panel set into the dark wall, roundel at eye level.
      g.add(box(1.35, 2.7, 0.06, '#f4f4f2', 0, 1.5, WALL_Z + 0.04, 0, 0.6));
      const r = new THREE.Mesh(
        new THREE.PlaneGeometry(1.25, 0.78),
        new THREE.MeshStandardMaterial({ map: roundelTexture(stationName.toUpperCase(), ringColor), transparent: true, emissive: '#ffffff', emissiveMap: roundelTexture(stationName.toUpperCase(), ringColor), emissiveIntensity: 0.25 }),
      );
      r.position.set(0, 1.35, WALL_Z + 0.08);
      g.add(r);
      const wayOut = signBoard('Way out  ↗', '#ffd400', '#000000', 0.22);
      wayOut.position.set(0, 2.55, WALL_Z + 0.09);
      g.add(wayOut);
      this.station.add(g);
      return;
    }
    switch (lm.type) {
      case 'bench': {
        const wood = '#8a6a4a';
        g.add(box(3.2, 0.1, 0.55, wood, 0, 0.48, WALL_Z + 1.6, 0, 0.6));
        g.add(box(3.2, 0.5, 0.08, wood, 0, 0.8, WALL_Z + 1.33, 0, 0.6));
        for (const x of [-1.4, 1.4]) g.add(box(0.08, 0.48, 0.5, '#2b2e35', x, 0.24, WALL_Z + 1.6, 0.8, 0.3));
        break;
      }
      case 'roundel': {
        const r = roundel(stationName.toUpperCase(), line.color);
        r.position.set(0, 2.6, wallAt(2.6) + 0.15);
        r.rotation.x = -0.25;
        g.add(r);
        break;
      }
      case 'help-point': {
        g.add(box(0.45, 1.7, 0.3, '#0019a8', 0, 0.85, WALL_Z + 1.2, 0.2, 0.4));
        g.add(box(0.3, 0.3, 0.05, '#ffffff', 0, 1.35, WALL_Z + 1.36));
        break;
      }
      case 'wheelchair-mark': {
        g.add(box(1.4, 0.01, 1.4, '#0019a8', 0, 0.01, EDGE_Z - 1.4));
        break;
      }
      case 'platform-end':
        return;
      default: {
        // Cross-passage opening in the tunnel lining, lit from inside.
        const lift = lm.type === 'lift';
        const w = lift ? 2.6 : 4.4;
        const h = 3;
        const z = wallAt(h) + 0.05;
        g.add(box(w + 0.5, h + 0.4, 2.4, '#e8e9ec', 0, (h + 0.4) / 2, z - 1.15, 0, 0.5));
        const inside = new THREE.MeshStandardMaterial({
          color: lift ? '#aab2bb' : '#3a3f48',
          emissive: '#fff1d6',
          emissiveIntensity: lift ? 0.15 : 0.35,
          metalness: lift ? 0.8 : 0,
          roughness: 0.4,
        });
        g.add(meshAt(new THREE.BoxGeometry(w, h, 2.5), inside, 0, h / 2, z - 1.1));
        if (lift) g.add(box(0.04, h - 0.1, 0.06, '#1b1e24', 0, h / 2, z + 0.15));
        const colors: Partial<Record<Landmark['type'], [string, string]>> = {
          exit: ['#ffd400', '#000000'],
          escalator: ['#ffd400', '#000000'],
          interchange: ['#0019a8', '#ffffff'],
          lift: ['#0019a8', '#ffffff'],
          entrance: ['#0019a8', '#ffffff'],
        };
        const [bg, fg] = colors[lm.type] ?? ['#0019a8', '#ffffff'];
        const icon = lift ? '♿  ' : lm.type === 'exit' ? '⬈  ' : lm.type === 'interchange' ? '⇄  ' : '';
        const sign = signBoard(`${icon}${lm.name}`, bg, fg);
        sign.position.set(0, h + 0.75, z + 0.4);
        g.add(sign);
        if (tcr) {
          // Double-sided sign hanging across the platform so it can be read from along it.
          const hanging = signBoard(`${lm.type === 'exit' ? 'Way out  ' : ''}${lm.name}`, '#1d2026', '#ffffff', 0.5);
          hanging.rotation.y = Math.PI / 2;
          hanging.position.set(0, TCR_CEIL - 0.75, -0.6);
          g.add(hanging, box(0.03, 0.5, 0.03, '#888c92', 0, TCR_CEIL - 0.25, -0.6));
        }
      }
    }
    this.station.add(g);
  }

  // ---------- Train ----------

  // Class 345, built to the published dimensions. Local x = 0 is the nose of the leading cab
  // and the train extends backwards, against the direction of travel.
  private buildTrain(line: Line) {
    const model = line.train.model;
    if (!model) return this.buildProceduralTrain(line);
    const token = ++this.buildToken;
    disposeGroup(this.train);
    this.carLabels = [];
    this.trainDoors = [];
    const { train } = line;
    const fwd = this.dir === 'east' ? 1 : -1;
    const roof = train.heightM - train.floorHeightM;
    const cars: THREE.Group[] = [];
    for (let c = 1; c <= train.cars; c++) {
      const car = new THREE.Group();
      car.position.set(-fwd * (carStartFromFront(train, c) + train.carLengthsM[c - 1] / 2), 0, TRACK_Z);
      const tag = pill(`Car ${c}`, '#ffffff', 'rgba(12,14,18,0.8)', 0.7);
      tag.position.set(0, roof + 1.0, 0);
      car.add(tag);
      this.carLabels.push(tag);
      this.train.add(car);
      cars.push(car);
    }
    this.trainPeople = new Crowd(train.cars * PEOPLE_PER_FULL_CAR, undefined, false, true);
    if (this.peopleTemplates.length) this.trainPeople.setTemplates(this.peopleTemplates, NEAR_PEOPLE);
    this.trainPeople.group.position.z = TRACK_Z;
    this.train.add(this.trainPeople.group);
    this.train.visible = false;
    loadGltf(model.url)
      .then((gltf) => {
        if (token === this.buildToken) this.addModelCars(gltf, line, cars);
      })
      .catch((err) => {
        console.warn('Train model failed to load, using the procedural train', err);
        if (token === this.buildToken) this.buildProceduralTrain(line);
      });
  }

  // One glTF driving car, cloned per car. Intermediate cars hide the cab and the heaviest
  // underframe detail and are stretched to the data-sheet body length.
  private addModelCars(gltf: GLTF, line: Line, cars: THREE.Group[]) {
    const { train } = line;
    const md = train.model!;
    const fwd = this.dir === 'east' ? 1 : -1;
    const norm = (n: string) => n.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const cab = md.cabParts.map(norm);
    const heavy = md.heavyParts.map(norm);
    cars.forEach((car, i) => {
      const c = i + 1;
      const driving = c === 1 || c === train.cars;
      const model = gltf.scene.clone(true);
      model.traverse((o) => {
        const n = norm(o.name);
        if (!driving && (cab.some((p) => n.startsWith(p)) || heavy.some((p) => n.startsWith(p)))) o.visible = false;
      });
      const bodyFront = driving ? md.noseZ : md.cablessFrontZ;
      const sz = (driving ? md.drivingBodyM : md.intermediateBodyM) / (bodyFront - md.rearZ);
      const inner = new THREE.Group();
      inner.add(model);
      inner.scale.z = sz;
      inner.position.set(0, -md.floorY, -((bodyFront + md.rearZ) / 2) * sz);
      if (!driving) {
        // Close the open end left by the hidden cab with gangway bellows.
        inner.add(meshAt(new THREE.BoxGeometry(2.6, 2.5, 0.35), new THREE.MeshStandardMaterial({ color: '#1d1f23', roughness: 0.95 }), 0, md.floorY + 1.25, bodyFront + 0.1));
      }
      const pivot = new THREE.Group();
      pivot.add(inner);
      // Model +z is the cab end: towards the front, except on the rear driving car.
      const faceFront = c === train.cars ? -1 : 1;
      pivot.rotation.y = fwd * faceFront > 0 ? Math.PI / 2 : -Math.PI / 2;
      car.add(pivot);
      // With +pi/2 the model's +x side faces the platform (-z); otherwise its -x side does.
      const doorSet = pivot.rotation.y > 0 ? md.doors.plusX : md.doors.minusX;
      for (const d of doorSet) {
        const node = findByNorm(model, norm(d.node), norm);
        if (node) this.trainDoors.push({ obj: node, base: node.position.z, dir: d.open, width: 0.8, axis: 'z' });
      }
    });
  }

  private buildProceduralTrain(line: Line) {
    disposeGroup(this.train);
    this.carLabels = [];
    this.trainDoors = [];
    const { train } = line;
    const fwd = this.dir === 'east' ? 1 : -1;
    const W = train.widthM;
    const roof = train.heightM - train.floorHeightM;
    const m = trainMaterials();

    for (let c = 1; c <= train.cars; c++) {
      const Lc = train.carLengthsM[c - 1];
      const car = new THREE.Group();
      car.position.set(-fwd * (carStartFromFront(train, c) + Lc / 2), 0, TRACK_Z);
      // u metres back from the front of this car -> car-local x.
      const ux = (u: number) => fwd * (Lc / 2 - u);
      const cabFront = c === 1 ? train.cabLengthM : 0;
      const cabRear = c === train.cars ? train.cabLengthM : 0;
      const shellLen = Lc - 0.5 - cabFront - cabRear; // 0.5 m left for the gangway
      const shellMid = ux(cabFront + (c === 1 ? 0 : 0.25) + shellLen / 2);

      // Body shell: lower body, glazed band, roof.
      car.add(meshAt(new RoundedBoxGeometry(shellLen, 1.7, W, 2, 0.08), m.body, shellMid, 0.1, 0));
      car.add(meshAt(new RoundedBoxGeometry(shellLen, 0.62, W, 4, 0.3), m.body, shellMid, roof - 0.31, 0));
      for (const side of [-1, 1]) {
        car.add(meshAt(new THREE.BoxGeometry(shellLen, 1.07, 0.02), m.glass, shellMid, 1.48, side * (W / 2 - 0.01)));
        car.add(meshAt(new THREE.BoxGeometry(shellLen, 0.05, 0.03), m.trim, shellMid, 0.96, side * (W / 2)));
      }
      // Blue lower-body band with roundels and the purple swoosh at the No.2 end (data sheet livery).
      const bandTex = bodyBandTexture(train, c, cabFront, shellLen);
      for (const side of [-1, 1]) {
        const band = new THREE.Mesh(new THREE.PlaneGeometry(shellLen, 1.5), new THREE.MeshStandardMaterial({ map: bandTex, roughness: 0.35, metalness: 0.15, side: THREE.DoubleSide }));
        band.position.set(shellMid, 0.2, side * (W / 2 + 0.006));
        if (side < 0) band.rotation.y = Math.PI;
        // Canvas right = No.2 end (larger u). Mirror where that end lands on the viewer's left.
        const rightIsNo2 = side === 1 ? fwd === -1 : fwd === 1;
        if (!rightIsNo2) band.scale.x = -1;
        car.add(band);
      }
      for (let u = cabFront + 0.6; u < Lc - cabRear - 0.4; u += 2.6) {
        for (const side of [-1, 1]) car.add(meshAt(new THREE.BoxGeometry(0.16, 1.07, 0.05), m.body, ux(u), 1.48, side * (W / 2)));
      }
      // Underframe equipment, bogies, gangway bellows, pantograph.
      car.add(meshAt(new THREE.BoxGeometry(shellLen - 6, 0.38, W - 0.5), m.under, shellMid, -0.95, 0));
      for (const u of [2.6, Lc - 2.6]) this.addBogie(car, ux(u), train, m);
      if (c < train.cars) car.add(meshAt(new THREE.BoxGeometry(0.55, 2.3, 2.2), m.bellows, ux(Lc - 0.05), 1.05, 0));
      if (train.pantographCars.includes(c)) this.addPantograph(car, ux(Lc / 2), roof, m);

      // Double-leaf plug doors, three per side; the platform-side ones open.
      const lw = train.doorWidthM / 2;
      for (const o of doorOffsetsInCar(train, c)) {
        for (const side of [-1, 1]) {
          for (const leafSide of [-1, 1]) {
            const leaf = new THREE.Group();
            leaf.add(meshAt(new THREE.BoxGeometry(lw, 1.98, 0.05), m.door, 0, 0.99, 0));
            leaf.add(meshAt(new THREE.BoxGeometry(0.03, 1.98, 0.065), m.trim, -leafSide * (lw / 2), 0.99, 0));
            const baseX = ux(o) + leafSide * (lw / 2);
            leaf.position.set(baseX, 0, side * (W / 2 + 0.02));
            car.add(leaf);
            if (side === -1) this.trainDoors.push({ obj: leaf, base: baseX, dir: leafSide, width: lw, axis: 'x' });
          }
          car.add(meshAt(new THREE.BoxGeometry(0.4, 0.05, 0.04), m.doorLamp, ux(o), 2.08, side * (W / 2 + 0.03)));
        }
      }

      this.buildInterior(car, c, ux, train, m);
      if (c === 1) car.add(this.cab(ux(0), fwd, W, roof, m));
      if (c === train.cars) car.add(this.cab(ux(Lc), -fwd, W, roof, m));

      const tag = pill(`Car ${c}`, '#ffffff', 'rgba(12,14,18,0.8)', 0.7);
      tag.position.set(0, roof + 1.0, 0);
      car.add(tag);
      this.carLabels.push(tag);
      this.train.add(car);
    }

    this.trainPeople = new Crowd(train.cars * PEOPLE_PER_FULL_CAR, undefined, false, true);
    if (this.peopleTemplates.length) this.trainPeople.setTemplates(this.peopleTemplates, NEAR_PEOPLE);
    this.trainPeople.group.position.z = TRACK_Z;
    this.train.add(this.trainPeople.group);
    this.train.visible = false;
  }

  private addBogie(car: THREE.Group, x: number, train: TrainSpec, m: TrainMaterials) {
    const railY = -train.floorHeightM;
    const r = 0.41;
    car.add(meshAt(new THREE.BoxGeometry(2.9, 0.3, 2.0), m.under, x, railY + r + 0.05, 0));
    for (const dx of [-1.25, 1.25]) {
      for (const dz of [-0.72, 0.72]) {
        const wheel = meshAt(new THREE.CylinderGeometry(r, r, 0.14, 20), m.wheel, x + dx, railY + r, dz);
        wheel.rotation.x = Math.PI / 2;
        car.add(wheel);
      }
    }
  }

  private addPantograph(car: THREE.Group, x: number, roof: number, m: TrainMaterials) {
    car.add(meshAt(new THREE.BoxGeometry(2.2, 0.12, 1.2), m.under, x, roof + 0.06, 0));
    const lower = meshAt(new THREE.BoxGeometry(1.5, 0.05, 0.05), m.wheel, x - 0.45, roof + 0.45, 0);
    lower.rotation.z = 0.55;
    const upper = meshAt(new THREE.BoxGeometry(1.5, 0.05, 0.05), m.wheel, x + 0.25, roof + 0.95, 0);
    upper.rotation.z = -0.65;
    car.add(lower, upper, meshAt(new THREE.BoxGeometry(0.12, 0.06, 1.6), m.wheel, x + 0.7, roof + 1.38, 0));
  }

  // Interior per the data sheet: DMS cars all longitudinal; PMS/MS cars add a 2+2 bay of
  // facing seats in the middle of each saloon; TS(W) has wheelchair spaces by the end doors.
  private buildInterior(car: THREE.Group, c: number, ux: (u: number) => number, train: TrainSpec, m: TrainMaterials) {
    const W = train.widthM;
    const Lc = train.carLengthsM[c - 1];
    const type = train.carTypes[c - 1];
    const a0 = c === 1 ? train.cabLengthM + 0.3 : 0.3;
    const b0 = c === train.cars ? Lc - train.cabLengthM - 0.3 : Lc - 0.3;
    const mid = ux((a0 + b0) / 2);
    car.add(meshAt(new THREE.BoxGeometry(b0 - a0, 0.04, W - 0.12), m.floor, mid, 0.02, 0));
    for (const dz of [-0.55, 0.55]) car.add(meshAt(new THREE.BoxGeometry(b0 - a0, 0.03, 0.35), m.ceilingLight, mid, 2.22, dz));
    const doors = doorOffsetsInCar(train, c);
    const edges = [a0, ...doors.flatMap((o) => [o - train.doorWidthM / 2 - 0.25, o + train.doorWidthM / 2 + 0.25]), b0];
    const bench = (a: number, b: number, side: number) => {
      if (b - a < 0.5) return;
      car.add(meshAt(new THREE.BoxGeometry(b - a, 0.12, 0.48), m.seat, ux((a + b) / 2), 0.45, side * (W / 2 - 0.36)));
      car.add(meshAt(new THREE.BoxGeometry(b - a, 0.5, 0.08), m.seat, ux((a + b) / 2), 0.8, side * (W / 2 - 0.14)));
    };
    const wheelchair = type === 'TS(W)';
    const bays = type.startsWith('MS') || type === 'PMS';
    for (let i = 0; i < edges.length; i += 2) {
      const [a, b] = [edges[i], edges[i + 1]];
      if (b - a < 1) continue;
      const centre = (a + b) / 2;
      for (const side of [-1, 1]) {
        if (bays && b - a > 5) {
          // Longitudinal seats either side of a facing bay.
          bench(a, centre - 1.15, side);
          bench(centre + 1.15, b, side);
          for (const dir of [-1, 1]) {
            const u = centre + dir * 0.6;
            car.add(meshAt(new THREE.BoxGeometry(0.48, 0.12, 0.95), m.seat, ux(u), 0.45, side * (W / 2 - 0.6)));
            car.add(meshAt(new THREE.BoxGeometry(0.08, 0.6, 0.95), m.seat, ux(u + dir * 0.24), 0.82, side * (W / 2 - 0.6)));
          }
        } else if (wheelchair && (i === 0 || i === edges.length - 2)) {
          // Wheelchair space next to the end doorway: marked floor, perch rail, fewer seats.
          const nearDoor = i === 0 ? b : a;
          const span = i === 0 ? [nearDoor - 1.4, nearDoor] : [nearDoor, nearDoor + 1.4];
          car.add(meshAt(new THREE.BoxGeometry(1.4, 0.01, 0.9), m.wheelchairFloor, ux((span[0] + span[1]) / 2), 0.05, side * (W / 2 - 0.55)));
          car.add(meshAt(new THREE.BoxGeometry(1.3, 0.05, 0.05), m.pole, ux((span[0] + span[1]) / 2), 0.85, side * (W / 2 - 0.12)));
          if (i === 0) bench(a, span[0] - 0.1, side);
          else bench(span[1] + 0.1, b, side);
        } else {
          bench(a, b, side);
        }
      }
      for (const u of [a, b]) {
        for (const dz of [-0.62, 0.62]) car.add(meshAt(new THREE.CylinderGeometry(0.02, 0.02, 2.2, 8), m.pole, ux(u), 1.1, dz));
      }
    }
  }

  // Cab nose. `tip` is the nose tip in car-local x, `out` the direction the nose points.
  // Built in a frame where the nose points along +x, then turned round for the rear cab.
  private cab(tip: number, out: number, W: number, roof: number, m: TrainMaterials) {
    const g = new THREE.Group();
    const p1 = new THREE.Vector2(1.45, roof - 0.35); // top of windscreen
    const p2 = new THREE.Vector2(2.15, 1.05); // bottom of windscreen
    const profile = new THREE.Shape();
    profile.moveTo(0, -0.75);
    profile.lineTo(0, roof);
    profile.lineTo(0.7, roof - 0.02);
    profile.quadraticCurveTo(1.25, roof - 0.05, p1.x, p1.y);
    profile.lineTo(p2.x, p2.y);
    profile.quadraticCurveTo(2.38, 0.7, 2.4, 0.2);
    profile.lineTo(2.36, -0.75);
    profile.lineTo(0, -0.75);
    const depth = W - 0.3;
    const geo = new THREE.ExtrudeGeometry(profile, { depth, bevelEnabled: true, bevelThickness: 0.15, bevelSize: 0.12, bevelSegments: 4, curveSegments: 12 });
    geo.translate(0, 0, -depth / 2);
    g.add(new THREE.Mesh(geo, m.body));

    // Black windscreen wrapping round onto the cab sides.
    const d = p2.clone().sub(p1);
    const n = new THREE.Vector2(-d.y, d.x).normalize();
    const screen = meshAt(new THREE.BoxGeometry(d.length() + 0.35, 0.04, W + 0.02), m.cabBlack, (p1.x + p2.x) / 2 + n.x * 0.13, (p1.y + p2.y) / 2 + n.y * 0.13, 0);
    screen.rotation.z = Math.atan2(d.y, d.x);
    g.add(screen);
    for (const side of [-1, 1]) {
      const wrap = new THREE.Shape();
      wrap.moveTo(1.0, roof - 0.25);
      wrap.lineTo(p1.x + 0.05, roof - 0.3);
      wrap.lineTo(p2.x + 0.1, p2.y - 0.05);
      wrap.lineTo(1.55, 0.95);
      wrap.quadraticCurveTo(1.05, 1.2, 1.0, roof - 0.25);
      const panel = new THREE.Mesh(new THREE.ShapeGeometry(wrap), m.cabBlackSides);
      panel.position.z = side * (W / 2 + 0.005);
      g.add(panel);
      // Orange marker line along the roof edge, and the unit number low on the cab side.
      g.add(meshAt(new THREE.BoxGeometry(2.2, 0.03, 0.03), m.roofLine, 1.0, roof - 0.12, side * (W / 2 - 0.02)));
      const num = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.12), new THREE.MeshBasicMaterial({ map: textTexture('345 002', '#1a1a1a', '#f3f4f6'), transparent: true }));
      num.position.set(1.2, -0.45, side * (W / 2 + 0.01));
      num.rotation.y = side > 0 ? 0 : Math.PI;
      g.add(num);
    }
    // Destination blind at the top of the windscreen.
    const destAt = p1.clone().addScaledVector(d, 0.12).addScaledVector(n, 0.16);
    const dest = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 0.2),
      new THREE.MeshBasicMaterial({ map: textTexture(this.dir === 'east' ? 'ABBEY WOOD' : 'READING', '#ffb000', '#050505'), toneMapped: false }),
    );
    dest.position.set(destAt.x, destAt.y, 0);
    dest.lookAt(destAt.x + n.x, destAt.y + n.y, 0);
    g.add(dest);
    // Lower front: black bumper with coupler, light clusters in black housings at the corners.
    // The extrusion bevel pushes the nose surface out to about x = 2.52.
    g.add(meshAt(new THREE.BoxGeometry(0.14, 0.62, W - 0.2), m.cabBlack, 2.48, -0.42, 0));
    g.add(meshAt(new THREE.BoxGeometry(0.35, 0.22, 0.5), m.under, 2.62, -0.55, 0));
    const leading = out === (this.dir === 'east' ? 1 : -1);
    for (const dz of [-0.92, 0.92]) {
      g.add(meshAt(new RoundedBoxGeometry(0.1, 0.34, 0.6, 2, 0.06), m.cabBlack, 2.53, 0.22, dz));
      const big = meshAt(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 16), leading ? m.headlight : m.unlit, 2.585, 0.22, dz - Math.sign(dz) * 0.12);
      const small = meshAt(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12), leading ? m.unlit : m.taillight, 2.585, 0.22, dz + Math.sign(dz) * 0.14);
      big.rotation.z = small.rotation.z = Math.PI / 2;
      g.add(big, small);
    }
    // Cab side door with its window.
    for (const side of [-1, 1]) {
      g.add(meshAt(new THREE.BoxGeometry(0.75, 1.9, 0.02), m.trim, 0.45, 0.85, side * (W / 2 + 0.004)));
      g.add(meshAt(new THREE.BoxGeometry(0.62, 1.84, 0.02), m.body, 0.45, 0.85, side * (W / 2 + 0.008)));
      g.add(meshAt(new THREE.BoxGeometry(0.32, 0.55, 0.02), m.cabBlack, 0.45, 1.45, side * (W / 2 + 0.012)));
    }

    g.position.x = tip - out * 2.4;
    g.rotation.y = out > 0 ? 0 : Math.PI;
    return g;
  }

  setLoads(loads: CarLoad[], highlightCar: number | undefined, seed: number) {
    const train = this.line?.train;
    if (!train) return;
    const fwd = this.dir === 'east' ? 1 : -1;
    const rand = mulberry32(seed);
    const spots: PersonSpot[] = [];
    loads.forEach(({ car, load, seats, freeSeats, noiseDb }, i) => {
      const old = this.carLabels[i];
      if (!old) return;
      const best = car === highlightCar;
      const tag = pill(
        best ? '★ WAIT HERE' : `${freeSeats}/${seats} FREE · ${noiseDb} dB`,
        '#ffffff',
        best ? '#15803d' : `#${loadColor(load).multiplyScalar(0.5).getHexString()}`,
        best ? 0.9 : 0.7,
      );
      tag.position.copy(old.position);
      old.parent?.add(tag);
      old.parent?.remove(old);
      disposeObject(old);
      this.carLabels[i] = tag;
      this.carDisplays[i]?.draw(car, load, best, seats, freeSeats, noiseDb);

      // Passengers fill the seats first (backs to the wall, facing the aisle), then stand.
      const Lc = train.carLengthsM[car - 1];
      const start = carStartFromFront(train, car);
      const doors = doorOffsetsInCar(train, car);
      const n = Math.round(load * PEOPLE_PER_FULL_CAR);
      const seated = Math.min(n, Math.round(PEOPLE_PER_FULL_CAR * 0.45));
      for (let k = 0; k < n; k++) {
        let u = 3 + rand() * (Lc - 6);
        const sit = k < seated;
        const nearDoor = doors.find((o) => Math.abs(u - o) < train.doorWidthM / 2 + 0.3);
        if (sit && nearDoor !== undefined) u = nearDoor + (u < nearDoor ? -1 : 1) * (train.doorWidthM / 2 + 0.6);
        const side = rand() < 0.5 ? -1 : 1;
        spots.push({
          pos: new THREE.Vector3(-fwd * (start + u), 0.02, sit ? side * (train.widthM / 2 - 0.5) : (rand() - 0.5) * 1.2),
          rotY: sit ? (side < 0 ? 0 : Math.PI) : rand() * Math.PI * 2,
          sit,
          accessory: rand() < 0.3 ? 'backpack' : rand() < 0.15 ? 'tote' : 'none',
        });
      }
    });
    this.trainPeople?.place(spots, rand);
  }

  // People waiting on the platform, bunched near entrances and passages.
  setPlatformCrowd(demand: number, seed: number) {
    if (!this.layout || !this.platformPeople) return;
    const rand = mulberry32(seed ^ 0x9e3779b9);
    const hubs = this.layout.landmarks.filter((l) => ['exit', 'interchange', 'lift', 'entrance', 'escalator'].includes(l.type));
    const n = Math.round(15 + demand * (MAX_PLATFORM_PEOPLE - 20));
    const spots: PersonSpot[] = [];
    for (let i = 0; i < n; i++) {
      let x = hubs.length && rand() < 0.55 ? hubs[Math.floor(rand() * hubs.length)].xM + gauss(rand) * 22 : 8 + rand() * (this.layout.lengthM - 16);
      x = Math.min(this.layout.lengthM - 3, Math.max(3, x));
      // Keep the recommended spot clear so it can be seen.
      const dt = this.wx(x) - this.target.position.x;
      if (this.target.visible && Math.abs(dt) < 2.2) x += (dt < 0 ? -1 : 1) * 2.6;
      // Most people queue close to the screen doors.
      const z = EDGE_Z - 0.7 - Math.abs(gauss(rand)) * 2.4;
      const r = rand();
      spots.push({
        pos: new THREE.Vector3(this.wx(x), 0, Math.max(WALL_Z + 1.2, z)),
        // Mostly facing the doors, some turned to look along the platform.
        rotY: rand() < 0.75 ? (rand() - 0.5) * 0.9 : (rand() < 0.5 ? 1 : -1) * Math.PI / 2,
        accessory: r < 0.04 ? 'pram' : r < 0.14 ? 'suitcase' : r < 0.4 ? 'backpack' : r < 0.55 ? 'tote' : 'none',
      });
    }
    this.platformPeople.place(spots, rand);
  }

  setTrainPhase(t: TrainPhase) {
    if (!this.layout || !this.line) return;
    let open = 0;
    if (t.phase === 'away') {
      this.train.visible = this.boarded;
    } else {
      this.train.visible = true;
      const stop = trainFrontX(this.layout, this.line.train, this.dir);
      const sign = this.dir === 'east' ? 1 : -1;
      const travel = this.layout.lengthM + 320;
      let x = stop;
      if (t.phase === 'approach') x = stop - sign * travel * (1 - t.p) ** 2.2;
      if (t.phase === 'depart') x = stop + sign * travel * t.p ** 2;
      this.train.position.x = this.wx(x);
      if (t.phase === 'dwell') open = smoothstep(0.02, 0.12, t.p) * (1 - smoothstep(0.85, 0.95, t.p));
    }
    this.doorsOpen = open;
    for (const leaf of this.doorLeaves) leaf.obj.position.x = leaf.baseX + leaf.dirX * open * 0.85;
    for (const leaf of this.trainDoors) leaf.obj.position[leaf.axis] = leaf.base + leaf.dir * open * leaf.width * 0.95;
  }

  // ---------- Markers ----------

  private buildMarkers() {
    const green = '#22c55e';
    const z = EDGE_Z - 1.2;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.15, 48), new THREE.MeshBasicMaterial({ color: green, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.03, z);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.8, 48),
      new THREE.MeshBasicMaterial({ color: green, transparent: true, opacity: 0.25, side: THREE.DoubleSide }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(0, 0.025, z);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.75, 0.75, 7, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: green, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    beam.position.set(0, 3.5, z);
    const tag = pill('WAIT HERE', '#ffffff', '#15803d', 1.1);
    tag.position.set(0, 7.6, z);
    const light = new THREE.PointLight(green, 8, 8, 2);
    light.position.set(0, 1.5, z);
    this.target.add(ring, disc, beam, tag, light);
    this.target.visible = false;

    const youRing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.7, 40), new THREE.MeshBasicMaterial({ color: '#3b82f6', side: THREE.DoubleSide }));
    youRing.rotation.x = -Math.PI / 2;
    youRing.position.set(0, 0.03, EDGE_Z - 3);
    const youTag = pill('YOU', '#ffffff', '#1d4ed8', 1);
    youTag.position.set(0, 3, EDGE_Z - 3);
    this.user.add(youRing, youTag);
    this.user.visible = false;
  }

  setTarget(x?: number) {
    this.target.visible = x !== undefined;
    if (x !== undefined) this.target.position.x = this.wx(x);
  }

  setUser(x?: number) {
    this.userShown = x !== undefined;
    this.user.visible = this.userShown && !this.walk.active;
    if (x !== undefined) this.user.position.x = this.wx(x);
  }

  // ---------- Camera ----------

  // Start at eye level at the end of the platform, then pull back to the cut-away overview.
  private intro() {
    const L = this.layout?.lengthM ?? 250;
    const startX = this.dir === 'east' ? -L / 2 + 5 : L / 2 - 5;
    this.camera.position.set(startX, 1.7, -1.5);
    this.controls.target.set(startX - Math.sign(startX) * 30, 1.6, 0);
    this.camGoal = undefined;
    setTimeout(() => this.overview(0.025), 700);
  }

  overview(speed = 0.05) {
    // Look down over the train roof into the platform, framed around the wait spot.
    const x = this.target.visible ? this.target.position.x : 0;
    this.flyTo(new THREE.Vector3(x - 32, 34, 34), new THREE.Vector3(x + 4, 0, -1.5), speed);
  }

  // ---------- Walk mode ----------

  get walking() {
    return this.walk.active;
  }

  // Start where the passenger walks onto the platform (station x), facing the track.
  startWalk(startX?: number) {
    if (!this.layout) return;
    const w = this.walk;
    w.active = true;
    this.boarded = false;
    this.boardingT = -1;
    const x = startX !== undefined ? this.wx(startX) : this.target.visible ? this.target.position.x : 0;
    w.pos.set(x, EYE_HEIGHT, WALL_Z + 1.3);
    w.yaw = 0;
    w.pitch = -0.08;
    w.lastX = w.reportX = w.pos.x;
    // A wider, human field of view while walking.
    this.camera.fov = 68;
    this.camera.updateProjectionMatrix();
    w.keys.clear();
    this.camGoal = undefined;
    this.controls.enabled = false;
    this.user.visible = false;
  }

  // Testing aid: board through the door at the wait spot (doors must be open).
  debugBoard() {
    const door = this.openDoorAt(this.target.position.x);
    if (door !== undefined) this.board(door);
    return door !== undefined;
  }

  // Testing aid: stand on the wait spot, facing the doors.
  debugPlaceAtTarget() {
    this.walk.pos.set(this.target.position.x, EYE_HEIGHT, TARGET_Z);
    this.walk.lastX = this.walk.reportX = this.walk.pos.x;
    this.walk.yaw = 0;
  }

  stopWalk() {
    const w = this.walk;
    if (!w.active) return;
    w.active = false;
    this.boarded = false;
    w.keys.clear();
    this.camera.fov = 42;
    this.camera.updateProjectionMatrix();
    this.controls.enabled = true;
    this.controls.target.copy(this.camera.position).add(this.lookDir().multiplyScalar(5));
    this.user.visible = this.userShown;
  }

  // Held-key state, also driven by the on-screen arrow pad.
  setKey(key: string, down: boolean) {
    if (down) this.walk.keys.add(key);
    else this.walk.keys.delete(key);
  }

  private lookDir() {
    const { yaw, pitch } = this.walk;
    return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  }

  private bindWalkInput() {
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'];
    const typing = (e: KeyboardEvent) => ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
    window.addEventListener('keydown', (e) => {
      if (!this.walk.active || typing(e) || !keys.includes(e.code)) return;
      e.preventDefault();
      this.walk.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.walk.keys.delete(e.code));
    window.addEventListener('blur', () => this.walk.keys.clear());
    // Drag to look around.
    const el = this.renderer.domElement;
    let drag: { x: number; y: number } | undefined;
    el.addEventListener('pointerdown', (e) => {
      if (!this.walk.active) return;
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || !this.walk.active) return;
      this.walk.yaw -= (e.clientX - drag.x) * 0.004;
      this.walk.pitch = Math.max(-0.9, Math.min(0.7, this.walk.pitch - (e.clientY - drag.y) * 0.003));
      drag = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', () => (drag = undefined));
  }

  private stepWalk(dt: number, t: number) {
    const w = this.walk;
    const k = w.keys;
    const run = k.has('ShiftLeft') || k.has('ShiftRight') ? 2.4 : 1;
    // Left/right arrows (or Q/E) turn; up/down (or W/S) walk; A/D sidestep.
    const turn = (k.has('ArrowLeft') || k.has('KeyQ') ? 1 : 0) - (k.has('ArrowRight') || k.has('KeyE') ? 1 : 0);
    w.yaw += turn * 1.7 * dt;
    const fwd = (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0) - (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const f = new THREE.Vector3(Math.sin(w.yaw), 0, Math.cos(w.yaw));
    const r = new THREE.Vector3(-Math.cos(w.yaw), 0, Math.sin(w.yaw));
    const move = f.multiplyScalar(fwd).add(r.multiplyScalar(side));
    const moving = move.lengthSq() > 0 && this.boardingT < 0;
    if (moving) w.pos.addScaledVector(move.normalize(), WALK_SPEED * run * this.speedScale * dt);

    const W = this.line?.train.widthM ?? 2.8;
    if (this.boarded) {
      // Riding: stay inside the car and move with the train.
      if (this.boardingT >= 0) {
        // Step in and turn to face along the car.
        this.boardingT = Math.min(1, this.boardingT + dt / 1.4);
        const e = smoothstep(0, 1, this.boardingT);
        w.pos.z = THREE.MathUtils.lerp(EDGE_Z + 0.5, TRACK_Z - 0.3, e);
        w.yaw = THREE.MathUtils.lerp(w.boardYaw0, w.boardYaw1, e);
        if (this.boardingT >= 1) this.boardingT = -1;
      }
      w.pos.z = Math.max(TRACK_Z - W / 2 + 0.35, Math.min(TRACK_Z + W / 2 - 0.35, w.pos.z));
      this.boardOffset += moving ? w.pos.x - w.lastX : 0;
      w.pos.x = this.train.position.x + this.boardOffset;
    } else {
      // Stay on the platform, except through an open doorway when the train is in.
      w.pos.x = Math.max(-this.half + 0.8, Math.min(this.half - 0.8, w.pos.x));
      const door = this.openDoorAt(w.pos.x);
      const maxZ = door !== undefined ? EDGE_Z + 0.6 : EDGE_Z - 0.35;
      w.pos.z = Math.max(WALL_Z + 0.45, Math.min(maxZ, w.pos.z));
      if (door !== undefined && w.pos.z > EDGE_Z + 0.45) this.board(door);
    }
    w.lastX = w.pos.x;
    w.bob = moving ? w.bob + dt * 9 * run : w.bob * 0.9;
    this.camera.position.set(w.pos.x, EYE_HEIGHT + Math.sin(w.bob) * 0.025, w.pos.z);
    this.camera.lookAt(this.camera.position.clone().add(this.lookDir()));

    if (t - w.lastReport > 0.2 && this.onWalk) {
      w.lastReport = t;
      this.onWalk(this.walkInfo());
    }
  }

  // The car door you are standing in front of, if the doors are open.
  private openDoorAt(x: number) {
    if (!this.layout || !this.line || this.doorsOpen < 0.8 || !this.train.visible) return undefined;
    const half = this.line.train.doorWidthM / 2 - 0.15;
    for (const d of this.doorPositions(this.layout)) {
      if (Math.abs(this.wx(d) - x) < half) return d;
    }
    return undefined;
  }

  private board(doorX: number) {
    if (!this.layout || !this.line) return;
    const w = this.walk;
    this.boarded = true;
    this.boardingT = 0;
    w.pos.x = this.wx(doorX);
    this.boardOffset = w.pos.x - this.train.position.x;
    w.boardYaw0 = w.yaw;
    // Face towards the front of the train once inside.
    w.boardYaw1 = this.dir === 'east' ? Math.PI / 2 : -Math.PI / 2;
    w.keys.clear();
    this.onBoard?.(carAtX(this.layout, this.line.train, this.dir, doorX) ?? 0);
  }

  private walkInfo(): WalkInfo {
    const w = this.walk;
    const tx = this.target.position.x;
    const along = tx - w.pos.x;
    const distance = Math.hypot(along, TARGET_Z - w.pos.z);
    // Direction to walk: along the platform while far away, then straight to the spot.
    const d = Math.abs(along) > 1.5 ? new THREE.Vector3(Math.sign(along), 0, 0) : new THREE.Vector3(along, 0, TARGET_Z - w.pos.z).normalize();
    const ahead = d.dot(new THREE.Vector3(Math.sin(w.yaw), 0, Math.cos(w.yaw)));
    const right = d.dot(new THREE.Vector3(-Math.cos(w.yaw), 0, Math.sin(w.yaw)));
    const turn: Turn = ahead > 0.8 ? 'ahead' : ahead < -0.6 ? 'around' : right > 0 ? 'right' : 'left';

    const marks = (this.layout?.landmarks ?? []).filter((l) => l.type !== 'platform-end');
    const between = marks
      .map((l) => ({ name: l.name, x: this.wx(l.xM) }))
      .filter((l) => (l.x - w.pos.x) * Math.sign(along) > 1 && (tx - l.x) * Math.sign(along) > 1)
      .sort((a, b) => Math.abs(a.x - w.pos.x) - Math.abs(b.x - w.pos.x));
    const next = between[0] ? { name: between[0].name, distance: Math.abs(between[0].x - w.pos.x) } : undefined;
    const passedMark = marks.find((l) => {
      const x = this.wx(l.xM);
      return (x - w.reportX) * (x - w.pos.x) < 0;
    });
    w.reportX = w.pos.x;

    return {
      stationX: w.pos.x + this.half,
      along: Math.abs(along),
      distance,
      turn,
      next,
      passed: passedMark?.name,
      // Also "arrived" while stepping from the circle towards the doors.
      arrived: distance < 1.0 || (Math.abs(along) < 0.7 && w.pos.z > TARGET_Z - 0.3),
      doorsOpen: this.doorsOpen > 0.8 && this.train.visible,
      boarded: this.boarded,
    };
  }

  // Three-quarter view of the leading cab from the platform end, looking back along the train
  // (the classic platform photo of a Class 345).
  trainView() {
    if (!this.layout || !this.line) return;
    const fwd = this.dir === 'east' ? 1 : -1;
    const nose = this.wx(trainFrontX(this.layout, this.line.train, this.dir));
    this.flyTo(new THREE.Vector3(nose + fwd * 11, 1.9, TRACK_Z + 3.2), new THREE.Vector3(nose - fwd * 10, 0.8, TRACK_Z - 0.5), 0.05);
  }

  // First-person view from where the user stands, looking along the platform towards the target.
  eyeLevel() {
    const ux = this.user.visible ? this.user.position.x : this.wx(10);
    const tx = this.target.visible ? this.target.position.x : 0;
    const look = Math.sign(tx - ux || 1);
    // Stand by the back wall, behind the queue at the doors, so nobody blocks the view.
    this.flyTo(new THREE.Vector3(ux - look * 2, 1.7, WALL_Z + 0.6), new THREE.Vector3(ux + look * 25, 1.3, EDGE_Z - 1.5), 0.05);
  }

  private flyTo(pos: THREE.Vector3, look: THREE.Vector3, speed: number) {
    this.stopWalk();
    this.camGoal = { pos, look, speed };
  }

  // Jump straight to the current camera goal (used for screenshots and reduced motion).
  snap() {
    if (!this.camGoal) return;
    this.camera.position.copy(this.camGoal.pos);
    this.controls.target.copy(this.camGoal.look);
    this.camGoal = undefined;
  }

  // ---------- Loop ----------

  // Orbiting or zooming must never push the camera through the back wall or under the floor.
  private keepOutOfWalls() {
    const p = this.camera.position;
    const inside = Math.abs(p.x) < this.half && p.y < (this.layout?.theme ? TCR_CEIL : TUNNEL_R);
    if (inside && p.z < WALL_Z + 0.4) p.z = WALL_Z + 0.4;
    if (p.y < 0.4 && p.z < EDGE_Z) p.y = 0.4;
    if (this.controls.target.y < 0) this.controls.target.y = 0;
  }

  private wx(stationX: number) {
    return stationX - this.half;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    // Long frames are clamped; the test speed-up also lifts the clamp for slow headless runs.
    const dt = Math.min(0.1 * this.speedScale, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    if (this.walk.active) this.stepWalk(dt, t);
    else if (this.camGoal) {
      const k = this.camGoal.speed;
      this.camera.position.lerp(this.camGoal.pos, k);
      this.controls.target.lerp(this.camGoal.look, k);
      if (this.camera.position.distanceTo(this.camGoal.pos) < 0.05) this.camGoal = undefined;
    }
    if (!this.walk.active) this.keepOutOfWalls();
    if (t - this.lodAt > 0.3) {
      this.lodAt = t;
      this.platformPeople?.updateLod(this.camera.position, NEAR_PEOPLE);
      if (this.train.visible) this.trainPeople?.updateLod(this.camera.position, NEAR_PEOPLE);
    }
    this.platformPeople?.animate(t);
    // Floating car labels are for the overview; on foot the platform displays do that job.
    for (const tag of this.carLabels) tag.visible = false;
    // Close up, the light column and label would only get in the way.
    const near = this.camera.position.distanceTo(this.target.position) < 14;
    for (const i of [2, 3, 4]) this.target.children[i].visible = !near;
    const pulse = 1 + 0.18 * Math.sin(t * 4);
    this.target.children[0].scale.set(pulse, pulse, pulse);
    if (!this.walk.active) this.controls.update();
    this.composer.render();
  }
}

// ---------- People (instanced, articulated low-poly figures) ----------

export type Accessory = 'none' | 'backpack' | 'tote' | 'suitcase' | 'pram';

export interface PersonSpot {
  pos: THREE.Vector3; // feet (or seat front edge for seated people)
  rotY: number; // 0 = facing +z
  sit?: boolean;
  accessory?: Accessory;
}

const SKIN = ['#f3d2b5', '#e8b98f', '#c98e62', '#a8714a', '#7a4a2c', '#5a3520', '#f1c9a5', '#d9a37a'];
const HAIR = ['#141110', '#2b1d14', '#4a3022', '#6b4a2e', '#a0784a', '#d6b47a', '#8c8c8c', '#3a2a20'];
const TOPS = ['#1b1d22', '#232a3a', '#3b3f46', '#6b6f76', '#c9b48f', '#4b5a3a', '#6e2430', '#e9e7e2', '#2f4a6b', '#8a5a3a', '#121212', '#5b3f6e'];
const BOTTOMS = ['#2a3550', '#1a1c20', '#3d4b6b', '#4a4d52', '#b8a587', '#22262c', '#5a6a85'];
const SHOES = ['#f2f2f2', '#141414', '#3a2a1e', '#d9d9d9', '#1f1f1f'];
const BAGS = ['#111111', '#2b2b30', '#5a3a22', '#7a1f2b', '#2a3f5f', '#c2a27a'];

type Part =
  | 'shoeL' | 'shoeR' | 'legL' | 'legR' | 'thighL' | 'thighR' | 'hips' | 'torso' | 'armL' | 'armR'
  | 'handL' | 'handR' | 'neck' | 'head' | 'hair' | 'longHair' | 'bag' | 'case' | 'handle' | 'pram' | 'pramHood' | 'wheels';

const BODY_PARTS: Part[] = [
  'shoeL', 'shoeR', 'legL', 'legR', 'thighL', 'thighR', 'hips', 'torso', 'armL', 'armR', 'handL', 'handR', 'neck', 'head', 'hair', 'longHair',
];

class Crowd {
  group = new THREE.Group();
  private parts = new Map<Part, THREE.InstancedMesh>();
  private max: number;
  private tint?: string;
  private moving: boolean;
  private realOnly: boolean;
  // Per person: placement (no scale) and pose, for swapping in scanned people.
  private persons: {
    m: THREE.Matrix4;
    base: THREE.Matrix4;
    sit: boolean;
    pick: number;
    motion?: { minX: number; maxX: number; speed: number; phase: number; dir: 1 | -1; baseX: number };
  }[] = [];
  private saved = new Map<Part, Float32Array>();
  private scanned: { t: PersonTemplate; mesh: THREE.InstancedMesh }[] = [];

  constructor(max: number, tint?: string, moving = false, realOnly = false) {
    this.max = max;
    this.tint = tint;
    this.moving = moving;
    this.realOnly = realOnly;
    const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 4, 10);
    const torso = new THREE.CylinderGeometry(0.19, 0.16, 0.56, 14);
    torso.scale(1, 1, 0.62);
    const head = new THREE.SphereGeometry(0.105, 16, 12);
    head.scale(0.92, 1.12, 1);
    const hair = new THREE.SphereGeometry(0.115, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
    hair.scale(0.95, 1.12, 1.05);
    const wheels = new THREE.TorusGeometry(0.12, 0.025, 6, 16);
    const defs: [Part, THREE.BufferGeometry][] = [
      ['shoeL', new RoundedBoxGeometry(0.1, 0.08, 0.26, 2, 0.03)],
      ['shoeR', new RoundedBoxGeometry(0.1, 0.08, 0.26, 2, 0.03)],
      ['legL', cap(0.068, 0.72)],
      ['legR', cap(0.068, 0.72)],
      ['thighL', cap(0.075, 0.36)],
      ['thighR', cap(0.075, 0.36)],
      ['hips', new RoundedBoxGeometry(0.33, 0.2, 0.21, 2, 0.06)],
      ['torso', torso],
      ['armL', cap(0.05, 0.5)],
      ['armR', cap(0.05, 0.5)],
      ['handL', new THREE.SphereGeometry(0.045, 8, 6)],
      ['handR', new THREE.SphereGeometry(0.045, 8, 6)],
      ['neck', new THREE.CylinderGeometry(0.045, 0.05, 0.1, 8)],
      ['head', head],
      ['hair', hair],
      ['longHair', new RoundedBoxGeometry(0.22, 0.32, 0.08, 2, 0.04)],
      ['bag', new RoundedBoxGeometry(0.3, 0.36, 0.15, 2, 0.04)],
      ['case', new RoundedBoxGeometry(0.4, 0.58, 0.24, 2, 0.04)],
      ['handle', new THREE.CylinderGeometry(0.012, 0.012, 0.45, 6)],
      ['pram', new RoundedBoxGeometry(0.42, 0.3, 0.7, 3, 0.1)],
      ['pramHood', new THREE.SphereGeometry(0.24, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)],
      ['wheels', wheels],
    ];
    for (const [name, geo] of defs) {
      const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.75 }), name === 'wheels' ? max * 4 : max);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.parts.set(name, mesh);
      this.group.add(mesh);
    }
  }

  // Scanned people to use for the nearest `capacity` people in this crowd.
  setTemplates(templates: PersonTemplate[], capacity: number) {
    this.group.visible = true;
    if (this.realOnly) capacity = this.max;
    for (const { mesh } of this.scanned) this.group.remove(mesh);
    this.scanned = templates.map((t) => {
      const mesh = new THREE.InstancedMesh(t.geometry, t.material, capacity);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return { t, mesh };
    });
    if (this.realOnly) for (const mesh of this.parts.values()) mesh.visible = false;
  }

  // Show scanned people for the k people closest to the camera, simple figures elsewhere.
  updateLod(camera: THREE.Vector3, k: number) {
    if (!this.scanned.length || !this.persons.length) return;
    this.group.updateWorldMatrix(true, false);
    const world = this.group.matrixWorld;
    const v = new THREE.Vector3();
    const near = this.persons
      .map((p, i) => ({ i, d: v.setFromMatrixPosition(p.m).applyMatrix4(world).distanceToSquared(camera) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.realOnly ? this.persons.length : k)
      .filter((x) => this.realOnly || x.d < 45 * 45);
    for (const part of BODY_PARTS) {
      const mesh = this.parts.get(part)!;
      const saved = this.saved.get(part);
      if (saved) (mesh.instanceMatrix.array as Float32Array).set(saved);
    }
    const counts = this.scanned.map(() => 0);
    for (const { i } of near) {
      const p = this.persons[i];
      const options = this.scanned.map((s, j) => ({ s, j })).filter(({ s }) => s.t.pose === (p.sit ? 'sit' : 'stand'));
      if (!options.length) continue;
      const ordered = options.slice(p.pick % options.length).concat(options.slice(0, p.pick % options.length));
      const selected = this.realOnly ? ordered.find(({ j }) => counts[j] === 0) : ordered[0];
      if (!selected) continue;
      const { s, j } = selected;
      if (counts[j] >= s.mesh.instanceMatrix.count) continue;
      s.mesh.setMatrixAt(counts[j]++, p.m);
      for (const part of BODY_PARTS) (this.parts.get(part)!.instanceMatrix.array as Float32Array).fill(0, i * 16, i * 16 + 16);
    }
    this.scanned.forEach((s, j) => {
      s.mesh.count = counts[j];
      s.mesh.instanceMatrix.needsUpdate = true;
    });
    for (const part of BODY_PARTS) this.parts.get(part)!.instanceMatrix.needsUpdate = true;
  }

  // Move a subset of the platform crowd along the platform. Each passenger has a
  // different speed and travel corridor; wrapping at the ends keeps the flow continuous.
  animate(t: number) {
    if (!this.moving || !this.persons.length) return;
    const base = new THREE.Matrix4();
    const shift = new THREE.Matrix4();
    const out = new THREE.Matrix4();
    for (let i = 0; i < this.persons.length; i++) {
      const p = this.persons[i];
      if (!p.motion) continue;
      const m = p.motion;
      const span = Math.max(1, m.maxX - m.minX);
      const travel = (t * m.speed + m.phase) % span;
      const x = m.dir > 0 ? m.minX + travel : m.maxX - travel;
      const bob = Math.sin(t * m.speed * 8 + m.phase) * 0.012;
      shift.makeTranslation(x - m.baseX, bob, 0);
      p.m.copy(out.multiplyMatrices(shift, p.base));
      for (const [part, mesh] of this.parts) {
        if (part === 'wheels') continue;
        const saved = this.saved.get(part);
        if (!saved) continue;
        base.fromArray(saved, i * 16);
        mesh.setMatrixAt(i, out.multiplyMatrices(shift, base));
      }
    }
    for (const [part, mesh] of this.parts) {
      if (part !== 'wheels') mesh.instanceMatrix.needsUpdate = true;
    }
  }

  place(spots: PersonSpot[], rand: () => number) {
    const n = Math.min(spots.length, this.max);
    this.persons = [];
    const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
    const person = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const out = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const c = new THREE.Color();
    let wheelIdx = 0;
    const minCrowdX = spots.length ? Math.min(...spots.map((p) => p.pos.x)) : 0;
    const maxCrowdX = spots.length ? Math.max(...spots.map((p) => p.pos.x)) : 0;

    const set = (part: Part, i: number, x: number, y: number, z: number, color: string, rx = 0, rz = 0, s = 1) => {
      e.set(rx, 0, rz);
      local.compose(v.set(x, y, z), q.setFromEuler(e), sc.set(s, s, s));
      out.multiplyMatrices(person, local);
      const mesh = this.parts.get(part)!;
      mesh.setMatrixAt(i, out);
      mesh.setColorAt(i, c.set(color));
    };
    const hide = (part: Part, i: number) => this.parts.get(part)!.setMatrixAt(i, zero);

    for (let i = 0; i < n; i++) {
      const p = spots[i];
      const walks = this.moving && !p.sit && p.accessory !== 'pram' && rand() < 0.58;
      const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
      const rotY = walks ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : p.rotY;
      const female = rand() < 0.5;
      const height = (female ? 1.6 : 1.72) + (rand() - 0.5) * 0.18;
      const s = height / 1.75;
      const build = 0.9 + rand() * 0.25;
      person.compose(p.pos, q.setFromEuler(e.set(0, rotY, 0)), sc.set(s * build, s, s * build));
      const scanMatrix = new THREE.Matrix4().compose(p.pos, q, new THREE.Vector3(s, s, s));
      const corridor = 10 + rand() * 32;
      const minX = Math.max(minCrowdX, p.pos.x - corridor);
      const maxX = Math.min(maxCrowdX, p.pos.x + corridor);
      this.persons.push({
        m: scanMatrix.clone(),
        base: scanMatrix.clone(),
        sit: !!p.sit,
        pick: Math.floor(rand() * 1e6),
        motion: walks && maxX - minX > 3 ? { minX, maxX, speed: 0.45 + rand() * 0.65, phase: rand() * (maxX - minX), dir, baseX: p.pos.x } : undefined,
      });

      const skin = pick(SKIN);
      const top = this.tint ?? pick(TOPS);
      const bottom = this.tint ? '#1e3a8a' : pick(BOTTOMS);
      const shoes = pick(SHOES);
      const hairC = rand() < 0.1 ? '#b9b9b9' : pick(HAIR);
      const drop = p.sit ? -0.44 : 0; // seated: upper body lowers onto the seat

      if (p.sit) {
        // Thighs forward along +z, shins down to the floor.
        set('thighL', i, -0.1, 0.5, 0.2, bottom, Math.PI / 2);
        set('thighR', i, 0.1, 0.5, 0.2, bottom, Math.PI / 2);
        set('legL', i, -0.1, 0.25, 0.42, bottom, 0, 0, 0.6);
        set('legR', i, 0.1, 0.25, 0.42, bottom, 0, 0, 0.6);
        set('shoeL', i, -0.1, 0.04, 0.48, shoes);
        set('shoeR', i, 0.1, 0.04, 0.48, shoes);
      } else {
        const stance = (rand() - 0.5) * 0.08;
        set('legL', i, -0.1, 0.5, stance, bottom);
        set('legR', i, 0.1, 0.5, -stance, bottom);
        set('shoeL', i, -0.1, 0.04, stance + 0.04, shoes);
        set('shoeR', i, 0.1, 0.04, -stance + 0.04, shoes);
        hide('thighL', i);
        hide('thighR', i);
      }
      set('hips', i, 0, 0.95 + drop, 0, bottom);
      set('torso', i, 0, 1.3 + drop, 0, top, 0, 0, female ? 0.94 : 1);
      // Arms hang from the shoulders; some people raise one forward to look at a phone.
      // The arm pivots at the shoulder, so its centre and hand follow the swing angle.
      const shoulderY = 1.5 + drop;
      const swing = rand() < 0.35 ? -0.65 : 0;
      set('armL', i, -0.245, shoulderY - 0.3, 0, top, 0, 0.07);
      set('armR', i, 0.24, shoulderY - 0.3 * Math.cos(swing), -0.3 * Math.sin(swing), top, swing, -0.05);
      set('handL', i, -0.27, shoulderY - 0.6, 0.01, skin);
      set('handR', i, 0.25, shoulderY - 0.6 * Math.cos(swing), -0.6 * Math.sin(swing), skin);
      set('neck', i, 0, 1.62 + drop, 0, skin);
      set('head', i, 0, 1.76 + drop, 0.01, skin);
      set('hair', i, 0, 1.79 + drop, -0.012, hairC);
      if (female && rand() < 0.6) set('longHair', i, 0, 1.6 + drop, -0.09, hairC);
      else hide('longHair', i);

      const acc = p.accessory ?? 'none';
      if (acc === 'backpack') set('bag', i, 0, 1.3 + drop, -0.19, pick(BAGS));
      else if (acc === 'tote') set('bag', i, 0.33, 0.95 + drop, 0.02, pick(BAGS), 0, 0, 0.85);
      else hide('bag', i);
      if (acc === 'suitcase') {
        set('case', i, 0.45, 0.33, 0.1, pick(BAGS));
        set('handle', i, 0.45, 0.85, 0.1, '#777777');
      } else {
        hide('case', i);
        hide('handle', i);
      }
      if (acc === 'pram') {
        set('pram', i, 0, 0.62, 0.75, '#2a2d33');
        set('pramHood', i, 0, 0.72, 0.6, '#3a3f48', -0.4);
        for (const [wx, wz] of [[-0.2, 0.5], [0.2, 0.5], [-0.2, 1.0], [0.2, 1.0]]) {
          e.set(0, Math.PI / 2, 0);
          local.compose(v.set(wx, 0.12, wz), q.setFromEuler(e), sc.set(1, 1, 1));
          out.multiplyMatrices(person, local);
          const wm = this.parts.get('wheels')!;
          wm.setMatrixAt(wheelIdx, out);
          wm.setColorAt(wheelIdx++, c.set('#151515'));
        }
      } else {
        hide('pram', i);
        hide('pramHood', i);
      }
    }
    for (const [part, mesh] of this.parts) {
      if (part !== 'wheels') this.saved.set(part, (mesh.instanceMatrix.array as Float32Array).slice());
    }
    for (const { mesh } of this.scanned) mesh.count = 0;
    for (const [name, mesh] of this.parts) {
      mesh.count = name === 'wheels' ? wheelIdx : n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this.realOnly && !this.scanned.length) this.group.visible = false;
  }
}

// ---------- Train livery and displays ----------

// Colours of the Class 345. Geometry follows the published dimensions; these colours are
// the one thing to tune against reference photos.
const LIVERY = {
  body: '#f3f4f6',
  door: '#d9dbde',
  doorGlass: '#10161d',
  purple: '#8f6ccb',
  blueTop: '#5b68b4',
  blue: '#323f86',
  trim: '#1a1d22',
  cabBlack: '#0c0f13',
  under: '#2b2e33',
  seat: '#4a3f76',
  floor: '#9ea3aa',
};

type TrainMaterials = ReturnType<typeof trainMaterials>;

function trainMaterials() {
  const std = (color: string, rough = 0.5, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  return {
    body: std(LIVERY.body, 0.3, 0.15),
    door: doorMaterial(),
    roofLine: new THREE.MeshStandardMaterial({ color: '#ff7a1a', emissive: '#ff6a00', emissiveIntensity: 0.6 }),
    unlit: std('#e9e9e9', 0.2, 0.3),
    doorGlass: new THREE.MeshPhysicalMaterial({ color: LIVERY.doorGlass, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.75 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#0d141b', roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.55, depthWrite: false }),
    trim: std(LIVERY.trim, 0.5),
    cabBlack: new THREE.MeshPhysicalMaterial({ color: LIVERY.cabBlack, roughness: 0.08, metalness: 0.4 }),
    cabBlackSides: new THREE.MeshPhysicalMaterial({ color: LIVERY.cabBlack, roughness: 0.08, metalness: 0.4, side: THREE.DoubleSide }),
    under: std(LIVERY.under, 0.8),
    bellows: std('#1d1f23', 0.95),
    wheel: std('#55585e', 0.4, 0.8),
    seat: std(LIVERY.seat, 0.9),
    wheelchairFloor: std('#1f4fa8', 0.7),
    floor: std(LIVERY.floor, 0.8),
    pole: std('#c8ccd2', 0.25, 0.9),
    ceilingLight: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff8ee', emissiveIntensity: 1.4 }),
    doorLamp: new THREE.MeshStandardMaterial({ color: '#331100', emissive: '#ff9a1f', emissiveIntensity: 1.5 }),
    headlight: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 5 }),
    taillight: new THREE.MeshStandardMaterial({ color: '#330000', emissive: '#ff2020', emissiveIntensity: 3 }),
  };
}

// Class 345 door leaf: light grey with a tall dark window (per the TfL data sheet drawings).
let doorCanvas: HTMLCanvasElement | undefined;
function doorMaterial() {
  if (!doorCanvas) {
    const c = (doorCanvas = document.createElement('canvas'));
    c.width = 256;
    c.height = 700;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = LIVERY.door;
    ctx.fillRect(0, 0, 256, 700);
    ctx.fillStyle = LIVERY.doorGlass;
    ctx.beginPath();
    ctx.roundRect(78, 60, 100, 380, 18);
    ctx.fill();
    ctx.fillStyle = '#9ea2a8';
    ctx.fillRect(0, 0, 6, 700);
    ctx.fillRect(250, 0, 6, 700);
  }
  const tex = new THREE.CanvasTexture(doorCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3, metalness: 0.25 });
}

// Lower body band for one car: blue fading darker downwards, a roundel in each saloon bay,
// and the purple diagonal at the No.2 end. Canvas x runs with u (distance from the car front).
function bodyBandTexture(train: TrainSpec, car: number, uStart: number, len: number) {
  const pxPerM = 64;
  const c = document.createElement('canvas');
  c.width = Math.round(len * pxPerM);
  c.height = 96;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, LIVERY.blueTop);
  grad.addColorStop(1, LIVERY.blue);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(0, 0, c.width, 2);
  const doors = doorOffsetsInCar(train, car);
  const toX = (u: number) => (u - uStart) * pxPerM;
  for (let i = 0; i < doors.length - 1; i++) {
    const x = toX((doors[i] + doors[i + 1]) / 2);
    ctx.lineWidth = 7;
    ctx.strokeStyle = LIVERY.purple;
    ctx.beginPath();
    ctx.arc(x, 44, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#1b2a8c';
    ctx.fillRect(x - 24, 39, 48, 10);
  }
  if (car < train.cars) {
    ctx.fillStyle = LIVERY.purple;
    ctx.beginPath();
    ctx.moveTo(c.width - 70, 0);
    ctx.lineTo(c.width, 0);
    ctx.lineTo(c.width, c.height);
    ctx.lineTo(c.width - 150, c.height);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function textTexture(text: string, fg: string, bg: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 80;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = fg;
  ctx.font = '700 52px "Consolas", "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// LED display in the screen-door header showing how full the car stopping there is.
class CarDisplay {
  mesh: THREE.Mesh;
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;

  private suffix: string;

  constructor(widthM: number, suffix = '') {
    this.suffix = suffix;
    const c = document.createElement('canvas');
    c.width = 768;
    c.height = 64;
    this.ctx = c.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, widthM / 12), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
    this.draw(0, 0, false);
  }

  draw(car: number, load: number, best: boolean, seats = 0, freeSeats = 0, noiseDb = 0) {
    const { ctx } = this;
    const { width: w, height: h } = ctx.canvas;
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, h);
    if (!car) {
      this.tex.needsUpdate = true;
      return;
    }
    const color = `#${loadColor(load).getHexString()}`;
    ctx.font = '700 34px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = best ? '#4ade80' : '#e5e7eb';
    ctx.fillText(best ? '★ WAIT HERE' : `TRAIN INFO${this.suffix}`, 16, h / 2 + 1);
    // Ten-segment load meter.
    const segs = 10;
    const x0 = 230;
    const sw = 32;
    for (let i = 0; i < segs; i++) {
      ctx.fillStyle = i < Math.round(load * segs) ? color : '#23262c';
      ctx.fillRect(x0 + i * (sw + 6), 16, sw, h - 32);
    }
    ctx.fillStyle = color;
    ctx.font = '700 25px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(`${freeSeats}/${seats} FREE · ${noiseDb} dB`, x0 + segs * (sw + 6) + 14, h / 2 + 1);
    this.tex.needsUpdate = true;
  }
}

// ---------- helpers ----------

const gltfCache = new Map<string, Promise<GLTF>>();
function loadGltf(url: string) {
  let p = gltfCache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url);
    gltfCache.set(url, p);
  }
  return p;
}

function findByNorm(root: THREE.Object3D, name: string, norm: (n: string) => string) {
  let found: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!found && norm(o.name) === name) found = o;
  });
  return found;
}

function brickTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#b9b2a6';
  ctx.fillRect(0, 0, 256, 128);
  const colors = ['#7d3b2b', '#8a4532', '#6f3426', '#934d38', '#7a4030'];
  for (let row = 0; row < 8; row++) {
    for (let col = -1; col < 5; col++) {
      ctx.fillStyle = colors[(row * 7 + col * 3 + 10) % colors.length];
      ctx.fillRect(col * 64 + (row % 2) * 32 + 2, row * 16 + 2, 60, 12);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function tactileTexture(L: number) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e8d9a8';
  ctx.fillRect(0, 0, 128, 32);
  ctx.fillStyle = '#cdbd88';
  for (let x = 4; x < 128; x += 10) for (let y = 4; y < 32; y += 10) ctx.fillRect(x, y, 5, 5);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(L / 1.2, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function box(w: number, h: number, d: number, color: string, x: number, y: number, z: number, metal = 0, rough = 0.8) {
  return meshAt(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough }), x, y, z);
}

function meshAt(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

function sleepers(length: number, y: number) {
  const n = Math.floor(length / 0.9);
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.25, 0.08, 2.4),
    new THREE.MeshStandardMaterial({ color: '#45484e', roughness: 0.9 }),
    n,
  );
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) mesh.setMatrixAt(i, m.makeTranslation(-length / 2 + i * 0.9, y, TRACK_Z));
  return mesh;
}

// A strip of tunnel lining between two angles, running the whole length of the platform.
function arcSurface(L: number, r: number, a0: number, a1: number, mat: THREE.Material) {
  const geo = new THREE.PlaneGeometry(L, 1, 1, 40);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const a = a0 + (pos.getY(i) + 0.5) * (a1 - a0);
    pos.setXYZ(i, pos.getX(i), r * Math.sin(a), TUNNEL_C - r * Math.cos(a));
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

function gridTexture(base: string, line: string, px: number, panels = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = line;
  ctx.fillRect(0, 0, 128, px / 4);
  ctx.fillRect(0, 0, px / 4, 128);
  if (!panels) {
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function shade(hex: string, amt: number) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amt);
  return `#${c.getHexString()}`;
}

export function loadColor(load: number) {
  const green = new THREE.Color('#22c55e');
  const amber = new THREE.Color('#f59e0b');
  const red = new THREE.Color('#ef4444');
  return load < 0.5 ? green.lerp(amber, load / 0.5) : amber.lerp(red, (load - 0.5) / 0.5);
}

function pill(text: string, fg: string, bg: string, worldH = 0.85) {
  const size = 56;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.font = font;
  const padX = size * 0.6;
  c.width = Math.ceil(ctx.measureText(text).width + padX * 2);
  c.height = Math.ceil(size * 1.6);
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(2, 2, c.width - 4, c.height - 4, c.height / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
  sprite.scale.set((c.width / c.height) * worldH, worldH, 1);
  return sprite;
}

function signBoard(text: string, bg: string, fg: string, h = 0.75) {
  const size = 64;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width + size * 1.2);
  c.height = Math.ceil(size * 1.7);
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size * 0.6, c.height / 2 + 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.3 });
  return new THREE.Mesh(new THREE.BoxGeometry((c.width / c.height) * h, h, 0.08), mat);
}

function floorDecal(text: string) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '700 72px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.75), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

const roundelCache = new Map<string, THREE.CanvasTexture>();

function roundelTexture(name: string, ringColor: string) {
  const key = `${name}|${ringColor}`;
  const cached = roundelCache.get(key);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 640;
  const ctx = c.getContext('2d')!;
  ctx.lineWidth = 90;
  ctx.strokeStyle = ringColor;
  ctx.beginPath();
  ctx.arc(512, 320, 230, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#0019a8';
  ctx.fillRect(40, 255, 944, 130);
  if (name) {
    ctx.fillStyle = '#ffffff';
    let size = 84;
    do ctx.font = `700 ${size--}px "Segoe UI", system-ui, sans-serif`;
    while (ctx.measureText(name).width > 880);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 512, 322);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  roundelCache.set(key, tex);
  return tex;
}

function roundel(name: string, ringColor: string) {
  const tex = roundelTexture(name, ringColor);
  return new THREE.Mesh(
    new THREE.PlaneGeometry(4.2, 2.6),
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.5 }),
  );
}

// Black panels perforated with white dots whose size drifts in waves, like the TCR platform walls.
function dotPanelTexture() {
  const W = 512;
  const H = 400;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#121418';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e9ebee';
  const step = 14;
  for (let y = step; y < H - 4; y += step) {
    for (let x = step; x < W - 4; x += step) {
      const v = Math.sin(x * 0.019 + y * 0.011) + Math.sin(y * 0.027 - x * 0.007) + Math.sin((x + y) * 0.04);
      const r = Math.max(0, v - 0.6) * 2.4;
      if (r < 0.6) continue;
      ctx.beginPath();
      ctx.arc(x, y, Math.min(r, 5.5), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Panel seam.
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, 4, H);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function panelTexture(base: string, seam: string, cols: number, rows: number) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = seam;
  for (let i = 0; i < cols; i++) ctx.fillRect((i * 256) / cols, 0, 3, 128);
  for (let j = 0; j < rows; j++) ctx.fillRect(0, (j * 128) / rows, 256, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Ribbed concrete fanning out from the corner, like the TCR platform ends.
function fanTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 300;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d9d9d6';
  ctx.fillRect(0, 0, 512, 300);
  ctx.strokeStyle = '#b4b4b0';
  ctx.lineWidth = 2;
  for (let r = 40; r < 700; r += 26) {
    ctx.beginPath();
    ctx.arc(512, 0, r, Math.PI / 2, Math.PI);
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  for (let a = 0; a <= 12; a++) {
    const ang = Math.PI / 2 + (a / 12) * (Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(512, 0);
    ctx.lineTo(512 + Math.cos(ang) * 800, Math.sin(ang) * 800);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Clusters of open-ended steel cylinders hanging from the ceiling, glowing at the bottom.
function cylinderLights(L: number, z: number) {
  const group = new THREE.Group();
  const rand = mulberry32(7);
  const spots: { x: number; z: number; r: number; len: number }[] = [];
  for (let cx = -L / 2 + 6; cx < L / 2 - 4; cx += 11) {
    const n = 5 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      spots.push({ x: cx + (rand() - 0.5) * 3.2, z: z + (rand() - 0.5) * 2.4, r: 0.24 + rand() * 0.14, len: 0.45 + rand() * 0.75 });
    }
  }
  const tubes = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: '#b9bec4', metalness: 0.95, roughness: 0.22, side: THREE.DoubleSide }),
    spots.length,
  );
  const lamps = new THREE.InstancedMesh(
    new THREE.CircleGeometry(0.92, 24),
    new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff3df', emissiveIntensity: 2.2 }),
    spots.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  spots.forEach((s, i) => {
    tubes.setMatrixAt(i, m.compose(new THREE.Vector3(s.x, TCR_CEIL - s.len / 2, s.z), new THREE.Quaternion(), new THREE.Vector3(s.r, s.len, s.r)));
    lamps.setMatrixAt(i, m.compose(new THREE.Vector3(s.x, TCR_CEIL - s.len + 0.06, s.z), q, new THREE.Vector3(s.r, s.r, 1)));
  });
  group.add(tubes, lamps);
  return group;
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function gauss(rand: () => number) {
  return (rand() + rand() + rand() - 1.5) / 0.5;
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

function disposeObject(o: THREE.Object3D) {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

function disposeGroup(g: THREE.Group) {
  for (const child of [...g.children]) {
    disposeObject(child);
    g.remove(child);
  }
}
