// three.js renderer for the Code City — districts as ground discs, buildings
// as a single InstancedMesh (one draw call), diff heat as emissive color.
// All model/layout logic lives in city-model.js; this file only draws + picks.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const TYPE_COLORS = {
  file: 0x5a9ee6,
  module: 0xd9a441,
  function: 0x5a9e6f,
  class: 0xb07fd9,
  document: 0xd97fa8,
  config: 0x7fd9c9,
  concept: 0xe6c35a,
};
const DEFAULT_COLOR = 0x8b949e;
const HOT_COLOR = 0xff4d2e;
const WARM_COLOR = 0xff9d3d;

function makeLabelSprite(text, scale) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = "600 42px system-ui, sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 32;
  canvas.width = w;
  canvas.height = 64;
  ctx.font = font;
  ctx.fillStyle = "rgba(13,17,23,0.75)";
  ctx.fillRect(0, 0, w, 64);
  ctx.fillStyle = "#e6edf3";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 16, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.set((w / 64) * scale, scale, 1);
  return sprite;
}

export function createCityView(canvas, model, callbacks = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 800, 3200);

  const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xdde7ff, 0x1a2030, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(300, 500, 200);
  scene.add(sun);

  // Overall extent → initial camera framing.
  let extent = 100;
  for (const d of model.districts) {
    extent = Math.max(extent, Math.hypot(d.x, d.z) + d.radius);
  }
  camera.position.set(extent * 0.9, extent * 0.85, extent * 0.9);
  controls.target.set(0, 0, 0);

  // ── Districts: ground discs + labels ──────────────────────────────────────
  const districtMeshes = [];
  for (const d of model.districts) {
    const heatTint = new THREE.Color(0x161d27).lerp(new THREE.Color(0x66200f), Math.min(1, d.heat * 1.6));
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(d.radius, d.radius, 1.5, 48),
      new THREE.MeshStandardMaterial({ color: heatTint, roughness: 0.95 }),
    );
    disc.position.set(d.x, -0.75, d.z);
    disc.userData.district = d;
    scene.add(disc);
    districtMeshes.push(disc);

    const label = makeLabelSprite(d.name, 22);
    label.position.set(d.x, 30 + d.radius * 0.12, d.z);
    scene.add(label);
  }

  // ── Buildings: one InstancedMesh, per-instance color ──────────────────────
  const buildings = model.districts.flatMap((d) => d.buildings.map((b) => ({ b, d })));
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0); // grow upward from the ground
  const instanced = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 }),
    Math.max(1, buildings.length),
  );
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  buildings.forEach(({ b, d }, i) => {
    m.makeScale(b.width, b.height, b.width);
    m.setPosition(d.x + b.x, 0, d.z + b.z);
    instanced.setMatrixAt(i, m);
    color.setHex(b.heat === "hot" ? HOT_COLOR : b.heat === "warm" ? WARM_COLOR : (TYPE_COLORS[b.dominantType] ?? DEFAULT_COLOR));
    instanced.setColorAt(i, color);
  });
  instanced.instanceMatrix.needsUpdate = true;
  if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  scene.add(instanced);

  // ── Picking ────────────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let highlightIndex = -1;

  function setHighlight(i, on) {
    if (i < 0 || i >= buildings.length) return;
    const { b } = buildings[i];
    color.setHex(
      on ? 0xffffff : b.heat === "hot" ? HOT_COLOR : b.heat === "warm" ? WARM_COLOR : (TYPE_COLORS[b.dominantType] ?? DEFAULT_COLOR),
    );
    instanced.setColorAt(i, color);
    instanced.instanceColor.needsUpdate = true;
  }

  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(instanced, false)[0];
    if (hit && hit.instanceId !== undefined) return { kind: "building", ...buildings[hit.instanceId], index: hit.instanceId };
    const discHit = raycaster.intersectObjects(districtMeshes, false)[0];
    if (discHit) return { kind: "district", d: discHit.object.userData.district };
    return null;
  }

  let downAt = null;
  canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
  canvas.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // drag, not click
    const hit = pick(e);
    if (highlightIndex >= 0) setHighlight(highlightIndex, false);
    highlightIndex = -1;
    if (hit?.kind === "building") {
      highlightIndex = hit.index;
      setHighlight(hit.index, true);
      callbacks.onBuildingPick?.(hit.b, hit.d);
    } else if (hit?.kind === "district") {
      callbacks.onDistrictPick?.(hit.d);
    } else {
      callbacks.onClear?.();
    }
  });

  // ── Camera fly-to ──────────────────────────────────────────────────────────
  let fly = null;
  function flyTo(x, z, distance) {
    fly = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toTarget: new THREE.Vector3(x, 0, z),
      toPos: new THREE.Vector3(x + distance * 0.7, distance, z + distance * 0.7),
    };
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  renderer.setAnimationLoop(() => {
    if (fly) {
      fly.t = Math.min(1, fly.t + 0.035);
      const e = 1 - Math.pow(1 - fly.t, 3);
      camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
      controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
      if (fly.t >= 1) fly = null;
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return { flyTo, districts: model.districts };
}
