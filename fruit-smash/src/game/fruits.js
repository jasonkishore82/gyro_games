import * as THREE from 'three';

// Faceted low-poly fruit. Every piece is built from primitives at runtime.
export const FRUITS = [
  { id: 'apple', r: 0.85, skin: '#d62b2f', flesh: '#fff1c1', rind: '#f7e3a0', points: 1, weight: 3, stem: true, leaf: true },
  { id: 'orange', r: 0.9, skin: '#ff8c1a', flesh: '#ffb547', rind: '#fff0d6', points: 1, weight: 3, segments: true },
  { id: 'lime', r: 0.7, skin: '#5fbf3a', flesh: '#c8f08f', rind: '#f1ffe0', points: 1, weight: 2, segments: true },
  { id: 'plum', r: 0.68, skin: '#6d2a86', flesh: '#ffcf6b', rind: '#f3e3a8', points: 1, weight: 2, pit: true },
  { id: 'peach', r: 0.8, skin: '#ff9e7a', flesh: '#ffd08a', rind: '#ffe7c2', points: 1, weight: 2, pit: true, stem: true, leaf: true },
  { id: 'melon', r: 1.15, skin: '#2d8a3e', stripe: '#1a5a26', flesh: '#ff4a5c', rind: '#e9f7d6', points: 2, weight: 1.5, scale: [1.25, 1, 1], seeds: true },
  { id: 'coconut', r: 0.95, skin: '#6b4529', flesh: '#fffaf2', rind: '#d9c7b0', points: 2, weight: 1, rough: true },
];

export const GOLDEN = {
  id: 'golden', r: 0.75, skin: '#ffd23f', flesh: '#fff4b0', rind: '#ffe680', points: 5, golden: true, stem: true,
};

const geoCache = new Map();
const matCache = new Map();

function fruitGeometry(def) {
  if (geoCache.has(def.id)) return geoCache.get(def.id);
  const g = new THREE.IcosahedronGeometry(def.r, 1).toNonIndexed();
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const skin = new THREE.Color(def.skin);
  const stripe = def.stripe ? new THREE.Color(def.stripe) : null;
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  for (let f = 0; f < pos.count; f += 3) {
    v.set(0, 0, 0);
    for (let k = 0; k < 3; k++) v.add(new THREE.Vector3().fromBufferAttribute(pos, f + k));
    v.divideScalar(3);
    c.copy(skin);
    if (stripe) {
      const a = Math.atan2(v.z, v.y);
      if (Math.floor(((a + Math.PI) / (Math.PI * 2)) * 12) % 2 === 0) c.copy(stripe);
    }
    // small per-facet variation for a hand-cut look
    c.offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
    for (let k = 0; k < 3; k++) c.toArray(colors, (f + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geoCache.set(def.id, g);
  return g;
}

function skinMaterial(def) {
  const key = 'skin-' + def.id;
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: def.rough ? 1 : def.golden ? 0.25 : 0.5,
    metalness: def.golden ? 0.7 : 0,
    emissive: def.golden ? new THREE.Color('#7a5200') : new THREE.Color(0),
  });
  matCache.set(key, m);
  return m;
}

function plainMat(key, color, opts = {}) {
  if (matCache.has(key)) return matCache.get(key);
  const m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.6, ...opts });
  matCache.set(key, m);
  return m;
}

function addStem(group, def) {
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.35, 5), plainMat('stem', '#5b3a1e'));
  stem.position.y = def.r * 0.98;
  group.add(stem);
  if (def.leaf) {
    const leaf = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), plainMat('leaf', '#3fae4a'));
    leaf.scale.set(1.4, 0.25, 0.6);
    leaf.position.set(0.17, def.r * 1.02, 0);
    leaf.rotation.z = -0.5;
    group.add(leaf);
  }
}

export function createFruit(def) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(fruitGeometry(def), skinMaterial(def));
  if (def.scale) body.scale.set(...def.scale);
  group.add(body);
  if (def.stem) addStem(group, def);
  return group;
}

/** One half of a cut fruit. Dome points along +Y, cut face looks down -Y. */
export function createHalf(def) {
  const group = new THREE.Group();
  const r = def.r * (def.scale ? 1.08 : 1);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(r, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2),
    plainMat('half-' + def.id, def.stripe || def.skin, {
      side: THREE.DoubleSide,
      roughness: def.golden ? 0.25 : 0.55,
      metalness: def.golden ? 0.7 : 0,
    })
  );
  group.add(dome);

  const face = (radius, color, y, key) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 14), plainMat(key, color, { side: THREE.DoubleSide }));
    m.rotation.x = Math.PI / 2;
    m.position.y = y;
    group.add(m);
    return m;
  };
  face(r * 0.99, def.rind, -0.002, 'rind-' + def.id);
  face(r * 0.82, def.flesh, -0.008, 'flesh-' + def.id);

  if (def.segments) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.03, r * 0.75), plainMat('seg-' + def.id, def.rind, { side: THREE.DoubleSide }));
      line.rotation.x = Math.PI / 2;
      line.rotation.z = a;
      line.position.set(Math.sin(a) * r * 0.38, -0.012, Math.cos(a) * r * 0.38);
      // rotation in the face plane
      line.rotation.set(Math.PI / 2, 0, -a);
      group.add(line);
    }
  }
  if (def.pit) face(r * 0.3, '#8a4b25', -0.014, 'pit');
  if (def.seeds) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.CircleGeometry(0.05, 5), plainMat('seed', '#1a1110', { side: THREE.DoubleSide }));
      s.rotation.x = Math.PI / 2;
      s.position.set(Math.cos(a) * r * 0.48, -0.014, Math.sin(a) * r * 0.48);
      group.add(s);
    }
  }
  return group;
}

/** Spiky thorn mine (the hazard). */
export function createMine() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: '#26232e', metalness: 0.6, roughness: 0.35, flatShading: true,
    emissive: new THREE.Color('#ff1a3c'), emissiveIntensity: 0.2,
  });
  const ico = new THREE.IcosahedronGeometry(0.62, 0);
  group.add(new THREE.Mesh(ico, bodyMat));
  const spikeGeo = new THREE.ConeGeometry(0.13, 0.55, 5);
  const spikeMat = plainMat('spike', '#3c3846', { metalness: 0.5, roughness: 0.4 });
  const p = ico.attributes.position;
  const seen = new Set();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const key = v.toArray().map((n) => n.toFixed(2)).join();
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = v.clone().normalize();
    const s = new THREE.Mesh(spikeGeo, spikeMat);
    s.position.copy(dir.clone().multiplyScalar(0.72));
    s.quaternion.setFromUnitVectors(up, dir);
    group.add(s);
  }
  // glowing eye so the mine reads instantly as "don't touch"
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff2d4a' }));
  eye.position.z = 0.55;
  group.add(eye);
  group.userData.bodyMat = bodyMat;
  group.userData.eye = eye;
  return group;
}
