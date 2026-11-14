import * as THREE from 'three';
import { FRUITS, GOLDEN, createFruit, createHalf, createMine } from './fruits.js';

const GRAVITY = -15;
const CAM_Z = 22;
const FOV = 40;
const SLICE_SPEED = 650; // px/s a blade must move to cut
const TRAIL_LIFE = 0.14; // seconds of blade trail drawn
const COMBO_GAP = 0.28; // seconds between cuts that still count as one combo
const MAX_PARTICLES = 420;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function pickFruit() {
  if (Math.random() < 0.035) return GOLDEN;
  const total = FRUITS.reduce((s, f) => s + f.weight, 0);
  let r = Math.random() * total;
  for (const f of FRUITS) if ((r -= f.weight) <= 0) return f;
  return FRUITS[0];
}

function segPointDist(ax, ay, bx, by, px, py) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  const cx = ax + dx * t - px, cy = ay + dy * t - py;
  return Math.sqrt(cx * cx + cy * cy);
}

export class FruitGame {
  constructor(container, { onHud, onEvent, onGameOver } = {}) {
    this.container = container;
    this.onHud = onHud || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onGameOver = onGameOver || (() => {});

    this.mode = 'menu'; // menu | playing | over
    this.paused = false;
    this.items = []; // whole fruit + mines in the air
    this.halves = [];
    this.splats = [];
    this.time = 0;
    this.shake = 0;

    this.blades = {
      local: { pts: [], down: false, combo: 0, comboT: 0, comboX: 0, comboY: 0, color: '#bff4ff' },
      remote: { pts: [], down: true, combo: 0, comboT: 0, comboX: 0, comboY: 0, color: '#ffd27a', cursor: null, seen: 0 },
    };

    this._layers();
    this._scene();
    this._bind();
    this.resize();
    this.reset();

    this._last = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  }

  // ---------------------------------------------------------------------
  _layers() {
    const mk = (tag, cls) => {
      const el = document.createElement(tag);
      el.className = cls;
      this.container.appendChild(el);
      return el;
    };
    this.stainCanvas = mk('canvas', 'layer stains');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'layer gl';
    this.container.appendChild(this.renderer.domElement);
    this.bladeCanvas = mk('canvas', 'layer blade');
    this.popLayer = mk('div', 'layer pops');
    this.stainCtx = this.stainCanvas.getContext('2d');
    this.bladeCtx = this.bladeCanvas.getContext('2d');
  }

  _scene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.camera.position.set(0, 0, CAM_Z);
    this.scene.add(new THREE.HemisphereLight('#fff6e8', '#3a2a5a', 1.4));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(-4, 8, 10);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#8fd3ff', 1.0);
    rim.position.set(6, -3, -4);
    this.scene.add(rim);

