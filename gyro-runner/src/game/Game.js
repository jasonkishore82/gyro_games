import * as THREE from 'three';
import { createShip } from './ship.js';

// ---- World tuning -------------------------------------------------------
const CELL = 5; // ground block size (m)
const COLS = 31;
const ROWS = 96;
const TOWER_POOL = 320;
const CUBE_POOL = 70;
const PARTICLES = 80;
const VIEW_AHEAD = 470;
const X_LIMIT = 44;
const SPAWN_X = 64;
const Y_MIN = 3.6;
const Y_MAX = 28; // flight ceiling, always below the shortest tower so you can't fly over them
const START_CLEAR = 120;

const FOG_COLOR = new THREE.Color(0xb3aea4);
const SKY_TOP = new THREE.Color(0xeeece4);

// Ship hit box (half extents)
const HIT = { x: 1.45, y: 0.45, z: 1.1 };

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function hash(a, b, s = 0) {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class Game {
  constructor(container, { onHud, onCrash } = {}) {
    this.container = container;
    this.onHud = onHud || (() => {});
    this.onCrash = onCrash || (() => {});

    this.mode = 'menu'; // menu | playing | crashed
    this.paused = false;
    this.time = 0;

    this.keys = { left: 0, right: 0, up: 0, down: 0 };
    this.touch = { x: 0, y: 0, active: false };
    this.tilt = { enabled: false, x: 0, y: 0, neutral: null };
    this.remote = { x: 0, y: 0, at: 0 }; // phone controller over WebSocket

    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();

    this._initRenderer();
    this._initScene();
    this._bindEvents();

    this.resetWorld();
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  }

  // ---------------------------------------------------------------------
  _initRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(this.container.clientWidth, this.container.clientHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.container.appendChild(r.domElement);
    this.renderer = r;
  }

  _initScene() {
    const scene = new THREE.Scene();
    scene.background = FOG_COLOR.clone();
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0072);
    this.scene = scene;

    const cam = new THREE.PerspectiveCamera(66, this.container.clientWidth / this.container.clientHeight, 0.1, 900);
    this.camera = cam;
    this.camRoll = 0;
    this.shake = 0;

    scene.add(new THREE.HemisphereLight(0xfff4ee, 0x3a0a0c, 1.1));
    const sun = new THREE.DirectionalLight(0xfff0e0, 1.6);
    sun.position.set(-0.5, 1, 0.35);
    scene.add(sun);

    // Gradient sky dome with a hazy bright patch on the horizon ahead
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: SKY_TOP }, horizon: { value: FOG_COLOR } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.55));
          float sunF = max(dot(normalize(vDir), normalize(vec3(0.0, 0.35, -1.0))), 0.0);
          c += vec3(1.0, 0.98, 0.92) * pow(sunF, 6.0) * 0.22;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), skyMat);
    this.sky.renderOrder = -1;
    scene.add(this.sky);

    // Base floor under the blocks
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 1400),
      new THREE.MeshLambertMaterial({ color: 0x24070a })
    );
    this.floor.rotation.x = -Math.PI / 2;
    scene.add(this.floor);

    const box = new THREE.BoxGeometry(1, 1, 1);

    // Ground blocks
    this.ground = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff }), COLS * ROWS);
    this.ground.frustumCulled = false;
    scene.add(this.ground);

    // Towers
    this.towers = Array.from({ length: TOWER_POOL }, () => ({ x: 0, z: 1e5, hw: 0, hd: 0, h: 0 }));
    this.towerMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      TOWER_POOL
    );
    this.towerMesh.frustumCulled = false;
    scene.add(this.towerMesh);

    // Floating cubes
    this.cubes = Array.from({ length: CUBE_POOL }, () => ({ x: 0, y: 0, z: 1e5, s: 0, rx: 0, ry: 0, spin: 0 }));
    this.cubeMesh = new THREE.InstancedMesh(
      box,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      CUBE_POOL
    );
    this.cubeMesh.frustumCulled = false;
    scene.add(this.cubeMesh);

    // Explosion debris
    this.parts = Array.from({ length: PARTICLES }, () => ({
      p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), life: 0, max: 1, s: 1,
    }));
    this.partMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }),
      PARTICLES
    );
    this.partMesh.frustumCulled = false;
    scene.add(this.partMesh);
    this.flash = new THREE.PointLight(0xff7a30, 0, 60, 1.5);
    scene.add(this.flash);

    // Initialise instance colours so instanceColor buffers exist
    for (let i = 0; i < TOWER_POOL; i++) this.towerMesh.setColorAt(i, this._color.set(0x501216));
    for (let i = 0; i < CUBE_POOL; i++) this.cubeMesh.setColorAt(i, this._color.set(0x4e3c38));
    for (let i = 0; i < PARTICLES; i++) this.partMesh.setColorAt(i, this._color.set(0xff6a30));
    for (let i = 0; i < COLS * ROWS; i++) this.ground.setColorAt(i, this._color.set(0x501216));

    this.ship = createShip();
    scene.add(this.ship.group);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector2();
  }

  // ---------------------------------------------------------------------
  _bindEvents() {
    this._onResize = () => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    const map = {
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    };
    this._onKeyDown = (e) => {
      if (map[e.code]) { this.keys[map[e.code]] = 1; e.preventDefault(); }
      if ((e.code === 'KeyP' || e.code === 'Escape') && this.mode === 'playing') this.togglePause();
    };
    this._onKeyUp = (e) => { if (map[e.code]) this.keys[map[e.code]] = 0; };

    const el = this.renderer.domElement;
    this._onPointer = (e) => {
      if (e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'pointerleave') {
        this.touch.active = false; this.touch.x = 0; this.touch.y = 0; return;
      }
      if (e.type === 'pointerdown') this.touch.active = true;
      if (!this.touch.active) return;
      const w = el.clientWidth, h = el.clientHeight;
      this.touch.x = clamp((e.clientX - w / 2) / (w * 0.28), -1, 1);
      this.touch.y = clamp(-(e.clientY - h * 0.6) / (h * 0.3), -1, 1);
    };
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave'].forEach((t) =>
      el.addEventListener(t, this._onPointer)
    );

    this._onVisibility = () => { if (document.hidden && this.mode === 'playing' && !this.paused) this.togglePause(); };

    window.addEventListener('resize', this._onResize);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('visibilitychange', this._onVisibility);

    this._onOrient = (e) => {
      if (e.gamma == null || e.beta == null) return;
      const angle = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
      let lr, fb;
      if (angle === 90) { lr = e.beta; fb = -e.gamma; }
      else if (angle === -90 || angle === 270) { lr = -e.beta; fb = e.gamma; }
      else { lr = e.gamma; fb = e.beta; }
      if (!this.tilt.neutral) this.tilt.neutral = { lr, fb };
      this.tilt.x = clamp((lr - this.tilt.neutral.lr) / 20, -1, 1);
      this.tilt.y = clamp((this.tilt.neutral.fb - fb) / 20, -1, 1);
    };
  }

  /** Must be called from a user gesture on iOS. */
  async enableTilt() {
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      }
    } catch {
      return false;
    }
    if (!this.tilt.enabled) window.addEventListener('deviceorientation', this._onOrient);
    this.tilt.enabled = true;
    this.tilt.neutral = null;
    return true;
  }

  /** Steering from a remote controller, each axis in -1..1. */
  setRemoteInput(x, y) {
    this.remote.x = clamp(Number(x) || 0, -1, 1);
    this.remote.y = clamp(Number(y) || 0, -1, 1);
    this.remote.at = performance.now();
  }

  // ---------------------------------------------------------------------
  resetWorld() {
    this.pos.set(0, 6.5, 0);
    this.vel.set(0, 0);
    this.distance = 0;
    this.speed = 40;
    this.nextTower = START_CLEAR;
    this.nextCube = START_CLEAR + 80;
    this.towerRing = 0;
    this.cubeRing = 0;
    this.rowLo = null;
    this.crashTimer = 0;
    this.crashReported = false;
    this.reachedTimer = 0;
    this.ship.group.visible = true;
    this.flash.intensity = 0;
    this.shake = 0;

    const d = this._dummy;
    d.position.set(0, -500, 0); d.scale.set(0, 0, 0); d.rotation.set(0, 0, 0); d.updateMatrix();
    for (let i = 0; i < TOWER_POOL; i++) { this.towers[i].z = 1e5; this.towerMesh.setMatrixAt(i, d.matrix); }
    for (let i = 0; i < CUBE_POOL; i++) { this.cubes[i].z = 1e5; this.cubeMesh.setMatrixAt(i, d.matrix); }
    for (let i = 0; i < PARTICLES; i++) { this.parts[i].life = 0; this.partMesh.setMatrixAt(i, d.matrix); }
    this.towerMesh.instanceMatrix.needsUpdate = true;
    this.cubeMesh.instanceMatrix.needsUpdate = true;
    this.partMesh.instanceMatrix.needsUpdate = true;

    this._updateGround(true);
    this._spawnAhead();
    this._placeCamera(1, 0);
  }

  start(best = 0) {
    this.resetWorld();
    this.target = best >= 500 ? Math.ceil(best) : 1000;
    this.tilt.neutral = null; // recalibrate on current hold
    this.mode = 'playing';
    this.paused = false;
  }

  toMenu() {
    this.mode = 'menu';
    this.paused = false;
    this.resetWorld();
  }

  togglePause() {
    if (this.mode !== 'playing') return;
    this.paused = !this.paused;
    this._emitHud(true);
  }

  // ---- World generation -------------------------------------------------
  _setRow(r) {
    const slot = ((r % ROWS) + ROWS) % ROWS;
    const d = this._dummy;
    d.rotation.set(0, 0, 0);
    for (let c = 0; c < COLS; c++) {
      const hv = hash(r, c, 1);
      let h = 0.25 + hv * hv * 2.2;
      if (hash(r, c, 2) > 0.92) h += 0.6;
      const x = (c - (COLS - 1) / 2) * CELL;
      const z = -r * CELL - CELL / 2;
      d.position.set(x, h / 2, z);
      d.scale.set(CELL * 0.97, h, CELL * 0.97);
      d.updateMatrix();
      const idx = slot * COLS + c;
      this.ground.setMatrixAt(idx, d.matrix);
      const l = 0.07 + hash(r, c, 3) * 0.1 + (h > 2 ? 0.04 : 0);
      this.ground.setColorAt(idx, this._color.setHSL(0.995, 0.62, l));
    }
  }

  _updateGround(force = false) {
    const cur = Math.floor(this.distance / CELL) - 6;
    let changed = false;
    if (force || this.rowLo === null) {
      for (let r = cur; r < cur + ROWS; r++) this._setRow(r);
      this.rowLo = cur;
      changed = true;
    } else {
      while (this.rowLo < cur) {
        this._setRow(this.rowLo + ROWS);
        this.rowLo++;
        changed = true;
      }
    }
    if (changed) {
      this.ground.instanceMatrix.needsUpdate = true;
      this.ground.instanceColor.needsUpdate = true;
    }
  }

  _difficulty() {
    return clamp(this.distance / 7000, 0, 1);
  }

  _pickX(laneChance) {
    let x;
    if (this.mode === 'playing' && Math.random() < laneChance) x = this.pos.x + rand(-7, 7);
    else x = rand(-SPAWN_X, SPAWN_X);
    if (this.mode === 'menu' && Math.abs(x) < 13) x = Math.sign(x || 1) * (13 + Math.random() * 10);
    return x;
  }

  _spawnTower(dist) {
    const i = this.towerRing;
    this.towerRing = (i + 1) % TOWER_POOL;
    const t = this.towers[i];
    t.x = this._pickX(lerp(0.25, 0.42, this._difficulty()));
    t.z = -dist;
    t.hw = rand(1.7, 4.6);
    t.hd = rand(1.7, 4.6);
    t.h = rand(Y_MAX + 10, Y_MAX + 90);
    const d = this._dummy;
    d.rotation.set(0, 0, 0);
    d.position.set(t.x, t.h / 2, t.z);
    d.scale.set(t.hw * 2, t.h, t.hd * 2);
    d.updateMatrix();
    this.towerMesh.setMatrixAt(i, d.matrix);
    this.towerMesh.setColorAt(i, this._color.setHSL(0.99 + rand(-0.01, 0.01), rand(0.5, 0.66), rand(0.12, 0.2)));
  }

  _spawnCube(dist) {
    const i = this.cubeRing;
    this.cubeRing = (i + 1) % CUBE_POOL;
    const c = this.cubes[i];
    c.x = this._pickX(0.5);
    c.z = -dist;
    c.s = rand(2.2, 4.6);
    // bias toward the player's altitude so cubes stay a threat at any height
    c.y = this.mode === 'playing' && Math.random() < 0.5
      ? clamp(this.pos.y + rand(-4, 4), Y_MIN + 0.6, Y_MAX)
      : rand(Y_MIN + 0.6, Y_MAX);
    c.rx = rand(0, Math.PI);
    c.ry = rand(0, Math.PI);
    c.spin = rand(-0.6, 0.6);
    this.cubeMesh.setColorAt(i, this._color.setHSL(rand(0.0, 0.05), rand(0.12, 0.25), rand(0.22, 0.32)));
  }

  _spawnAhead() {
    const horizon = this.distance + VIEW_AHEAD;
    const diff = this._difficulty();
    let spawned = false;
    while (this.nextTower < horizon) {
      this._spawnTower(this.nextTower);
      const gap = this.mode === 'playing' ? lerp(7.5, 3.0, diff) : 6;
      this.nextTower += gap * rand(0.55, 1.45);
      spawned = true;
    }
    while (this.nextCube < horizon) {
      this._spawnCube(this.nextCube);
      const gap = this.mode === 'playing' ? lerp(22, 7, diff) : 24;
      this.nextCube += gap * rand(0.6, 1.4);
      spawned = true;
    }
    if (spawned) {
      this.towerMesh.instanceMatrix.needsUpdate = true;
      this.towerMesh.instanceColor.needsUpdate = true;
      this.cubeMesh.instanceColor.needsUpdate = true;
    }
  }

  // ---- Gameplay ---------------------------------------------------------
  _input() {
    let x = this.keys.right - this.keys.left + this.touch.x;
    let y = this.keys.up - this.keys.down + this.touch.y;
    if (this.tilt.enabled) { x += this.tilt.x; y += this.tilt.y; }
    if (performance.now() - this.remote.at < 500) { x += this.remote.x; y += this.remote.y; }
    return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  }

  _collides() {
    const p = this.pos;
    for (let i = 0; i < TOWER_POOL; i++) {
      const t = this.towers[i];
      if (Math.abs(p.z - t.z) > t.hd + HIT.z) continue;
      if (Math.abs(p.x - t.x) > t.hw + HIT.x) continue;
      if (p.y - HIT.y > t.h) continue;
      return true;
    }
    for (let i = 0; i < CUBE_POOL; i++) {
      const c = this.cubes[i];
      const r = c.s * 0.48;
      if (Math.abs(p.z - c.z) > r + HIT.z) continue;
      if (Math.abs(p.x - c.x) > r + HIT.x) continue;
      if (Math.abs(p.y - c.y) > r + HIT.y) continue;
      return true;
    }
    return false;
  }

  _danger() {
    const p = this.pos;
    for (let i = 0; i < TOWER_POOL; i++) {
      const t = this.towers[i];
      const dz = p.z - t.z;
      if (dz < 4 || dz > 48) continue;
      if (Math.abs(p.x - t.x) < t.hw + HIT.x + 0.8) return true;
    }
    for (let i = 0; i < CUBE_POOL; i++) {
      const c = this.cubes[i];
      const dz = p.z - c.z;
      if (dz < 4 || dz > 48) continue;
      const r = c.s * 0.5;
      if (Math.abs(p.x - c.x) < r + HIT.x + 0.8 && Math.abs(p.y - c.y) < r + HIT.y + 0.8) return true;
    }
    return false;
  }

  _crash() {
    this.mode = 'crashed';
    this.crashTimer = 0;
    this.ship.group.visible = false;
    this.shake = 1;
    this.flash.position.copy(this.pos);
    this.flash.intensity = 400;
    const palette = [0xff6a30, 0xffb040, 0xff3020, 0x5a7c84, 0x2a2a2a];
    for (let i = 0; i < PARTICLES; i++) {
      const q = this.parts[i];
      q.p.copy(this.pos);
      q.v.set(rand(-1, 1), rand(-0.4, 1), rand(-1, 1)).normalize().multiplyScalar(rand(6, 26));
      q.v.z -= this.speed * 0.25;
      q.r.set(rand(0, 6), rand(0, 6), rand(0, 6));
      q.max = q.life = rand(0.7, 1.6);
      q.s = rand(0.5, 1.8);
      this.partMesh.setColorAt(i, this._color.set(palette[i % palette.length]));
    }
    this.partMesh.instanceColor.needsUpdate = true;
  }

  _updateParticles(dt) {
    const d = this._dummy;
    let any = false;
    for (let i = 0; i < PARTICLES; i++) {
      const q = this.parts[i];
      if (q.life <= 0) continue;
      any = true;
      q.life -= dt;
      q.v.y -= 20 * dt;
      q.v.multiplyScalar(1 - dt * 0.8);
      q.p.addScaledVector(q.v, dt);
      if (q.p.y < 0.4) { q.p.y = 0.4; q.v.y *= -0.3; }
      q.r.x += dt * 5; q.r.y += dt * 4;
      const k = Math.max(q.life / q.max, 0);
      d.position.copy(q.p);
      d.rotation.copy(q.r);
      d.scale.setScalar(q.s * k);
      d.updateMatrix();
      this.partMesh.setMatrixAt(i, d.matrix);
    }
    if (any) this.partMesh.instanceMatrix.needsUpdate = true;
    this.flash.intensity *= Math.exp(-dt * 6);
  }

  _placeCamera(dt, roll) {
    const p = this.pos;
    const cam = this.camera;
    const k = dt >= 1 ? 1 : 1 - Math.exp(-dt * 7);
    cam.position.x = lerp(cam.position.x, p.x * 0.88, k);
    cam.position.y = lerp(cam.position.y, p.y + 2.3, k);
    cam.position.z = p.z + 7.4;
    cam.lookAt(p.x * 0.92, p.y + 0.7, p.z - 26);
    this.camRoll = lerp(this.camRoll, roll * 0.35, k);
    cam.rotateZ(this.camRoll);
    if (this.shake > 0) {
      const s = this.shake * 0.6;
      cam.position.x += rand(-s, s);
      cam.position.y += rand(-s, s);
    }
    const fov = 64 + clamp((this.speed - 40) * 0.13, 0, 12);
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.sky.position.copy(cam.position);
    this.floor.position.set(p.x * 0.5, 0, p.z - 500);
  }

  _emitHud(force = false) {
    this.onHud({
      distance: Math.floor(this.distance),
      target: this.target || 1000,
      warn: this.mode === 'playing' && this.warn,
      reached: this.reachedTimer > 0,
      speed: Math.round(this.speed * 3.6),
      altitude: +((this.pos.y - Y_MIN) / (Y_MAX - Y_MIN)).toFixed(3), // 0 = floor, 1 = ceiling
      paused: this.paused,
      mode: this.mode,
      force,
    });
  }

  _update(dt) {
    this.time += dt;
    const t = this.time;
    let roll = 0;

    if (this.mode === 'playing') {
      const diff = this._difficulty();
      this.speed = 40 + diff * 72;
      const inp = this._input();
      const k = Math.min(1, dt * 6);
      this.vel.x += (inp.x * 30 - this.vel.x) * k;
      this.vel.y += (inp.y * 16 - this.vel.y) * k;
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      if (Math.abs(this.pos.x) > X_LIMIT) { this.pos.x = Math.sign(this.pos.x) * X_LIMIT; this.vel.x *= 0.3; }
      if (this.pos.y < Y_MIN) { this.pos.y = Y_MIN; this.vel.y = 0; }
      if (this.pos.y > Y_MAX) { this.pos.y = Y_MAX; this.vel.y = 0; }
      this.pos.z -= this.speed * dt;
      this.distance = -this.pos.z;

      if (this.distance >= this.target) {
        this.target = (Math.floor(this.distance / 1000) + 1) * 1000;
        this.reachedTimer = 2.2;
      }
      this.reachedTimer = Math.max(0, this.reachedTimer - dt);

      if (this._collides()) this._crash();
      this.warn = this._danger();
      roll = -this.vel.x * 0.026;
    } else if (this.mode === 'menu') {
      this.speed = 34;
      const nx = Math.sin(t * 0.45) * 5;
      this.vel.x = (nx - this.pos.x) / Math.max(dt, 1e-3);
      this.pos.x = nx;
      this.pos.y = 6.5 + Math.sin(t * 0.8) * 0.8;
      this.vel.y = Math.cos(t * 0.8) * 0.64;
      this.pos.z -= this.speed * dt;
      this.distance = -this.pos.z;
      roll = -this.vel.x * 0.05;
    } else if (this.mode === 'crashed') {
      this.crashTimer += dt;
      this.shake = Math.max(0, this.shake - dt * 1.4);
      if (this.crashTimer > 1.4 && !this.crashReported) {
        this.crashReported = true;
        this.onCrash(Math.floor(this.distance));
      }
    }

    this._updateParticles(dt);

    if (this.mode !== 'crashed') {
      const g = this.ship.group;
      g.position.copy(this.pos);
      g.rotation.set(
        clamp(this.vel.y * 0.035, -0.4, 0.4),
        clamp(-this.vel.x * 0.006, -0.25, 0.25),
        clamp(-this.vel.x * 0.028, -0.9, 0.9) + Math.sin(t * 2.3) * 0.02,
        'YXZ'
      );
      this.ship.update(t, 1 + (this.speed - 40) / 160);
      this._updateGround();
      this._spawnAhead();
    }

    // Spin floating cubes
    const d = this._dummy;
    for (let i = 0; i < CUBE_POOL; i++) {
      const c = this.cubes[i];
      if (c.z > 1e4) continue;
      d.position.set(c.x, c.y, c.z);
      d.rotation.set(c.rx + t * c.spin * 0.3, c.ry + t * c.spin, 0);
      d.scale.setScalar(c.s);
      d.updateMatrix();
      this.cubeMesh.setMatrixAt(i, d.matrix);
    }
    this.cubeMesh.instanceMatrix.needsUpdate = true;

    this._placeCamera(dt, roll);

    this._hudTimer = (this._hudTimer || 0) + dt;
    if (this._hudTimer > 0.08) {
      this._hudTimer = 0;
      this._emitHud();
    }
  }

  _loop = (now) => {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    if (!this.paused) this._update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('deviceorientation', this._onOrient);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const m = Array.isArray(o.material) ? o.material : [o.material];
        m.forEach((x) => { if (x.map) x.map.dispose(); x.dispose(); });
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
