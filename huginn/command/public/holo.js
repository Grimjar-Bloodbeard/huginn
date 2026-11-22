// Huginn command center: the 3D view ("Holo").
// Your home as stacked glass floors with glowing rooms, every device an orb in its room, the router
// a beacon, the internet a constellation overhead, and every live packet a streak of light between
// them. Built on three.js (vendored, pinned). A module, loaded after the classic scripts; it reads
// their shared names (S, COLORS, lanList, nodeLabel, hash, zoneOf, openDrawer...).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const PLAN_W = 1000, PLAN_H = 700, U = 0.022;           // plan units -> world units (22 x 15.4)
const FLOOR_H = 3.4, WALL_H = 1.15, ORBIT_R = 15, SKY_R = 58;
const LABELS = 1;   // labels live on their own layer and are drawn after the glow, so they stay crisp
const MAX_SPARKS = 420, TRAIL = 6;

let renderer, scene, camera, controls, composer, bloom, canvas;
let active = false, built = false, sig = "", lastInteract = 0, slowFrames = 0, lowPower = false;
const world = { floors: new THREE.Group(), devices: new THREE.Group(), sky: new THREE.Group(), fx: new THREE.Group() };
const devs = new Map();     // key -> { group, core, glow, ring, label, hit, pos, home }
const stars = new Map();    // org -> { sprite, label, pos, bytes, seen }
let router = null, topY = 0, sparkGeo, sparkPts, sparkPool = [], pulses = [];
const lastPath = new Map();

