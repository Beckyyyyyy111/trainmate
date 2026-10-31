// Scanned people (Renderpeople free rigged models) posed once at load time and baked into
// static meshes, so a crowd can be drawn with instancing. The files are local-only (see
// .gitignore): the licence forbids making them downloadable. If they are missing the app
// falls back to the procedural figures.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

export type Pose = 'stand' | 'sit';

export interface PersonTemplate {
  name: string;
  pose: Pose;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

const PEOPLE = ['eric', 'carla', 'claudia'];

let loading: Promise<PersonTemplate[]> | undefined;

export function loadPeople() {
  loading ??= Promise.all(PEOPLE.map(loadPerson)).then((all) => all.flat());
  return loading;
}

async function loadPerson(name: string): Promise<PersonTemplate[]> {
  const base = `/models/people/${name}/${name}`;
  const [obj, map] = await Promise.all([new FBXLoader().loadAsync(`${base}.fbx`), new THREE.TextureLoader().loadAsync(`${base}_dif.jpg`)]);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.85 });
  let mesh: THREE.SkinnedMesh | undefined;
  obj.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
  });
  if (!mesh) throw new Error(`No skinned mesh in ${name}`);
  const skinned = mesh;
  const bone = (n: string) => skinned.skeleton.bones.find((b) => b.name === n);
  const rest = skinned.skeleton.bones.map((b) => b.quaternion.clone());
  const reset = () => {
    skinned.skeleton.bones.forEach((b, i) => b.quaternion.copy(rest[i]));
    obj.updateMatrixWorld(true);
  };

  const out: PersonTemplate[] = [];
  for (const pose of ['stand', 'sit'] as Pose[]) {
    reset();
    // Facing direction: up x (left shoulder -> right shoulder), in the model's world space.
    const across = worldPos(bone('upperarm_r')).sub(worldPos(bone('upperarm_l'))).setY(0).normalize();
    const fwd = new THREE.Vector3(0, 1, 0).cross(across).normalize();
    const down = new THREE.Vector3(0, -1, 0);
    const side = (b?: THREE.Bone) => Math.sign(worldPos(b).x - worldPos(bone('hip')).x) || 1;
    for (const s of ['l', 'r']) {
      const upper = bone(`upperarm_${s}`);
      const sx = side(upper);
      // Arms down by the sides, slightly away from the body.
      aim(obj, upper, bone(`lowerarm_${s}`), new THREE.Vector3(sx * 0.18, -1, 0.04).normalize());
      if (pose === 'sit') {
        // Forearms forward onto the lap.
        aim(obj, bone(`lowerarm_${s}`), bone(`hand_${s}`), fwd.clone().multiplyScalar(1).add(new THREE.Vector3(0, -0.35, 0)).normalize());
        // Thighs forward, shins down.
        aim(obj, bone(`upperleg_${s}`), bone(`lowerleg_${s}`), fwd.clone().add(new THREE.Vector3(0, -0.05, 0)).normalize());
        aim(obj, bone(`lowerleg_${s}`), bone(`foot_${s}`), down.clone().add(fwd.clone().multiplyScalar(0.12)).normalize());
      } else {
        aim(obj, bone(`lowerarm_${s}`), bone(`hand_${s}`), new THREE.Vector3(sx * 0.1, -1, 0.12).normalize());
      }
    }
    obj.updateMatrixWorld(true);
    const geometry = bake(skinned);
    // Centimetres to metres, turn to face +z, and place the origin under the hips
    // (standing: feet on y = 0; sitting: hip joint at seat height).
    geometry.scale(0.01, 0.01, 0.01);
    const turn = new THREE.Matrix4().makeRotationY(-Math.atan2(fwd.x, fwd.z));
    geometry.applyMatrix4(turn);
    const hip = worldPos(bone('hip')).multiplyScalar(0.01).applyMatrix4(turn);
    geometry.computeBoundingBox();
    const minY = geometry.boundingBox!.min.y;
    geometry.translate(-hip.x, pose === 'stand' ? -minY : 0.5 - hip.y, -hip.z);
    geometry.computeBoundingSphere();
    out.push({ name, pose, geometry, material });
  }
  return out;
}

function worldPos(b?: THREE.Object3D) {
  return b ? b.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
}

// Rotate `bone` (in world space) so the direction towards `child` points along `dir`.
function aim(root: THREE.Object3D, bone: THREE.Bone | undefined, child: THREE.Bone | undefined, dir: THREE.Vector3) {
  if (!bone || !child || !bone.parent) return;
  root.updateMatrixWorld(true);
  const from = worldPos(child).sub(worldPos(bone)).normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(from, dir);
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
  const target = delta.multiply(boneQ);
  bone.quaternion.copy(parentQ.invert().multiply(target));
  root.updateMatrixWorld(true);
}

// Apply the current skeleton pose to positions and normals, giving a plain static geometry.
function bake(mesh: THREE.SkinnedMesh) {
  mesh.skeleton.update();
  const src = mesh.geometry;
  const pos = src.attributes.position;
  const nrm = src.attributes.normal;
  const outPos = new Float32Array(pos.count * 3);
  const outNrm = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const skinIndex = src.attributes.skinIndex;
  const skinWeight = src.attributes.skinWeight;
  const boneMatrices = mesh.skeleton.boneMatrices;
  const m = new THREE.Matrix4();
  const acc = new THREE.Matrix4();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    mesh.applyBoneTransform(i, v);
    v.applyMatrix4(mesh.matrixWorld);
    outPos.set([v.x, v.y, v.z], i * 3);
    if (nrm) {
      // Blend the bone rotations for the normal.
      acc.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (!w) continue;
        m.fromArray(boneMatrices!, skinIndex.getComponent(i, k) * 16);
        for (let e = 0; e < 16; e++) acc.elements[e] += m.elements[e] * w;
      }
      n.fromBufferAttribute(nrm, i).transformDirection(acc).transformDirection(mesh.matrixWorld);
      outNrm.set([n.x, n.y, n.z], i * 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (nrm) g.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  else g.computeVertexNormals();
  if (src.attributes.uv) g.setAttribute('uv', src.attributes.uv);
  if (src.index) g.setIndex(src.index);
  return g;
}