    // juice droplets
    this.parts = Array.from({ length: MAX_PARTICLES }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, s: 1 }));
    this.partMesh = new THREE.InstancedMesh(
      new THREE.TetrahedronGeometry(0.11),
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      MAX_PARTICLES
    );
    this.partMesh.frustumCulled = false;
    const c = new THREE.Color('#ffffff');
    for (let i = 0; i < MAX_PARTICLES; i++) this.partMesh.setColorAt(i, c);
    this.scene.add(this.partMesh);
    this.partRing = 0;
    this._dummy = new THREE.Object3D();
  }

  _bind() {
    const el = this.bladeCanvas;
    const local = this.blades.local;
    const pt = (e) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    this._onDown = (e) => {
      local.down = true;
      local.pts = [];
      const [x, y] = pt(e);
      this._bladePoint(local, x, y);
      el.setPointerCapture?.(e.pointerId);
    };
    this._onMove = (e) => {
      if (!local.down) return;
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of list.length ? list : [e]) {
        const [x, y] = pt(ev);
        this._bladePoint(local, x, y);
      }
    };
    this._onUp = () => { local.down = false; };
    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onUp);
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._onKey = (e) => {
      if ((e.code === 'KeyP' || e.code === 'Escape') && this.mode === 'playing') this.togglePause();
    };
    window.addEventListener('keydown', this._onKey);
    this._onVis = () => { if (document.hidden && this.mode === 'playing' && !this.paused) this.togglePause(); };
    document.addEventListener('visibilitychange', this._onVis);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = w; this.h = h;
    this.renderer.setSize(w, h);
    for (const cv of [this.stainCanvas, this.bladeCanvas]) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px';
      cv.style.height = h + 'px';
      cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.halfH = Math.tan((FOV / 2) * (Math.PI / 180)) * CAM_Z;
    this.halfW = this.halfH * this.camera.aspect;
    this.ppu = h / (this.halfH * 2); // pixels per world unit on the z=0 plane
  }

  toScreen(x, y) {
    return [(x / this.halfW * 0.5 + 0.5) * this.w, (0.5 - y / this.halfH * 0.5) * this.h];
  }

  // ---- lifecycle ----------------------------------------------------------
  reset() {
    for (const it of this.items) this.scene.remove(it.mesh);
    for (const h of this.halves) this.scene.remove(h.mesh);
    this.items = [];
    this.halves = [];
    this.splats = [];
    this.pending = [];
    this.score = 0;
    this.lives = 3;
    this.elapsed = 0;
    this.nextWave = 0.8;
    this.overTimer = 0;
    for (const p of this.parts) p.life = 0;
    for (const b of Object.values(this.blades)) { b.pts = []; b.combo = 0; }
  }

  start() {
    this.reset();
    this.mode = 'playing';
    this.paused = false;
    this._emitHud();
  }

  toMenu() {
    this.reset();
    this.mode = 'menu';
    this.paused = false;
    this._emitHud();
  }

  togglePause() {
    if (this.mode !== 'playing') return;
    this.paused = !this.paused;
    this._emitHud();
  }

  // ---- remote (phone) blade -------------------------------------------------
  /** x, y in roughly -1..1 (screen edges), from the phone's pointing direction. */
  setRemotePointer(x, y) {
    const b = this.blades.remote;
    const sx = (clamp(x, -1.3, 1.3) * 0.5 + 0.5) * this.w;
    const sy = (0.5 - clamp(y, -1.3, 1.3) * 0.5) * this.h;
    const prev = b.cursor;
    const nx = prev ? lerp(prev[0], sx, 0.65) : sx;
    const ny = prev ? lerp(prev[1], sy, 0.65) : sy;
    b.cursor = [nx, ny];
    b.seen = performance.now();
    this._bladePoint(b, nx, ny);
  }

  // ---- blades & cutting ----------------------------------------------------
  _bladePoint(b, x, y) {
    const t = performance.now() / 1000;
    const last = b.pts[b.pts.length - 1];
    b.pts.push({ x, y, t });
    if (!last || this.paused) return;
    const dt = Math.max(t - last.t, 1 / 240);
    const dx = x - last.x, dy = y - last.y;
    const len = Math.hypot(dx, dy);
    if (len / dt < SLICE_SPEED || len < 2) return;
    this._cutAlong(b, last.x, last.y, x, y, dx / len, dy / len, t);
  }

  _cutAlong(b, ax, ay, bx, by, dirX, dirY, t) {
    for (const it of this.items) {
      if (it.dead) continue;
      const [sx, sy] = this.toScreen(it.pos.x, it.pos.y);
      const rPx = it.r * this.ppu * 1.08;
      if (segPointDist(ax, ay, bx, by, sx, sy) > rPx) continue;
      it.dead = true;
      if (it.mine) this._hitMine(it, sx, sy);
      else this._slice(it, b, dirX, dirY, sx, sy, t);
    }
  }

  _slice(it, b, dirX, dirY, sx, sy, t) {
    this.scene.remove(it.mesh);
    const def = it.def;
    // cut plane normal (screen y points down, world y points up)
    const n = new THREE.Vector3(dirY, dirX, 0).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    for (const side of [1, -1]) {
      const mesh = createHalf(def);
      const dir = n.clone().multiplyScalar(side);
      mesh.quaternion.setFromUnitVectors(up, dir);
      mesh.position.copy(it.pos).addScaledVector(dir, 0.08);
      this.scene.add(mesh);
      this.halves.push({
        mesh,
        vel: it.vel.clone().multiplyScalar(0.6).addScaledVector(dir, rand(2.5, 4)).add(new THREE.Vector3(dirX * 2, -dirY * 2, rand(-1, 1))),
        spin: new THREE.Vector3(rand(-4, 4), rand(-4, 4), rand(-4, 4)).multiplyScalar(side),
      });
    }
    this._juice(it.pos, def.flesh, def.golden ? 40 : 22, dirX, -dirY);
    this._splat(sx, sy, def.flesh, it.r * this.ppu);

    if (this.mode === 'playing') {
      this.score += def.points;
      if (def.golden) this._pop(sx, sy, `+${def.points}`, 'gold');
      // combo tracking per blade
      if (t - b.comboT < COMBO_GAP) b.combo++;
      else b.combo = 1;
      b.comboT = t;
      b.comboX = sx;
      b.comboY = sy;
    }
    this.onEvent({ type: 'slice', golden: !!def.golden });
    this._emitHud();
  }

  _hitMine(it, sx, sy) {
    this.scene.remove(it.mesh);
    this._juice(it.pos, '#ff3355', 30, 0, 1, 9);
    this._juice(it.pos, '#2a2633', 24, 0, 1, 7);
    this._splat(sx, sy, '#20121e', it.r * this.ppu * 1.6);
    this.shake = 0.6;
    this.onEvent({ type: 'mine' });
    if (this.mode === 'playing') {
      this._pop(sx, sy, 'THORN! −1', 'bad');
      this._loseLife();
    }
  }

  _loseLife() {
    this.lives = Math.max(0, this.lives - 1);
    this._emitHud();
    if (this.lives === 0 && this.mode === 'playing') {
      this.mode = 'over';
      this.overTimer = 0;
    }
  }

  // ---- effects -------------------------------------------------------------
  _juice(pos, color, count, dx = 0, dy = 1, speed = 6) {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const idx = this.partRing;
      this.partRing = (idx + 1) % MAX_PARTICLES;
      const q = this.parts[idx];
      q.p.copy(pos);
      q.v.set(rand(-1, 1) + dx * 0.8, rand(-0.6, 1) + dy * 0.4, rand(-0.5, 0.5)).normalize().multiplyScalar(rand(speed * 0.4, speed));
      q.max = q.life = rand(0.45, 0.9);
      q.s = rand(0.6, 1.5);
      this.partMesh.setColorAt(idx, c);
    }
    this.partMesh.instanceColor.needsUpdate = true;
  }

  _splat(x, y, color, size) {
    const blobs = [];
    const n = 7 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = i === 0 ? 0 : rand(0.3, 1.5) * size;
      blobs.push([Math.cos(a) * d, Math.sin(a) * d, i === 0 ? size * 0.9 : rand(0.08, 0.35) * size]);
    }
    this.splats.push({ x, y, color, blobs, age: 0, life: 2.6 });
    if (this.splats.length > 40) this.splats.shift();
  }

  _pop(x, y, text, cls = '') {
    const el = document.createElement('div');
    el.className = 'pop ' + cls;
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    this.popLayer.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  // ---- spawning ------------------------------------------------------------
  _difficulty() {
    return clamp(this.elapsed / 120, 0, 1);
  }

  _queueWave() {
    const d = this._difficulty();
    const playing = this.mode === 'playing';
    const count = playing ? 1 + Math.floor(Math.random() * (1.5 + d * 4)) : 1 + Math.floor(Math.random() * 2);
    const mineChance = playing ? clamp((this.elapsed - 10) / 120, 0, 0.22) : 0;
    let mines = 0;
    const flurry = playing && Math.random() < 0.12 + d * 0.15;
    for (let i = 0; i < count; i++) {
      const mine = mines < 2 && i > 0 && Math.random() < mineChance;
      if (mine) mines++;
      this.pending.push({ at: this.time + (flurry ? i * 0.18 : rand(0, 0.35)), mine });
    }
  }

  _spawn(mine) {
    const def = mine ? null : pickFruit();
    const r = mine ? 0.9 : def.r * (def.scale ? 1.1 : 1);
    const mesh = mine ? createMine() : createFruit(def);
    const x = rand(-this.halfW * 0.75, this.halfW * 0.75);
    const y = -this.halfH - r - 0.5;
    const apex = rand(this.halfH * 0.05, this.halfH * 0.82);
    const vy = Math.sqrt(2 * -GRAVITY * (apex - y));
    const tAir = (2 * vy) / -GRAVITY;
    const targetX = rand(-this.halfW * 0.5, this.halfW * 0.5);
    const vx = ((targetX - x) / tAir) * rand(0.6, 1.2);
    const it = {
      def, mine, r, mesh, dead: false,
      pos: new THREE.Vector3(x, y, 0),
      vel: new THREE.Vector3(vx, vy, 0),
      spin: new THREE.Vector3(rand(-2, 2), rand(-2, 2), rand(-2, 2)),
    };
    mesh.position.copy(it.pos);
    mesh.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
    this.scene.add(mesh);
    this.items.push(it);
    if (mine) this.onEvent({ type: 'mine-spawn' });
  }

  // ---- update --------------------------------------------------------------
  _update(dt) {
    this.time += dt;
    const now = performance.now() / 1000;

    if (this.mode === 'playing') this.elapsed += dt;

    if (this.mode !== 'over') {
      this.nextWave -= dt;
      if (this.nextWave <= 0) {
        this._queueWave();
        const d = this._difficulty();
        this.nextWave = this.mode === 'playing' ? lerp(2.3, 1.05, d) * rand(0.8, 1.2) : rand(1.6, 2.6);
      }
    }
    this.pending = this.pending.filter((p) => {
      if (p.at > this.time) return true;
      if (this.mode !== 'over') this._spawn(p.mine);
      return false;
    });

    // whole items
    const floor = -this.halfH - 2.2;
    for (const it of this.items) {
      if (it.dead) continue;
      it.vel.y += GRAVITY * dt;
      it.pos.addScaledVector(it.vel, dt);
      it.mesh.position.copy(it.pos);
      it.mesh.rotation.x += it.spin.x * dt;
      it.mesh.rotation.y += it.spin.y * dt;
      it.mesh.rotation.z += it.spin.z * dt;
      if (it.mine) {
        const k = 0.5 + 0.5 * Math.sin(this.time * 9);
        it.mesh.userData.bodyMat.emissiveIntensity = 0.15 + k * 0.5;
        it.mesh.userData.eye.scale.setScalar(0.8 + k * 0.4);
      }
      if (it.vel.y < 0 && it.pos.y < floor) {
        it.dead = true;
        this.scene.remove(it.mesh);
        if (!it.mine && this.mode === 'playing') {
          const [sx] = this.toScreen(it.pos.x, 0);
          this._pop(clamp(sx, 40, this.w - 40), this.h - 50, '✕', 'bad miss');
          this.onEvent({ type: 'miss' });
          this._loseLife();
        }
      }
    }
    this.items = this.items.filter((it) => !it.dead);

    // halves
    for (const h of this.halves) {
      h.vel.y += GRAVITY * dt;
      h.mesh.position.addScaledVector(h.vel, dt);
      h.mesh.rotation.x += h.spin.x * dt;
      h.mesh.rotation.y += h.spin.y * dt;
      h.mesh.rotation.z += h.spin.z * dt;
      if (h.mesh.position.y < floor - 2) { h.gone = true; this.scene.remove(h.mesh); }
    }
    this.halves = this.halves.filter((h) => !h.gone);

    // combos resolve once a blade pauses between cuts
    for (const b of Object.values(this.blades)) {
      if (b.combo && now - b.comboT > COMBO_GAP) {
        if (b.combo >= 3 && this.mode === 'playing') {
          this.score += b.combo;
          this._pop(b.comboX, b.comboY - 30, `${b.combo}-HIT COMBO +${b.combo}`, 'combo');
          this.onEvent({ type: 'combo', count: b.combo });
          this._emitHud();
        }
        b.combo = 0;
      }
    }

    this._updateParticles(dt);

    if (this.mode === 'over') {
      this.overTimer += dt;
      if (this.overTimer > 1.1 && !this._overSent) {
        this._overSent = true;
        this.onGameOver(this.score);
      }
    } else {
      this._overSent = false;
    }

    // camera shake
    this.shake = Math.max(0, this.shake - dt * 1.5);
    const s = this.shake * 0.5;
    this.camera.position.set(rand(-s, s), rand(-s, s), CAM_Z);
  }

  _updateParticles(dt) {
    const d = this._dummy;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const q = this.parts[i];
      if (q.life <= 0) {
        d.scale.setScalar(0);
      } else {
        q.life -= dt;
        q.v.y += GRAVITY * 0.7 * dt;
        q.p.addScaledVector(q.v, dt);
        d.position.copy(q.p);
        d.rotation.set(q.life * 9, q.life * 7, 0);
        d.scale.setScalar(q.s * Math.max(q.life / q.max, 0));
      }
      d.updateMatrix();
      this.partMesh.setMatrixAt(i, d.matrix);
    }
    this.partMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- 2D layers -----------------------------------------------------------
  _drawStains(dt) {
    const ctx = this.stainCtx;
    ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.splats) {
      s.age += dt;
      const a = 1 - s.age / s.life;
      if (a <= 0) continue;
      ctx.globalAlpha = 0.5 * a;
      ctx.fillStyle = s.color;
      for (const [bx, by, br] of s.blobs) {
        ctx.beginPath();
        ctx.arc(s.x + bx, s.y + by, br, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    this.splats = this.splats.filter((s) => s.age < s.life);
  }

  _drawBlades() {
    const ctx = this.bladeCtx;
    ctx.clearRect(0, 0, this.w, this.h);
    const now = performance.now() / 1000;
    for (const b of Object.values(this.blades)) {
      b.pts = b.pts.filter((p) => now - p.t < TRAIL_LIFE);
      const pts = b.pts;
      if (pts.length > 1) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 1; i < pts.length; i++) {
            const k = i / (pts.length - 1);
            ctx.strokeStyle = pass === 0 ? b.color : '#ffffff';
            ctx.globalAlpha = pass === 0 ? 0.35 * k : 0.95 * k;
            ctx.lineWidth = (pass === 0 ? 16 : 5) * k + 1;
            ctx.beginPath();
            ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
            ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
      // aim cursor for the phone blade
      if (b.cursor && performance.now() - b.seen < 600) {
        const [x, y] = b.cursor;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  _emitHud() {
    this.onHud({ score: this.score, lives: this.lives, mode: this.mode, paused: this.paused });
  }

  _loop = (nowMs) => {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min((nowMs - this._last) / 1000, 0.05);
    this._last = nowMs;
    if (!this.paused) {
      this._update(dt);
      this._drawStains(dt);
    }
    this._drawBlades();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKey);
    document.removeEventListener('visibilitychange', this._onVis);
    this.renderer.dispose();
    this.container.replaceChildren();
  }
}