// ---------- small helpers ----------
const col = (hex) => new THREE.Color(hex);
function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.18, "rgba(255,255,255,0.75)");
  r.addColorStop(0.45, "rgba(255,255,255,0.18)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
let GLOW;
function glowSprite(color, scale, opacity = 1) {
  const m = new THREE.SpriteMaterial({ map: GLOW, color: col(color), transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  const s = new THREE.Sprite(m); s.scale.setScalar(scale); return s;
}
// A text label as a sprite, crisp at any zoom (drawn at 2x).
function textSprite(text, { size = 0.028, color = "#E9E5D9", weight = 700, bg = "rgba(10,17,36,0.78)" } = {}) {
  const c = document.createElement("canvas"), g = c.getContext("2d"), px = 44;
  g.font = `${weight} ${px}px "Schibsted Grotesk", "Segoe UI", sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 36; c.width = w; c.height = px + 26;
  g.font = `${weight} ${px}px "Schibsted Grotesk", "Segoe UI", sans-serif`;
  if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, w, c.height, 14); g.fill(); }
  g.fillStyle = color; g.textBaseline = "middle"; g.fillText(text, 18, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }));
  s.scale.set(size * w / c.height, size, 1); s.renderOrder = 10; s.userData.text = text; s.layers.set(LABELS);
  return s;
}
// Frees the graphics memory of removed objects. Shared materials and the glow texture stay.
function dispose(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.userData.shared) continue;
      if (m.map && m.map !== GLOW && !texCache.has(m.map.userData.file)) m.map.dispose();
      m.dispose();
    }
  });
}
function planToWorld(x, y, floorY) { return new THREE.Vector3((x - PLAN_W / 2) * U, floorY, (y - PLAN_H / 2) * U); }
function floors() { return S.house.floors.length ? S.house.floors : [{ id: "_home", name: "Home", rooms: [] }]; }
function FH() { return FLOOR_H * (S.house.spread || 1); }   // floor spacing; "Spread floors" pulls them apart
function floorY(id) { const i = floors().findIndex((f) => f.id === id); return Math.max(0, i) * FH(); }
function placeKeyOf(key) {
  if (key === "router" || key === "pc") return key;
  const ip = key.slice(4), d = S.devices.get(ip);
  return d && d.mac ? d.mac : `ip:${ip}`;
}
function deviceColor(key) {
  if (key === "router") return COLORS.bone;
  if (key === "pc") return COLORS.ember;
  const ip = key.slice(4), d = S.devices.get(ip);
  if (ip === S.piholeIp) return COLORS.dns;
  if (!d) return COLORS.chatter;
  if (d.status && /off|gone|away/i.test(d.status)) return "#4A5375";
  return COLORS.moss;
}

// ---------- the scene ----------
function init() {
  canvas = document.createElement("canvas");
  canvas.id = "holo"; canvas.setAttribute("aria-label", "3D view of the home network. Drag to turn it, pinch or scroll to zoom, tap a glowing device for details.");
  document.body.insertBefore(canvas, document.body.firstChild.nextSibling);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x04070F, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.92;
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x04070F, 0.0105);
  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
  controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.07, minDistance: 5, maxDistance: 90, maxPolarAngle: Math.PI * 0.49,
                            autoRotate: !reduceMotion, autoRotateSpeed: 0.28, rotateSpeed: 0.6, zoomSpeed: 0.9 });
  controls.addEventListener("start", () => { lastInteract = performance.now(); controls.autoRotate = false; });
  GLOW = glowTexture();
  scene.add(world.floors, world.devices, world.sky, world.fx, cables);
  scene.add(new THREE.HemisphereLight(0xCFE3FF, 0x1A2747, 1.4));
  const sun = new THREE.DirectionalLight(0xFFF1DC, 1.6); sun.position.set(12, 30, 18); scene.add(sun);
  buildPanel();
  buildBackdrop(); buildSparks();
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.45, 0.38);
  composer.addPass(bloom); composer.addPass(new OutputPass());
  lowPower = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3;   // slow frames also switch the glow off
  bloom.enabled = !lowPower;
  addEventListener("resize", resize); resize();
  bindTap(); bindZoomButtons();
  setInterval(() => { if (active) refresh(); }, 2000);
  built = true;
}

function resize() {
  if (!renderer) return;
  const dpr = Math.min(devicePixelRatio || 1, lowPower ? 1.25 : NARROW ? 1.5 : 1.75);
  renderer.setPixelRatio(dpr); renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(dpr); composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}

function buildBackdrop() {
  // stars far away
  const n = 1400, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 160 + Math.random() * 60, s = Math.sqrt(1 - u * u);
    p[i * 3] = r * s * Math.cos(a); p[i * 3 + 1] = Math.abs(r * u) * 0.9 - 10; p[i * 3 + 2] = r * s * Math.sin(a);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xBFC8E6, size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.55, fog: false })));
  // a soft polar grid under everything
  const grid = new THREE.PolarGridHelper(42, 24, 9, 96, 0x2B3B63, 0x2B3B63);
  grid.material.transparent = true; grid.material.opacity = 0.14; grid.position.y = -0.6;
  scene.add(grid);
  const halo = new THREE.Mesh(new THREE.CircleGeometry(44, 96), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { c: { value: col("#14204A") } },
    vertexShader: "varying vec2 v; void main(){ v = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
    fragmentShader: "uniform vec3 c; varying vec2 v; void main(){ float d = length(v-0.5)*2.; gl_FragColor = vec4(c, (1.-smoothstep(0.,1.,d))*0.35); }",
  }));
  halo.rotation.x = -Math.PI / 2; halo.position.y = -0.62; scene.add(halo);
}

// Glass floors, glowing walls, room names. Rebuilt only when the plan changes.
const wallMat = (color) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { c: { value: col(color) } },
  vertexShader: "varying vec2 v; void main(){ v = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
  fragmentShader: "uniform vec3 c; varying vec2 v; void main(){ float a = pow(1.-v.y, 2.2)*0.32 + smoothstep(0.93,1.,v.y)*0.55; gl_FragColor = vec4(c, a); }",
});
function buildHouse() {
  for (const g of [...world.floors.children]) { world.floors.remove(g); dispose(g); }
  const fl = floors();
  topY = (fl.length - 1) * FH();
  models.clear();
  fl.forEach((f, i) => {
    const y = i * FH(), g = new THREE.Group(); g.position.y = y;
    if (f.image) addFloorPicture(g, f.image);
    if (f.model) addModel(f, g);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(PLAN_W * U + 0.6, 0.12, PLAN_H * U + 0.6),
      new THREE.MeshBasicMaterial({ color: 0x1A2747, transparent: true, opacity: 0.38, depthWrite: false }));
    slab.position.y = -0.06; g.add(slab);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), new THREE.LineBasicMaterial({ color: 0x5A6A99, transparent: true, opacity: 0.55 }));
    edges.position.y = -0.06; g.add(edges);
    // a faint grid on each floor
    const grid = new THREE.GridHelper(PLAN_W * U, 20, 0x2B3B63, 0x22305A); grid.scale.z = PLAN_H / PLAN_W;
    grid.material.transparent = true; grid.material.opacity = 0.35; grid.position.y = 0.005; g.add(grid);
    for (const r of f.rooms) {
      const w = r.w * U, d = r.h * U, c = planToWorld(r.x + r.w / 2, r.y + r.h / 2, 0);
      const tint = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0x86D6FF, transparent: true, opacity: 0.06, depthWrite: false }));
      tint.rotation.x = -Math.PI / 2; tint.position.set(c.x, 0.01, c.z); g.add(tint);
      const mat = wallMat("#86D6FF");
      for (const [len, px, pz, ry] of [[w, c.x, c.z - d / 2, 0], [w, c.x, c.z + d / 2, 0], [d, c.x - w / 2, c.z, Math.PI / 2], [d, c.x + w / 2, c.z, Math.PI / 2]]) {
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, WALL_H), mat);
        wall.position.set(px, WALL_H / 2, pz); wall.rotation.y = ry; g.add(wall);
      }
      const top = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, WALL_H, d)), new THREE.LineBasicMaterial({ color: 0x86D6FF, transparent: true, opacity: 0.35 }));
      top.position.set(c.x, WALL_H / 2, c.z); g.add(top);
      const label = textSprite(r.name, { size: 0.024, color: "#A9AEC2", weight: 600, bg: null });
      label.position.set(c.x, 0.3, c.z); g.add(label);
    }
    const fname = textSprite(f.name, { size: 0.03, color: "#E9E5D9", weight: 800 });
    fname.position.set(-PLAN_W * U / 2 - 1.2, 0.3, PLAN_H * U / 2); g.add(fname);
    world.floors.add(g);
  });
  // the router's beacon: a beam to the sky and slow rings at its base
  if (router) world.fx.remove(router.beam, router.dome);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 60, 16, 1, true), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { c: { value: col("#E9E5D9") } },
    vertexShader: "varying vec2 v; void main(){ v = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
    fragmentShader: "uniform vec3 c; varying vec2 v; void main(){ gl_FragColor = vec4(c, smoothstep(0.,0.03,v.y) * pow(1.-v.y, 2.) * 0.45); }",
  }));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(240 * U, 28, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({
    color: 0x7FE0B4, transparent: true, opacity: 0.022, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, wireframe: true }));
  router = { beam, dome };
  world.fx.add(beam, dome);
}

// ---------- your floor plan picture on the glass, and your 3D scan ----------
const texCache = new Map(), modelCache = new Map(), models = new Map();   // models: floor id -> wrapper group
function addFloorPicture(g, im) {
  let t = texCache.get(im.file);
  if (!t) { t = new THREE.TextureLoader().load(`api/house/asset/${im.file}`, () => { sig = ""; }); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.userData.file = im.file; texCache.set(im.file, t); }
  const img = t.image; if (!img || !img.width) return;   // drawn on the next rebuild, once it has loaded
  const fit = Math.min(PLAN_W / img.width, PLAN_H / img.height), w = img.width * fit * U, h = img.height * fit * U;
  // Blueprint look: the plan's lines glow in Huginn blue and the paper disappears. Most plans are dark
  // ink on light paper; a light-on-dark plan is read the other way round.
  if (t.userData.ink == null) t.userData.ink = paperIsLight(img) ? 1 : 0;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { map: { value: t }, c: { value: new THREE.Color("#86D6FF") }, op: { value: im.opacity }, ink: { value: t.userData.ink } },
    vertexShader: "varying vec2 v; void main(){ v = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
    fragmentShader: "uniform sampler2D map; uniform vec3 c; uniform float op; uniform float ink; varying vec2 v; void main(){ vec3 p = texture2D(map, v).rgb; float l = dot(p, vec3(0.299,0.587,0.114)); float a = mix(l, 1.0 - l, ink); a = smoothstep(0.12, 0.85, a); gl_FragColor = vec4(c, a * op * 0.85); }",
  }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.012; g.add(m);
}
function paperIsLight(img) {
  try {
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data; let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    return sum / (d.length / 4) > 0.5;
  } catch { return true; }
}
// A scan seen as a hologram: edges glow, faces are nearly clear (fresnel), so the devices inside stay visible.
const holoMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  uniforms: { c: { value: new THREE.Color("#86D6FF") } },
  vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
  fragmentShader: "uniform vec3 c; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(normalize(vN), vV)), 2.4); gl_FragColor = vec4(c, 0.018 + f * 0.34); }",
});
holoMat.userData.shared = true;
function loadModel(file) {
  if (!modelCache.has(file)) {
    modelCache.set(file, new Promise((resolve, reject) => {
      new GLTFLoader().load(`api/house/asset/${file}`, (gltf) => {
        const root = gltf.scene, box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
        let tris = 0;
        root.traverse((o) => { if (o.isMesh) { if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
        // fit the scan's footprint to the plan, sitting on the floor, centred
        resolve({ root, base: (PLAN_W * U * 0.95) / Math.max(size.x, size.z, 0.001), offset: new THREE.Vector3(-c.x, -box.min.y, -c.z), tris });
      }, undefined, reject);
    }));
  }
  return modelCache.get(file);
}
function addModel(f, g) {
  const wrap = new THREE.Group(); g.add(wrap); models.set(f.id, wrap);
  wrap.userData.floorId = f.id;
  loadModel(f.model.file).then((m) => {
    if (models.get(f.id) !== wrap) return;   // the plan changed while it loaded
    const inner = m.root.clone(true); inner.position.copy(m.offset);
    if (f.model.look !== "real") inner.traverse((o) => { if (o.isMesh) o.material = holoMat; });
    wrap.userData.base = m.base; wrap.add(inner);
    if (m.tris > 1.5e6) toast("That 3D scan is very detailed, so the 3D view may run slowly. A lighter export helps.");
  }).catch(() => toast("Huginn couldn't read that 3D scan. Try exporting it again as .glb."));
}
function placeModels() {   // every frame: cheap, so the sliders feel instant
  for (const [fid, wrap] of models) {
    const f = S.house.floors.find((x) => x.id === fid); if (!f || !f.model || !wrap.userData.base) continue;
    const m = f.model;
    wrap.scale.setScalar(wrap.userData.base * m.scale);
    wrap.rotation.y = THREE.MathUtils.degToRad(m.rot);
    wrap.position.set((m.x - PLAN_W / 2) * U, m.lift, (m.y - PLAN_H / 2) * U);
  }
}

// ---------- the 3D settings panel: spread the floors, line up a scan ----------
let panel, panelOpen = false, panelFloor = null;
function buildPanel() {
  panel = document.createElement("div"); panel.className = "holoPanel"; panel.hidden = true;
  document.body.append(panel);
  panel.addEventListener("input", (e) => {
    const k = e.target.dataset.k; if (!k) return;
    const v = Number(e.target.value);
    if (k === "spread") S.house.spread = v / 100;
    else { const f = S.house.floors.find((x) => x.id === panelFloor); if (!f || !f.model) return; f.model[k] = k === "scale" ? Math.pow(10, v / 100) : v; }
    saveHouse(); refresh();
  });
  panel.addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]"); if (!b) return;
    const a = b.dataset.p;
    if (a === "toggle") panelOpen = !panelOpen;
    if (a === "floor") panelFloor = b.dataset.f;
    if (a === "look") { const f = S.house.floors.find((x) => x.id === panelFloor); if (f && f.model) { f.model.look = b.dataset.v; saveHouse(); refresh(); } }
    if (a === "reset") { const f = S.house.floors.find((x) => x.id === panelFloor); if (f && f.model) { Object.assign(f.model, { scale: 1, rot: 0, x: 500, y: 350, lift: 0 }); saveHouse(); refresh(); } }
    renderHoloPanel();
  });
}
function renderHoloPanel() {
  if (!panel) return;
  panel.hidden = !active || !!ride;
  if (panel.hidden) return;
  const withModel = S.house.floors.filter((f) => f.model);
  if (!withModel.some((f) => f.id === panelFloor)) panelFloor = withModel[0] ? withModel[0].id : null;
  const f = withModel.find((x) => x.id === panelFloor), m = f && f.model;
  const slider = (k, label, min, max, val, step = 1) => `<label class="hpS"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
  panel.innerHTML = `<button type="button" class="hpToggle" data-p="toggle" aria-expanded="${panelOpen}">3D settings</button>` + (!panelOpen ? "" : `
    <div class="hpBody">
      ${S.house.floors.length > 1 ? slider("spread", "Spread floors", 100, 300, Math.round((S.house.spread || 1) * 100)) : ""}
      ${!m ? `<p class="hpNote">Add a 3D scan of your home in Floor plan, Edit plan, and line it up here.</p>` : `
        ${withModel.length > 1 ? `<div class="hpFloors">${withModel.map((x) => `<button type="button" data-p="floor" data-f="${esc(x.id)}" aria-pressed="${x.id === panelFloor}">${esc(x.name)}</button>`).join("")}</div>` : ""}
        <div class="hpLook"><button type="button" data-p="look" data-v="holo" aria-pressed="${m.look !== "real"}">Hologram</button><button type="button" data-p="look" data-v="real" aria-pressed="${m.look === "real"}">Real colours</button></div>
        ${slider("scale", "Size", -100, 100, Math.round(Math.log10(m.scale) * 100))}
        ${slider("rot", "Turn", -180, 180, Math.round(m.rot))}
        ${slider("x", "Left, right", 0, 1000, Math.round(m.x))}
        ${slider("y", "Forward, back", 0, 700, Math.round(m.y))}
        ${slider("lift", "Up, down", -5, 5, m.lift, 0.05)}
        <button type="button" class="hpReset" data-p="reset">Reset the scan's position</button>`}
    </div>`);
}

// ---------- devices ----------
function deviceKeys() {
  const keys = ["router", "pc"];
  for (const ip of lanList()) keys.push(`lan:${ip}`);
  return keys;
}
function homeFor(key, i, n) {
  const pl = S.house.places[placeKeyOf(key)];
  if (pl && floors().some((f) => f.id === pl.floor)) return { pos: planToWorld(pl.x, pl.y, floorY(pl.floor) + 0.55), placed: true };
  if (key === "router" && !S.house.floors.length) return { pos: new THREE.Vector3(0, 0.7, 0), placed: true };
  // not placed: a slow ring around the house
  const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.4;
  return { pos: new THREE.Vector3(Math.cos(a) * ORBIT_R, 0.55 + (hash(key) - 0.5) * 0.6, Math.sin(a) * ORBIT_R * 0.8), placed: false };
}
function makeDevice(key) {
  const g = new THREE.Group(), color = deviceColor(key), big = key === "router" || key === "pc";
  const core = new THREE.Mesh(new THREE.SphereGeometry(big ? 0.3 : 0.2, 24, 16), new THREE.MeshBasicMaterial({ color: col(color) }));
  const glow = glowSprite(color, big ? 2.4 : 1.6, 0.85);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(big ? 0.5 : 0.38, 0.035, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
  ring.rotation.x = Math.PI / 2;
  const hit = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
  hit.userData.key = key;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), new THREE.MeshBasicMaterial({ color: col(color), transparent: true, opacity: 0.35 }));
  g.add(core, glow, ring, hit, stem);
  world.devices.add(g);
  return { group: g, core, glow, ring, hit, stem, label: null, labelText: "", pos: new THREE.Vector3(), home: null, color, flash: 0 };
}
function refresh() {
  // rebuild floors when the plan changes
  // Rebuild only when the plan really changes; moving or sizing a 3D scan just moves it (see placeModels).
  const s = JSON.stringify([S.house.spread || 1, S.house.floors.map((f) => ({ ...f, model: f.model && { file: f.model.file, look: f.model.look } }))]);
  if (s !== sig) { sig = s; buildHouse(); }
  const keys = deviceKeys(), unplaced = keys.filter((k) => !S.house.places[placeKeyOf(k)]);
  const seen = new Set();
  keys.forEach((key) => {
    seen.add(key);
    let d = devs.get(key);
    if (!d) { d = makeDevice(key); devs.set(key, d); }
    const h = homeFor(key, unplaced.indexOf(key), unplaced.length);
    d.home = h.pos; d.placed = h.placed;
    if (!d.pos.lengthSq()) d.pos.copy(h.pos).add(new THREE.Vector3(0, 8, 0));   // new ones drop in from above
    const color = deviceColor(key);
    if (color !== d.color) { d.color = color; d.core.material.color.set(color); d.glow.material.color.set(color); d.stem.material.color.set(color); }
    const dv = key.startsWith("lan:") ? S.devices.get(key.slice(4)) : null;
    const z = dv && typeof zoneOf === "function" ? zoneOf(dv) : null;
    const zc = z && S.zones.zones.find((x) => x.id === z);
    const flagged = dv && S.flagged && S.flagged.has(dv.ip);
    d.ring.material.color.set(flagged ? COLORS.blocked : zc ? zc.color : "#ffffff");
    d.ring.material.opacity = flagged ? 0.95 : zc ? 0.85 : 0;
    d.flagged = flagged;
    const text = nodeLabel(key);
    const want = key === "router" || key === "pc" || S.selected === key || (dv && dv.label) || d.placed;
    if (want && d.labelText !== text) {
      if (d.label) { d.group.remove(d.label); dispose(d.label); }
      d.label = textSprite(text, { size: 0.026 }); d.label.center.set(0.5, -0.6); d.label.position.y = 0.3; d.group.add(d.label); d.labelText = text;
    } else if (!want && d.label) { d.group.remove(d.label); dispose(d.label); d.label = null; d.labelText = ""; }
  });
  for (const [k, d] of devs) if (!seen.has(k)) { world.devices.remove(d.group); dispose(d.group); devs.delete(k); }
  refreshSky();
  buildCables();
}

// ---------- the internet: one star per company ----------
function starPos(org) {
  const az = hash(org) * Math.PI * 2, el = 0.55 + hash(org + "e") * 0.75;   // well above the house, a dome of companies
  return new THREE.Vector3(Math.cos(el) * Math.cos(az) * SKY_R * 0.8, topY + 10 + Math.sin(el) * SKY_R * 0.5, Math.cos(el) * Math.sin(az) * SKY_R * 0.8);
}
function starFor(org) {
  let s = stars.get(org);
  if (!s) {
    const sprite = glowSprite("#86D6FF", 1.6, 0.9);
    s = { sprite, label: null, pos: starPos(org), bytes: 0, seen: performance.now() };
    sprite.position.copy(s.pos); world.sky.add(sprite); stars.set(org, s);
  }
  return s;
}
function refreshSky() {
  const by = new Map();
  for (const h of S.hosts.values()) { const o = h.org || "Unknown websites"; by.set(o, (by.get(o) || 0) + h.in + h.out); }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const labelled = new Set(top.slice(0, NARROW ? 6 : 10).map(([o]) => o));
  for (const [o, bytes] of top) {
    const s = starFor(o); s.bytes = bytes; s.seen = performance.now();
    s.sprite.scale.setScalar(1.2 + Math.min(3.2, Math.log10(1 + bytes) * 0.45));
    if (labelled.has(o) && !s.label) { s.label = textSprite(o, { size: 0.025, color: "#86D6FF", weight: 700, bg: "rgba(4,7,15,0.6)" }); s.label.center.set(0.5, -0.7); s.label.position.copy(s.pos); world.sky.add(s.label); }
    if (!labelled.has(o) && s.label) { world.sky.remove(s.label); dispose(s.label); s.label = null; }
  }
  for (const [o, s] of stars) if (!by.has(o)) { world.sky.remove(s.sprite); dispose(s.sprite); if (s.label) { world.sky.remove(s.label); dispose(s.label); } stars.delete(o); }
}

// ---------- packets: streaks of light with a fading tail ----------
function buildSparks() {
  const n = MAX_SPARKS * TRAIL;
  sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  sparkPts = new THREE.Points(sparkGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { scale: { value: 1 } },
    vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float scale;
      varying vec3 vC; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); gl_PointSize = aSize * scale * (260.0 / -mv.z); gl_Position = projectionMatrix * mv; vC = aColor; vA = aAlpha; }`,
    fragmentShader: `varying vec3 vC; varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * (1.0 + a), a * a * vA); }`,
  }));
  sparkPts.frustumCulled = false;
  world.fx.add(sparkPts);
}
// ---------- how a packet really travels: through a cable or the air, the router, then up to the internet ----------
const V3 = THREE.Vector3, UP = new V3(0, 1, 0);
function linkOf(key) {
  if (key === "pc") return "cable";                 // a desktop PC is usually on Ethernet
  if (key === "router") return null;
  const d = S.devices.get(key.slice(4));
  return d && d.link === "cable" ? "cable" : "wifi";
}
function floorOf(y) { return Math.max(0, Math.floor((y + 0.2) / FH())) * FH(); }
// From a device to the router: along the floor and up a riser for a cable, a gentle arc through the air for Wi-Fi.
function legToRouter(key, live = true) {
  const d = devs.get(key), r = devs.get("router"); if (!d || !r) return null;
  const R = (live ? r.pos : r.home || r.pos).clone();
  if (key === "router") return [R];
  const a = (live ? d.pos : d.home || d.pos).clone();
  if (linkOf(key) === "cable") {
    const fy = floorOf(a.y) + 0.04, ry = floorOf(R.y) + 0.04;
    return [a, new V3(a.x, fy, a.z), new V3(R.x, fy, a.z), new V3(R.x, fy, R.z), new V3(R.x, ry, R.z), R];
  }
  const out = [], mid = a.clone().lerp(R, 0.5).add(UP.clone().multiplyScalar(0.5 + a.distanceTo(R) * 0.06));
  for (let i = 0; i <= 10; i++) { const t = i / 10, u = 1 - t; out.push(new V3(u * u * a.x + 2 * u * t * mid.x + t * t * R.x, u * u * a.y + 2 * u * t * mid.y + t * t * R.y, u * u * a.z + 2 * u * t * mid.z + t * t * R.z)); }
  return out;
}
function starOf(key) { const h = S.hosts.get(key.slice(4)); return starFor((h && h.org) || "Unknown websites"); }
function routeFor(src, dst) {
  const r = devs.get("router"); if (!r) return null;
  const beamTop = new V3(r.pos.x, topY + 14, r.pos.z);
  const devLeg = (k) => (k === "cast" ? [r.pos.clone(), r.pos.clone().add(UP.clone().multiplyScalar(1.6))] : legToRouter(devs.has(k) ? k : "router"));
  if (dst.startsWith("net:")) { const leg = devLeg(src); return leg && leg.concat([beamTop, starOf(dst).pos.clone()]); }
  if (src.startsWith("net:")) { const leg = devLeg(dst); return leg && [starOf(src).pos.clone(), beamTop].concat(leg.reverse()); }
  if (dst === "cast") return devLeg(src) && devLeg(src).concat([r.pos.clone().add(UP.clone().multiplyScalar(1.6))]);
  const a = devLeg(src), b = devLeg(dst); if (!a || !b) return null;
  return a.concat(b.reverse().slice(1));
}
function measure(pts) { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1])); return cum; }
function along(sp, t, out) {
  const d = Math.max(0, Math.min(1, t)) * sp.len, cum = sp.cum;
  let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1, f = (d - cum[i - 1]) / seg;
  return out.copy(sp.pts[i - 1]).lerp(sp.pts[i], Math.max(0, Math.min(1, f)));
}
const rippleAt = new Map();
function ripple(key) {   // Wi-Fi: a ring in the air where the packet leaves or lands
  const d = devs.get(key), now = performance.now();
  if (!d || linkOf(key) !== "wifi" || now - (rippleAt.get(key) || 0) < 700) return;
  rippleAt.set(key, now);
  pulse(d.pos.clone(), "#86D6FF", 0.45, true);
}
// Called from app.js addSparks() for every batch, live or Rewind.
window.holoSparks = (list) => {
  if (!active || !built) return;
  const now = performance.now();
  let added = 0;
  for (const sp of list) {
    if (added > 40) break;
    const k = `${sp.s}|${sp.d}|${sp.k}`, ridden = ride && (sp.s === ride.key || sp.d === ride.key);
    if (!ridden && now - (lastPath.get(k) || 0) < 260) continue;
    lastPath.set(k, now);
    const pts = routeFor(sp.s, sp.d); if (!pts || pts.length < 2) continue;
    const cum = measure(pts), len = cum[cum.length - 1]; if (len < 0.05) continue;
    sparkPool.push({ pts, cum, len, c: col(COLORS[sp.k] || COLORS.bone), born: now + Math.random() * 120,
                     dur: Math.min(3400, Math.max(700, len / 11 * 1000)), size: Math.min(1.25, 0.55 + Math.log10(1 + (sp.b || 60)) * 0.16),
                     src: sp.s, dst: sp.d, k: sp.k, bytes: sp.b || 0, started: false });
    added++;
  }
  if (sparkPool.length > MAX_SPARKS) sparkPool.splice(0, sparkPool.length - MAX_SPARKS);
  if (lastPath.size > 4000) lastPath.clear();
};
const tmp = new THREE.Vector3();
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
function updateSparks(now) {
  const pos = sparkGeo.attributes.position.array, cc = sparkGeo.attributes.aColor.array, sz = sparkGeo.attributes.aSize.array, al = sparkGeo.attributes.aAlpha.array;
  let i = 0;
  for (let n = sparkPool.length - 1; n >= 0; n--) {
    const s = sparkPool[n], p = (now - s.born) / s.dur;
    if (p >= 1) {
      sparkPool.splice(n, 1); s.done = true;
      const d = devs.get(s.dst); if (d) d.flash = Math.min(1, d.flash + 0.35);
      ripple(s.dst);
      if (s.k === "blocked") pulse(s.pts[s.pts.length - 1], COLORS.blocked, 0.9);
      continue;
    }
    if (p < 0) continue;
    if (!s.started) { s.started = true; ripple(s.src); }
    const e = ease(p), big = ride && ride.spark === s ? 1.8 : 1;
    for (let k = 0; k < TRAIL && i < MAX_SPARKS * TRAIL; k++, i++) {
      along(s, e - k * (0.5 / Math.max(4, s.len)), tmp);
      pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z;
      cc[i * 3] = s.c.r; cc[i * 3 + 1] = s.c.g; cc[i * 3 + 2] = s.c.b;
      sz[i] = s.size * big * (1 - k * 0.13); al[i] = (1 - k / TRAIL) * (p > 0.9 ? (1 - p) / 0.1 : 1);
    }
  }
  sparkGeo.setDrawRange(0, i);
  for (const a of ["position", "aColor", "aSize", "aAlpha"]) sparkGeo.attributes[a].needsUpdate = true;
}

