// Character skins for motion capture. Each skin has update(points), where
// points is a list of 33 body positions (THREE.Vector3, metres, feet at y = 0).
import * as THREE from "/vendor/three/three.module.js";
import { GLTFLoader } from "/vendor/three/GLTFLoader.js";

const CORAL = 0xff5a52;
const L = {
  nose: 0, earL: 7, earR: 8, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16, indexL: 19, indexR: 20, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32,
};
const UP = new THREE.Vector3(0, 1, 0);
const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);

/** Place a unit-height cylinder so that it runs from a to b. */
function span(mesh, a, b) {
  const dir = b.clone().sub(a);
  const len = dir.length() || 1e-4;
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
  mesh.scale.y = len;
}

/** Rotation whose X axis follows `right` and whose Y axis is close to `up`. */
function basisQuat(right, up, out = new THREE.Quaternion()) {
  const x = right.clone().normalize();
  const z = x.clone().cross(up).normalize();
  const y = z.clone().cross(x);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

function headPoints(P) {
  const ears = mid(P[L.earL], P[L.earR]);
  const shoulders = mid(P[L.shoulderL], P[L.shoulderR]);
  return { ears, shoulders, neckTop: shoulders.clone().lerp(ears, 0.55) };
}

// ---------------------------------------------------------------- skeleton
export class SkeletonSkin {
  constructor() {
    this.group = new THREE.Group();
    const boneMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
    const jointMat = new THREE.MeshBasicMaterial({ color: CORAL });
    this.pairs = [
      [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20],
      [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
      [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
    ];
    const boneGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 8);
    this.bones = this.pairs.map(() => new THREE.Mesh(boneGeo, boneMat));
    this.neck = new THREE.Mesh(boneGeo, boneMat);
    this.jointIds = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
    const jointGeo = new THREE.SphereGeometry(0.03, 16, 12);
    this.joints = this.jointIds.map(() => new THREE.Mesh(jointGeo, jointMat));
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.095, 24, 16), new THREE.MeshBasicMaterial({ color: 0xf2f2f2, wireframe: true }));
    this.group.add(...this.bones, ...this.joints, this.neck, this.head);
  }
  update(P) {
    this.pairs.forEach(([a, b], i) => span(this.bones[i], P[a], P[b]));
    this.jointIds.forEach((id, i) => this.joints[i].position.copy(P[id]));
    const { ears, shoulders } = headPoints(P);
    span(this.neck, shoulders, ears);
    this.head.position.copy(ears);
  }
  dispose() {}
}

// ---------------------------------------------------------------- body
export class BodySkin {
  constructor() {
    this.group = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.55, metalness: 0.02 });
    const joint = new THREE.MeshStandardMaterial({ color: CORAL, roughness: 0.4 });
    const limb = (a, b, r1, r2) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, 1, 20), skin);
      this.group.add(mesh);
      return { a, b, mesh };
    };
    const ball = (id, r, mat = joint) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
      this.group.add(mesh);
      return { id, mesh };
    };
    this.limbs = [
      limb(11, 13, 0.052, 0.042), limb(13, 15, 0.04, 0.03), limb(15, 19, 0.03, 0.036),
      limb(12, 14, 0.052, 0.042), limb(14, 16, 0.04, 0.03), limb(16, 20, 0.03, 0.036),
      limb(23, 25, 0.08, 0.056), limb(25, 27, 0.052, 0.036), limb(29, 31, 0.04, 0.032),
      limb(24, 26, 0.08, 0.056), limb(26, 28, 0.052, 0.036), limb(30, 32, 0.04, 0.032),
    ];
    this.balls = [
      ball(11, 0.058), ball(12, 0.058), ball(13, 0.044), ball(14, 0.044), ball(15, 0.032), ball(16, 0.032),
      ball(23, 0.082), ball(24, 0.082), ball(25, 0.057), ball(26, 0.057), ball(27, 0.038), ball(28, 0.038),
      ball(19, 0.04, skin), ball(20, 0.04, skin), ball(31, 0.033, skin), ball(32, 0.033, skin), ball(29, 0.04, skin), ball(30, 0.04, skin),
    ];
    // Torso: a tapered tube, wide at the shoulders. Scaled to the person each frame.
    this.torso = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.8, 1, 28), skin);
    this.pelvis = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), skin);
    this.neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.046, 1, 16), skin);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), skin);
    this.head.scale.set(0.092, 0.118, 0.104);
    this.group.add(this.torso, this.pelvis, this.neck, this.head);
  }
  update(P) {
    for (const { a, b, mesh } of this.limbs) span(mesh, P[a], P[b]);
    for (const { id, mesh } of this.balls) mesh.position.copy(P[id]);
    const hips = mid(P[L.hipL], P[L.hipR]);
    const { ears, shoulders, neckTop } = headPoints(P);
    const up = shoulders.clone().sub(hips);
    const chestQ = basisQuat(P[L.shoulderL].clone().sub(P[L.shoulderR]), up);
    const shoulderHalf = P[L.shoulderL].distanceTo(P[L.shoulderR]) / 2;
    this.torso.position.copy(mid(hips, shoulders));
    this.torso.quaternion.copy(chestQ);
    this.torso.scale.set(shoulderHalf * 1.02, up.length() * 1.02, shoulderHalf * 0.6);
    this.pelvis.position.copy(hips);
    this.pelvis.quaternion.copy(basisQuat(P[L.hipL].clone().sub(P[L.hipR]), up));
    this.pelvis.scale.set(shoulderHalf * 0.86, shoulderHalf * 0.6, shoulderHalf * 0.56);
    span(this.neck, shoulders, neckTop);
    this.head.position.copy(ears);
    this.head.quaternion.copy(headQuat(P, chestQ));
  }
  dispose() {}
}

