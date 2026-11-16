// Hologram look for motion capture: a glowing wireframe body on a dark blue
// stage, with particles that trail behind the moving limbs.
import * as THREE from "../vendor/three/three.module.js";
import { EffectComposer } from "../vendor/three/postprocessing/EffectComposer.js";
import { RenderPass } from "../vendor/three/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "../vendor/three/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "../vendor/three/postprocessing/OutputPass.js";

const MAX_PARTICLES = 14000;
const PALETTE = [new THREE.Color(0xffffff), new THREE.Color(0x9fe8ff), new THREE.Color(0x4f8dff), new THREE.Color(0x3a3dff)];
const WIND = new THREE.Vector3(0.22, 0.03, -0.12);     // slow drift, so the trail streams away

function softDot() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Hologram {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = false;

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.38, 0.35, 0.3);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // The body: bright wire lines over a faint blue shell.
    this.wire = new THREE.MeshBasicMaterial({
      color: 0xb4c8ff, wireframe: true, transparent: true, opacity: 0.055,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    this.background = new THREE.Color(0x02030f);
    this.grid = new THREE.GridHelper(8, 8, 0x26358f, 0x121a4d);
    this.grid.visible = false;
    scene.add(this.grid);

    // Particles.
    this.pos = new Float32Array(MAX_PARTICLES * 3);
    this.col = new Float32Array(MAX_PARTICLES * 3);
    this.vel = new Float32Array(MAX_PARTICLES * 3);
    this.base = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.span = new Float32Array(MAX_PARTICLES);
    this.next = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.036, map: softDot(), vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
    this.previous = new Map();     // person -> last body points, to measure speed
  }

  resize(w, h) {
    this.composer.setSize(w, h);
  }

  /** Switch a character between its normal materials and the hologram wireframe. */
  styleSkin(group, on) {
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.baseMaterial ??= o.material;
      o.material = on ? this.wire : o.userData.baseMaterial;
    });
  }

  setEnabled(on) {
    this.enabled = on;
    this.grid.visible = on;
    this.points.visible = on;
    if (!on) { this.life.fill(0); this.col.fill(0); this.points.geometry.attributes.color.needsUpdate = true; this.previous.clear(); }
  }

  spawn(p, drift) {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    const k = i * 3;
    this.pos[k] = p.x + (Math.random() - 0.5) * 0.05;
    this.pos[k + 1] = p.y + (Math.random() - 0.5) * 0.05;
    this.pos[k + 2] = p.z + (Math.random() - 0.5) * 0.05;
    const spread = 0.05;
    this.vel[k] = WIND.x * (0.4 + Math.random()) + drift.x + (Math.random() - 0.5) * spread;
    this.vel[k + 1] = WIND.y + drift.y + (Math.random() - 0.5) * spread;
    this.vel[k + 2] = WIND.z * (0.4 + Math.random()) + drift.z + (Math.random() - 0.5) * spread;
    const c = PALETTE[Math.floor(Math.random() ** 1.6 * PALETTE.length)];
    const bright = 0.35 + Math.random() * 0.65;
    this.base[k] = c.r * bright;
    this.base[k + 1] = c.g * bright;
    this.base[k + 2] = c.b * bright;
    this.span[i] = this.life[i] = 1.2 + Math.random() * 2.2;
  }

  /**
   * Release particles from one person. points: body points in scene space.
   * links: pairs of point indexes (the limbs). Fast limbs release more.
   */
  emit(key, points, links, dt) {
    const prev = this.previous.get(key);
    const a = new THREE.Vector3(), drift = new THREE.Vector3();
    if (prev) {
      for (const [i, j] of links) {
        const speed = (points[i].distanceTo(prev[i]) + points[j].distanceTo(prev[j])) / 2 / Math.max(dt, 1e-3);
        const count = Math.min(40, Math.floor((7 + speed * 260) * dt + Math.random()));
        for (let n = 0; n < count; n++) {
          a.copy(points[i]).lerp(points[j], Math.random());
          // A little of the limb's own movement, reversed: the dots fall behind it.
          drift.copy(points[i]).sub(prev[i]).multiplyScalar(-0.12 / Math.max(dt, 1e-3) * Math.random());
          this.spawn(a, drift);
        }
      }
    }
    this.previous.set(key, points.map((p) => p.clone()));
  }

  forget(key) { this.previous.delete(key); }

  update(dt) {
    const { pos, vel, col, base, life, span } = this;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const k = i * 3;
      if (life[i] <= 0) { col[k] = col[k + 1] = col[k + 2] = 0; continue; }
      pos[k] += vel[k] * dt;
      pos[k + 1] += vel[k + 1] * dt;
      pos[k + 2] += vel[k + 2] * dt;
      const f = life[i] / span[i];
      const fade = Math.min(1, f * 1.6) * Math.min(1, (1 - f) * 12);     // quick in, slow out
      col[k] = base[k] * fade;
      col[k + 1] = base[k + 1] * fade;
      col[k + 2] = base[k + 2] * fade;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  render() {
    this.composer.render();
  }
}