// Cables you can see: one glowing run along the floor from each wired device to the router.
let cableSig = "";
const cables = new THREE.Group();
const cableMat = new THREE.MeshBasicMaterial({ color: 0x86D6FF, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending });
cableMat.userData.shared = true;
function buildCables() {
  const wired = [...devs.keys()].filter((k) => k !== "router" && linkOf(k) === "cable");
  const r = devs.get("router");
  const sig2 = JSON.stringify([wired, r && r.home, wired.map((k) => devs.get(k).home), FH()]);
  if (sig2 === cableSig || !r || !r.home) return;
  cableSig = sig2;
  for (const c of [...cables.children]) { cables.remove(c); c.geometry.dispose(); }
  for (const k of wired) {
    const pts = legToRouter(k, false); if (!pts) continue;
    const path = new THREE.CurvePath();
    for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(pts[i - 1]) > 0.01) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
    if (!path.curves.length) continue;
    cables.add(new THREE.Mesh(new THREE.TubeGeometry(path, path.curves.length * 8, 0.03, 6, false), cableMat));
  }
}

// ---------- ride along: the camera chases one device's packets ----------
let ride = null, hud = null;
const KIND_WORDS = { out: "leaving", in: "coming back", dns: "asking for a website", blocked: "blocked by the ad blocker", lan: "inside the house", chatter: "calling out to everyone", cast: "calling out to everyone" };
function rideText(sp) {
  if (!sp) return `Waiting for ${esc(nodeLabel(ride.key))} to send something...`;
  const from = nodeLabel(sp.src), to = sp.dst === "cast" ? "everyone" : nodeLabel(sp.dst);
  const net = sp.src.startsWith("net:") || sp.dst.startsWith("net:");
  const local = sp.src.startsWith("net:") ? sp.dst : sp.src;
  const how = local === "router" ? "" : linkOf(local) === "cable" ? "along the cable" : "through the air";
  const route = [how, "through the router", net ? "and out over the internet" : ""].filter(Boolean).join(", ");
  return `<b>${esc(from)}</b> to <b>${esc(to)}</b>, ${esc(KIND_WORDS[sp.k] || "")}<br><span>${esc(route)}. ${sp.bytes ? esc(fmtBytes(sp.bytes)) : ""}</span>`;
}
function startRide(key) {
  ride = { key, spark: null, since: performance.now(), shown: "" };
  controls.enabled = false; controls.autoRotate = false;
  if (!hud) {
    hud = document.createElement("div"); hud.className = "rideHud"; hud.setAttribute("aria-live", "polite");
    hud.addEventListener("click", (e) => { const b = e.target.closest("[data-r]"); if (!b) return; if (b.dataset.r === "stop") stopRide(); else if (ride) { ride.spark = null; ride.skip = true; } });
    document.body.append(hud);
  }
  hud.hidden = false; renderHud(); renderHoloPanel();
}
function stopRide() {
  ride = null; if (hud) hud.hidden = true;
  controls.enabled = true; lastInteract = performance.now(); renderHoloPanel();
}
function renderHud() {
  if (!ride || !hud) return;
  const txt = rideText(ride.spark);
  if (txt === ride.shown) return;
  ride.shown = txt;
  hud.innerHTML = `<p class="rhTitle">Riding with ${esc(nodeLabel(ride.key))}${S.replay ? " (Rewind)" : ""}</p><p class="rhNow">${txt}</p>
    <div class="rhBtns"><button type="button" data-r="next">Next packet</button><button type="button" data-r="stop" class="primary">Stop riding</button></div>`;
}
function updateRide(now) {
  if (!ride) return;
  const sp = ride.spark;
  if (!sp || sp.done) {
    const pick = sparkPool.filter((x) => (x.src === ride.key || x.dst === ride.key) && (now - x.born) / x.dur < 0.35 && x !== sp)
      .sort((a, b) => b.born - a.born)[0];
    ride.spark = pick || null; ride.skip = false;
    if (pick) { const p = Math.max(0, (now - pick.born) / pick.dur), slow = pick.dur * 2.6; pick.born = now - p * slow; pick.dur = slow; }   // slow-motion for the one you ride
  }
  const s = ride.spark, want = new V3(), look = new V3();
  if (s) {
    const e = ease(Math.max(0, (now - s.born) / s.dur));
    along(s, e, look); along(s, Math.max(0, e - 2.2 / s.len), want);
    const dir = look.clone().sub(want); if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    want.copy(look).sub(dir.normalize().multiplyScalar(5.5)).add(UP.clone().multiplyScalar(2.2));
  } else {
    const d = devs.get(ride.key); if (!d) return stopRide();
    look.copy(d.pos); want.copy(d.pos).add(new V3(4.5, 3, 4.5));
  }
  camera.position.lerp(want, 0.08); controls.target.lerp(look, 0.12); camera.lookAt(controls.target);
  renderHud();
}

