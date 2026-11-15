// BVH export. BVH is a standard motion capture format that Blender opens
// with File > Import > Motion Capture (.bvh).
import * as THREE from "/vendor/three/three.module.js";
import { L, mid, basisQuat, headQuat } from "./avatar.js";

const FPS = 30;
const ANKLE_HEIGHT = 0.07;
const X = new THREE.Vector3(1, 0, 0), NX = new THREE.Vector3(-1, 0, 0), DOWN = new THREE.Vector3(0, -1, 0);

/** The skeleton in its rest pose (a T-pose that faces +Z), sized to the performer. */
function skeleton(m) {
  const arm = (side, sign) => ({
    name: `${side}Arm`, offset: [sign * m.shoulderHalf, m.torso * 0.4, 0], children: [{
      name: `${side}ForeArm`, offset: [sign * m.upperArm, 0, 0], children: [{
        name: `${side}Hand`, offset: [sign * m.foreArm, 0, 0], end: [sign * m.hand, 0, 0],
      }],
    }],
  });
  const leg = (side, sign) => ({
    name: `${side}UpLeg`, offset: [sign * m.hipHalf, 0, 0], children: [{
      name: `${side}Leg`, offset: [0, -m.thigh, 0], children: [{
        name: `${side}Foot`, offset: [0, -m.shin, 0], end: [0, -ANKLE_HEIGHT, m.foot],
      }],
    }],
  });
  return {
    name: "Hips", offset: [0, 0, 0], children: [
      {
        name: "Spine", offset: [0, m.torso * 0.2, 0], children: [{
          name: "Chest", offset: [0, m.torso * 0.4, 0], children: [
            { name: "Neck", offset: [0, m.torso * 0.4, 0], children: [{ name: "Head", offset: [0, m.neck, 0], end: [0, 0.2, 0] }] },
            arm("Left", 1), arm("Right", -1),
          ],
        }],
      },
      leg("Left", 1), leg("Right", -1),
    ],
  };
}

/** World rotation of every joint for one frame of body points. */
function solve(P, footRest) {
  const hips = mid(P[L.hipL], P[L.hipR]);
  const shoulders = mid(P[L.shoulderL], P[L.shoulderR]);
  const up = shoulders.clone().sub(hips);
  const q = {};
  q.Hips = basisQuat(P[L.hipL].clone().sub(P[L.hipR]), up);
  q.Chest = basisQuat(P[L.shoulderL].clone().sub(P[L.shoulderR]), up);
  q.Spine = q.Hips.clone().slerp(q.Chest, 0.5);
  q.Neck = q.Chest.clone();
  q.Head = headQuat(P, q.Chest).clone();
  const limb = (name, parent, rest, from, to) => {
    const target = P[to].clone().sub(P[from]);
    if (target.lengthSq() < 1e-8) { q[name] = q[parent].clone(); return; }
    const carried = rest.clone().applyQuaternion(q[parent]);
    q[name] = new THREE.Quaternion().setFromUnitVectors(carried, target.normalize()).multiply(q[parent]);
  };
  limb("LeftArm", "Chest", X, L.shoulderL, L.elbowL);
  limb("LeftForeArm", "LeftArm", X, L.elbowL, L.wristL);
  limb("LeftHand", "LeftForeArm", X, L.wristL, L.indexL);
  limb("RightArm", "Chest", NX, L.shoulderR, L.elbowR);
  limb("RightForeArm", "RightArm", NX, L.elbowR, L.wristR);
  limb("RightHand", "RightForeArm", NX, L.wristR, L.indexR);
  limb("LeftUpLeg", "Hips", DOWN, L.hipL, L.kneeL);
  limb("LeftLeg", "LeftUpLeg", DOWN, L.kneeL, L.ankleL);
  limb("LeftFoot", "LeftLeg", footRest, L.ankleL, L.toeL);
  limb("RightUpLeg", "Hips", DOWN, L.hipR, L.kneeR);
  limb("RightLeg", "RightUpLeg", DOWN, L.kneeR, L.ankleR);
  limb("RightFoot", "RightLeg", footRest, L.ankleR, L.toeR);
  return { q, hipHeight: hips.y };
}

/**
 * Turn recorded frames into steady 30 fps body points in scene axes
 * (y up, feet on the floor). samples: [{ t (ms), points: [[x, y, z, v] x 33] }]
 */