/** Head rotation from ears and nose. Falls back to the chest when unclear. */
function headQuat(P, fallback) {
  const right = P[L.earL].clone().sub(P[L.earR]);
  const forward = P[L.nose].clone().sub(mid(P[L.earL], P[L.earR]));
  if (right.length() < 0.03 || forward.length() < 0.02) return fallback;
  const up = forward.clone().cross(right).normalize();
  // The nose is lower than the ears, so tilt the result back a little.
  const q = basisQuat(right, up);
  return q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.3));
}

// ---------------------------------------------------------------- rigged mesh
const BONE_ALIASES = {
  hips: ["hips", "pelvis", "hip"],
  chest: ["spine2", "upperchest", "chest", "spine1", "spine"],
  neck: ["neck"],
  head: ["head"],
  armL: ["leftarm", "leftupperarm", "upperarml", "lupperarm"],
  foreArmL: ["leftforearm", "leftlowerarm", "lowerarml", "forearml", "lforearm"],
  handL: ["lefthand", "handl", "lhand"],
  armR: ["rightarm", "rightupperarm", "upperarmr", "rupperarm"],
  foreArmR: ["rightforearm", "rightlowerarm", "lowerarmr", "forearmr", "rforearm"],
  handR: ["righthand", "handr", "rhand"],
  upLegL: ["leftupleg", "leftupperleg", "leftthigh", "thighl", "lthigh"],
  legL: ["leftleg", "leftlowerleg", "leftshin", "calfl", "shinl", "lcalf"],
  footL: ["leftfoot", "footl", "lfoot"],
  toeL: ["lefttoebase", "lefttoes", "toel", "balll"],
  upLegR: ["rightupleg", "rightupperleg", "rightthigh", "thighr", "rthigh"],
  legR: ["rightleg", "rightlowerleg", "rightshin", "calfr", "shinr", "rcalf"],
  footR: ["rightfoot", "footr", "rfoot"],
  toeR: ["righttoebase", "righttoes", "toer", "ballr"],
};
const REQUIRED = ["hips", "armL", "foreArmL", "armR", "foreArmR", "upLegL", "legL", "upLegR", "legR"];
// bone, bone that gives its rest direction, parent in the chain, landmark from, landmark to
const LIMBS = [
  ["armL", "foreArmL", "chest", L.shoulderL, L.elbowL], ["foreArmL", "handL", "armL", L.elbowL, L.wristL], ["handL", null, "foreArmL", L.wristL, L.indexL],
  ["armR", "foreArmR", "chest", L.shoulderR, L.elbowR], ["foreArmR", "handR", "armR", L.elbowR, L.wristR], ["handR", null, "foreArmR", L.wristR, L.indexR],
  ["upLegL", "legL", "hips", L.hipL, L.kneeL], ["legL", "footL", "upLegL", L.kneeL, L.ankleL], ["footL", "toeL", "legL", L.ankleL, L.toeL],
  ["upLegR", "legR", "hips", L.hipR, L.kneeR], ["legR", "footR", "upLegR", L.kneeR, L.ankleR], ["footR", "toeR", "legR", L.ankleR, L.toeR],
];

export class RigSkin {
  /** Load a .glb character from a URL. Throws when the rig cannot be read. */
  static async load(url, { tintJoints = false } = {}) {
    const gltf = await new GLTFLoader().loadAsync(url);
    return new RigSkin(gltf.scene, tintJoints);
  }