// Rings that spread on the floor: a blocked ad landing, the router breathing.
function pulse(at, color, scale = 1, air = false) {
  if (pulses.length > 40) return;
  const m = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 48), new THREE.MeshBasicMaterial({ color: col(color), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  m.rotation.x = -Math.PI / 2; m.position.copy(at); m.userData = { born: performance.now(), scale, air };
  world.fx.add(m); pulses.push(m);
}

// ---------- the loop (only while the 3D view is showing and the page is visible) ----------
let lastFrame = 0, lastBreath = 0;
function frame(ts) {
  if (!active) return;
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(64, ts - (lastFrame || ts)); lastFrame = ts;
  if (!ride && !reduceMotion && !controls.autoRotate && performance.now() - lastInteract > 9000) controls.autoRotate = true;
  if (!ride) controls.update();
  const t = ts / 1000;
  for (const [key, d] of devs) {
    const bob = reduceMotion ? 0 : Math.sin(t * 1.3 + hash(key) * 6) * 0.06;
    d.pos.lerp(tmp.copy(d.home).setY(d.home.y + bob), 0.08);
    d.group.position.copy(d.pos);
    const floorBelow = Math.floor((d.pos.y + 0.01) / FH()) * FH();
    d.stem.scale.y = Math.max(0.01, d.pos.y - floorBelow); d.stem.position.y = -(d.pos.y - floorBelow) / 2;
    d.stem.visible = d.placed;
    d.flash *= 0.94;
    const sel = S.selected === key;
    d.glow.scale.setScalar((key === "router" || key === "pc" ? 2.4 : 1.6) * (1 + d.flash * 0.7 + (sel ? 0.5 : 0)));
    // a glow right in front of the camera would white out the screen, so it fades as you get close
    const near = THREE.MathUtils.smoothstep(camera.position.distanceTo(d.pos), 2, 7);
    d.glow.material.opacity = (0.65 + d.flash * 0.35) * near;
    if (d.flagged) d.ring.material.opacity = 0.55 + 0.4 * (reduceMotion ? 1 : (Math.sin(t * 3) + 1) / 2);
    d.ring.rotation.z = t * 0.6;
  }
  placeModels();
  const r = devs.get("router");
  if (r && router) {
    router.beam.position.set(r.pos.x, r.pos.y + 30, r.pos.z);
    router.dome.position.set(r.pos.x, r.pos.y - 0.55, r.pos.z);
    if (!reduceMotion && ts - lastBreath > 2600) { lastBreath = ts; pulse(new THREE.Vector3(r.pos.x, r.pos.y - 0.5, r.pos.z), COLORS.moss, 2.2); }
  }
  for (let i = pulses.length - 1; i >= 0; i--) {
    const m = pulses[i], p = (performance.now() - m.userData.born) / 1600;
    if (p >= 1) { world.fx.remove(m); m.geometry.dispose(); m.material.dispose(); pulses.splice(i, 1); continue; }
    m.scale.setScalar(1 + p * 6 * m.userData.scale); m.material.opacity = (m.userData.air ? 0.55 : 0.8) * (1 - p);
    if (m.userData.air) m.lookAt(camera.position);   // Wi-Fi rings face you, like waves in the air
  }
  for (const s of stars.values()) s.sprite.material.opacity = 0.75 + 0.25 * Math.sin(t * 0.8 + hash(s.pos.x + "") * 6);
  updateSparks(performance.now());
  updateRide(performance.now());
  if (bloom.enabled) composer.render(); else renderer.render(scene, camera);
  renderer.autoClear = false; camera.layers.set(LABELS); renderer.render(scene, camera);   // crisp labels on top
  camera.layers.set(0); renderer.autoClear = true;
  // keep it smooth: if frames run slow for a while, drop the glow pass
  if (dt > 34) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
  if (slowFrames > 90 && bloom.enabled) { bloom.enabled = false; lowPower = true; resize(); }
}

function frameAll(instant) {
  // Fit the whole ring of devices on screen, whatever the screen's shape (a tall phone needs more distance).
  const radius = ORBIT_R * 1.12 + floors().length * 0.6;
  const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = Math.min(88, radius / Math.sin(Math.min(vfov, hfov) / 2) * (camera.aspect < 0.8 ? 0.78 : 0.92));
  const target = new THREE.Vector3(0, topY / 2 + 1, 0);
  const pos = target.clone().add(new THREE.Vector3(0.3, 0.62, 1).normalize().multiplyScalar(dist));
  if (instant) { camera.position.copy(pos); controls.target.copy(target); }
  else { flight = { from: camera.position.clone(), to: pos, tf: controls.target.clone(), tt: target, born: performance.now() }; }
  controls.update();
}
let flight = null;
setInterval(() => {   // simple camera flights (fit, focus on a device)
  if (!flight || !active) return;
  const p = Math.min(1, (performance.now() - flight.born) / 700), e = 1 - Math.pow(1 - p, 3);
  camera.position.lerpVectors(flight.from, flight.to, e); controls.target.lerpVectors(flight.tf, flight.tt, e);
  if (p >= 1) flight = null;
}, 16);
function focus(key) {
  const d = devs.get(key); if (!d) return;
  const dir = camera.position.clone().sub(controls.target).normalize().multiplyScalar(9);
  flight = { from: camera.position.clone(), to: d.pos.clone().add(dir), tf: controls.target.clone(), tt: d.pos.clone(), born: performance.now() };
  lastInteract = performance.now(); controls.autoRotate = false;
}

// ---------- tapping a device; the zoom buttons ----------
function bindTap() {
  const ray = new THREE.Raycaster(), v = new THREE.Vector2();
  let down = null;
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 7 || performance.now() - down.t > 600) { down = null; return; }
    down = null;
    v.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(v, camera);
    const hits = ray.intersectObjects([...devs.values()].map((d) => d.hit), false);
    if (hits.length) { const key = hits[0].object.userData.key; openDrawer(key); focus(key); }
    else closeDrawer();
  });
}
function bindZoomButtons() {
  const dolly = (f) => { const off = camera.position.clone().sub(controls.target).multiplyScalar(f); const len = off.length(); if (len > 4 && len < 95) camera.position.copy(controls.target).add(off); lastInteract = performance.now(); controls.autoRotate = false; };
  for (const [id, f] of [["zoomIn", 0.7], ["zoomOut", 1 / 0.7]]) $(id).addEventListener("click", (e) => { if (!active) return; e.stopImmediatePropagation(); dolly(f); }, true);
  $("zoomFit").addEventListener("click", (e) => { if (!active) return; e.stopImmediatePropagation(); frameAll(false); }, true);
  // "Show on map" in a device's sheet flies the camera to it
  drawerBody.addEventListener("click", (e) => { if (!active) return; const b = e.target.closest('[data-act="find"]'); if (b && S.selected) { e.stopImmediatePropagation(); focus(S.selected); if (NARROW) drawer.hidden = true; } }, true);
}