export function prepare(samples) {
  if (samples.length < 2) return [];
  const toScene = (pts) => pts.map(([x, y, z]) => new THREE.Vector3(x, -y, -z));
  const keys = samples.map((s) => ({ t: s.t / 1000, P: toScene(s.points) }));
  const frames = [];
  let k = 0, smooth = null, ground = null;
  const end = keys.at(-1).t;
  for (let t = keys[0].t; t <= end + 1e-6; t += 1 / FPS) {
    while (k < keys.length - 2 && keys[k + 1].t < t) k++;
    const a = keys[k], b = keys[k + 1];
    const f = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t || 1), 0, 1);
    const P = a.P.map((v, i) => v.clone().lerp(b.P[i], f));
    if (!smooth) smooth = P; else smooth.forEach((v, i) => v.lerp(P[i], 0.5));   // light smoothing
    const lowest = Math.min(...[27, 28, 29, 30, 31, 32].map((i) => smooth[i].y));
    ground = ground === null ? lowest : ground + (lowest - ground) * 0.2;
    frames.push(smooth.map((v) => new THREE.Vector3(v.x, v.y - ground, v.z)));
  }
  return frames;
}

/** Build the text of a .bvh file from recorded samples. Returns null when too short. */
export function buildBVH(samples) {
  const frames = prepare(samples);
  if (frames.length < 2) return null;

  // Bone lengths: the average over the recording.
  const avg = (fn) => frames.reduce((sum, P) => sum + fn(P), 0) / frames.length;
  const dist = (a, b) => (P) => P[a].distanceTo(P[b]);
  const both = (a1, b1, a2, b2) => (P) => (P[a1].distanceTo(P[b1]) + P[a2].distanceTo(P[b2])) / 2;
  const m = {
    torso: avg((P) => mid(P[L.shoulderL], P[L.shoulderR]).distanceTo(mid(P[L.hipL], P[L.hipR]))),
    shoulderHalf: avg(dist(L.shoulderL, L.shoulderR)) / 2,
    hipHalf: avg(dist(L.hipL, L.hipR)) / 2,
    upperArm: avg(both(L.shoulderL, L.elbowL, L.shoulderR, L.elbowR)),
    foreArm: avg(both(L.elbowL, L.wristL, L.elbowR, L.wristR)),
    hand: avg(both(L.wristL, L.indexL, L.wristR, L.indexR)),
    thigh: avg(both(L.hipL, L.kneeL, L.hipR, L.kneeR)),
    shin: avg(both(L.kneeL, L.ankleL, L.kneeR, L.ankleR)),
    foot: Math.max(0.1, avg(both(L.ankleL, L.toeL, L.ankleR, L.toeR)) * 0.9),
    neck: avg((P) => mid(P[L.earL], P[L.earR]).distanceTo(mid(P[L.shoulderL], P[L.shoulderR]))),
  };
  const root = skeleton(m);
  const footRest = new THREE.Vector3(0, -ANKLE_HEIGHT, m.foot).normalize();

  // Hierarchy text, and the joint order for the motion rows.
  const order = [];
  const n = (v) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6);
  const lines = ["HIERARCHY"];
  const write = (joint, parent, depth) => {
    const pad = "  ".repeat(depth);
    order.push({ name: joint.name, parent });
    lines.push(`${pad}${parent ? "JOINT" : "ROOT"} ${joint.name}`, `${pad}{`, `${pad}  OFFSET ${joint.offset.map(n).join(" ")}`);
    lines.push(parent
      ? `${pad}  CHANNELS 3 Zrotation Xrotation Yrotation`
      : `${pad}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
    for (const child of joint.children || []) write(child, joint.name, depth + 1);
    if (joint.end) lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET ${joint.end.map(n).join(" ")}`, `${pad}  }`);
    lines.push(`${pad}}`);
  };
  write(root, null, 0);

  lines.push("MOTION", `Frames: ${frames.length}`, `Frame Time: ${(1 / FPS).toFixed(6)}`);
  const euler = new THREE.Euler();
  const deg = THREE.MathUtils.radToDeg;
  for (const P of frames) {
    const { q, hipHeight } = solve(P, footRest);
    const row = [n(0), n(hipHeight), n(0)];
    for (const { name, parent } of order) {
      const local = parent ? q[parent].clone().invert().multiply(q[name]) : q[name];
      euler.setFromQuaternion(local, "ZXY");
      row.push(n(deg(euler.z)), n(deg(euler.x)), n(deg(euler.y)));
    }
    lines.push(row.join(" "));
  }
  return lines.join("\n") + "\n";
}