  constructor(model, tintJoints) {
    this.group = new THREE.Group();
    this.group.add(model);
    model.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        if (tintJoints) {
          // House colours for the built-in character: white body, coral joints.
          o.material = o.material.clone();
          o.material.color.set(/joint/i.test(o.material.name || "") ? CORAL : 0xf2f2f2);
          o.material.roughness = 0.55;
          o.material.metalness = 0;
        }
      }
    });

    // Scale the character to 1.7 m and stand it on the floor. The size comes
    // from the bones, because the mesh size is not reliable before skinning.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    model.traverse((o) => { if (o.isBone) box.expandByPoint(o.getWorldPosition(new THREE.Vector3())); });
    if (box.isEmpty()) throw new Error("no-rig");
    const scale = 1.7 / (box.max.y - box.min.y || 1);
    const centre = box.getCenter(new THREE.Vector3());
    model.scale.multiplyScalar(scale);
    model.position.multiplyScalar(scale);
    model.position.x -= centre.x * scale;
    model.position.z -= centre.z * scale;
    model.position.y -= box.min.y * scale;
    this.group.updateMatrixWorld(true);

    // Find the bones by name.
    const byName = new Map();
    model.traverse((o) => {
      if (o.isBone) {
        const key = o.name.toLowerCase().replace(/mixamorig\d*|[^a-z0-9]/g, "");
        if (!byName.has(key)) byName.set(key, o);
      }
    });
    this.b = {};
    for (const [slot, names] of Object.entries(BONE_ALIASES)) {
      const hit = names.find((n) => byName.has(n));
      if (hit) this.b[slot] = byName.get(hit);
    }
    const missing = REQUIRED.filter((slot) => !this.b[slot]);
    if (missing.length) throw new Error("no-rig");

    // Remember the rest pose (the T-pose the model was saved in).
    const pos = (bone) => bone.getWorldPosition(new THREE.Vector3());
    this.restQ = {};
    for (const [slot, bone] of Object.entries(this.b)) this.restQ[slot] = bone.getWorldQuaternion(new THREE.Quaternion());
    this.restDir = {};
    for (const [slot, childSlot] of LIMBS) {
      const bone = this.b[slot];
      const child = childSlot ? this.b[childSlot] : bone?.children.find((c) => c.isBone);
      if (bone && child) this.restDir[slot] = pos(child).sub(pos(bone)).normalize();
    }
    const b = this.b;
    const shoulderMid = mid(pos(b.armL), pos(b.armR));
    const hipMid = mid(pos(b.upLegL), pos(b.upLegR));
    const up = shoulderMid.clone().sub(hipMid);
    this.restHipsBasisInv = basisQuat(pos(b.upLegL).sub(pos(b.upLegR)), up).invert();
    this.restChestBasisInv = basisQuat(pos(b.armL).sub(pos(b.armR)), up).invert();
    this.restHipsPos = pos(b.hips);
    this.legLength = pos(b.upLegL).distanceTo(pos(b.legL)) + (b.footL ? pos(b.legL).distanceTo(pos(b.footL)) : 0);
    this.worldQ = {};
  }

  setWorld(slot, q) {
    const bone = this.b[slot];
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(parentQ.invert().multiply(q));
    this.worldQ[slot] = q;
  }

  update(P) {
    const b = this.b;
    const hips = mid(P[L.hipL], P[L.hipR]);
    const shoulders = mid(P[L.shoulderL], P[L.shoulderR]);
    const up = shoulders.clone().sub(hips);

    // Hips height: crouch and stand follow the performer.
    const legM = (P[L.hipL].distanceTo(P[L.kneeL]) + P[L.kneeL].distanceTo(P[L.ankleL])
                + P[L.hipR].distanceTo(P[L.kneeR]) + P[L.kneeR].distanceTo(P[L.ankleR])) / 2;
    if (legM > 0.2) {
      const offset = THREE.MathUtils.clamp((hips.y - legM - 0.07) * (this.legLength / legM), -1.2, 0.5);
      const target = this.restHipsPos.clone();
      target.y += offset;
      b.hips.position.copy(b.hips.parent.worldToLocal(target));
    }

    // Body rotation: hips first, then chest, then head.
    const hipsDelta = basisQuat(P[L.hipL].clone().sub(P[L.hipR]), up).multiply(this.restHipsBasisInv);
    this.setWorld("hips", hipsDelta.clone().multiply(this.restQ.hips));
    const chestBasis = basisQuat(P[L.shoulderL].clone().sub(P[L.shoulderR]), up);
    const chestDelta = chestBasis.clone().multiply(this.restChestBasisInv);
    if (b.chest) this.setWorld("chest", chestDelta.clone().multiply(this.restQ.chest));
    if (b.head) {
      const headDelta = headQuat(P, chestBasis).clone().multiply(this.restChestBasisInv);
      this.setWorld("head", headDelta.multiply(this.restQ.head));
    }

    // Arms and legs: turn each bone to point along the captured limb.
    for (const [slot, , parentSlot, from, to] of LIMBS) {
      if (!b[slot] || !this.restDir[slot]) continue;
      const target = P[to].clone().sub(P[from]);
      if (target.lengthSq() < 1e-6) continue;
      target.normalize();
      const parent = this.worldQ[parentSlot] ? parentSlot : "hips";
      const parentDelta = this.worldQ[parent].clone().multiply(this.restQ[parent].clone().invert());
      const carried = this.restDir[slot].clone().applyQuaternion(parentDelta);
      const swing = new THREE.Quaternion().setFromUnitVectors(carried, target);
      this.setWorld(slot, swing.multiply(parentDelta).multiply(this.restQ[slot]));
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
  }
}