// ---------- switching on and off ----------
drawerBody.addEventListener("click", (e) => {
  const b = e.target.closest('[data-act="ride"]'); if (!b) return;
  e.stopImmediatePropagation();
  const key = b.dataset.key;
  if (S.view !== "holo") setView("holo");
  closeDrawer();
  setTimeout(() => { if (active) startRide(key); }, S.view === "holo" ? 60 : 400);
}, true);
addEventListener("keydown", (e) => { if (e.key === "Escape" && ride) stopRide(); });
window.Holo = {
  ride: (key) => startRide(key), stopRide: () => stopRide(), riding: () => ride && { key: ride.key, spark: !!ride.spark },
  // for tests: where a device is on screen
  screenOf(key) { const d = devs.get(key); if (!d) return null; const v = d.pos.clone().project(camera); return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; },
  setActive(on) {
    if (on && !built) { try { init(); } catch (err) { console.error(err); toast("This device can't show the 3D view. Back to the map."); setView("sky"); return; } }
    if (on === active) return;
    active = on;
    if (canvas) canvas.hidden = !on;
    if (on) { refresh(); frameAll(true); lastFrame = 0; requestAnimationFrame(frame); }
    else { sparkPool.length = 0; if (ride) stopRide(); }
    renderHoloPanel();
  },
};
if (S.view === "holo") Holo.setActive(true);
