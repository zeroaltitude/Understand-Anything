// three.js renderer for the Code City v2 — nested containment districts as
// stacked ground discs, buildings as a single InstancedMesh (one draw call),
// facet skins as per-instance colors. All model/layout logic lives in
// city-model.js; facet values/palettes in facet-model.js; this file only
// draws, picks, and repaints.
//
// The skeleton never moves: applyFacet(id) rewrites ONLY the instance color
// buffer (O(buildings) color writes, no re-layout), which is what makes facet
// switching instant at any city size.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const HIGHLIGHT_COLOR = 0xffffff;
const PLATE_BASE = 0x131a23;
const PLATE_STEP = 0x0a0d12; // additive lightening per depth level
const PLATE_HEAT = 0x66200f;

function plateColor(depth, heat, weatherActive) {
  const base = new THREE.Color(PLATE_BASE).add(
    new THREE.Color(PLATE_STEP).multiplyScalar(Math.min(depth, 4)),
  );
  if (weatherActive && heat > 0) {
    return base.lerp(new THREE.Color(PLATE_HEAT), Math.min(1, heat * 1.6));
  }
  return base;
}

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

/**
 * @param {HTMLCanvasElement} canvas
 * @param {ReturnType<import("./city-model.js").buildCityModel>} model
 * @param {{facets: Array<any>, defaultFacetId: string}} facetCatalog
 * @param {{onBuildingPick?: Function, onDistrictPick?: Function, onClear?: Function}} callbacks
 */
export function createCityView(canvas, model, facetCatalog, callbacks = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xdde7ff, 0x1a2030, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(300, 500, 200);
  scene.add(sun);

  // Fog + far plane scale with the city so deep containment trees (large
  // root radii) neither fade out nor clip at the far corner.
  const extent = Math.max(100, model.root.radius);
  scene.fog = new THREE.Fog(0x0d1117, extent * 0.8, extent * 3.5);
  camera.far = Math.max(6000, extent * 6);
  camera.updateProjectionMatrix();
  camera.position.set(extent * 0.9, extent * 0.85, extent * 0.9);
  controls.target.set(0, 0, 0);

  // ── Districts: nested ground discs, depth-stacked, + labels ────────────────
  // Skip the synthetic root plate when it has exactly one child and no direct
  // buildings (a repo whose files all live under one top dir) — it adds a ring
  // of dead space around everything.
  const drawnDistricts = model.districts.filter(
    (d) => !(d.depth === 0 && d.children.length === 1 && d.buildings.length === 0),
  );
  const districtMeshes = [];
  for (const d of drawnDistricts) {
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(d.radius, d.radius, 1.2, 48),
      new THREE.MeshStandardMaterial({ roughness: 0.95 }),
    );
    disc.position.set(d.x, -1.4 + d.depth * 0.9, d.z);
    disc.userData.district = d;
    scene.add(disc);
    districtMeshes.push(disc);

    // Label the shallow tiers always; deeper tiers only when they're sizable —
    // flying in reveals detail (cheap LOD without swap machinery).
    if (d.depth <= 2 || d.radius >= 60) {
      const label = makeLabelSprite(d.name, Math.max(10, 22 - d.depth * 4));
      label.position.set(d.x, 26 + d.radius * 0.1 - d.depth * 3, d.z);
      scene.add(label);
    }
  }

  function paintPlates(weatherActive) {
    for (const mesh of districtMeshes) {
      const d = mesh.userData.district;
      mesh.material.color.copy(plateColor(d.depth, d.heat, weatherActive));
    }
  }

  // ── Buildings: one InstancedMesh, facet-driven per-instance color ──────────
  const buildings = model.buildings;
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0); // grow upward from the ground
  const instanced = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 }),
    Math.max(1, buildings.length),
  );
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  buildings.forEach((b, i) => {
    m.makeScale(b.width, b.height, b.width);
    m.setPosition(b.ax, 0, b.az);
    instanced.setMatrixAt(i, m);
  });
  instanced.instanceMatrix.needsUpdate = true;
  scene.add(instanced);

  // ── Facet skins ─────────────────────────────────────────────────────────────
  let activeFacet = null;

  function applyFacet(facetId) {
    const facet = facetCatalog.facets.find((f) => f.id === facetId) ?? facetCatalog.facets[0];
    activeFacet = facet;
    buildings.forEach((b, i) => {
      color.setHex(facet.colorOf(b));
      instanced.setColorAt(i, color);
    });
    if (highlightIndex >= 0) {
      color.setHex(HIGHLIGHT_COLOR);
      instanced.setColorAt(highlightIndex, color);
    }
    instanced.instanceColor.needsUpdate = true;
    paintPlates(facet.id === "weather");
    return facet;
  }

  // ── Picking ────────────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let highlightIndex = -1;

  function setHighlight(i, on) {
    if (i < 0 || i >= buildings.length) return;
    color.setHex(on ? HIGHLIGHT_COLOR : activeFacet.colorOf(buildings[i]));
    instanced.setColorAt(i, color);
    instanced.instanceColor.needsUpdate = true;
  }

  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(instanced, false)[0];
    if (hit && hit.instanceId !== undefined) {
      return { kind: "building", b: buildings[hit.instanceId], index: hit.instanceId };
    }
    // Districts overlap by construction (nesting) — pick the DEEPEST plate hit
    // so clicking inside a sub-district selects it, not its ancestor.
    const discHits = raycaster.intersectObjects(districtMeshes, false);
    if (discHits.length > 0) {
      let best = discHits[0].object.userData.district;
      for (const h of discHits) {
        const d = h.object.userData.district;
        if (d.depth > best.depth) best = d;
      }
      return { kind: "district", d: best };
    }
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
      callbacks.onBuildingPick?.(hit.b);
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

  applyFacet(facetCatalog.defaultFacetId);

  return { flyTo, applyFacet, districts: model.districts };
}
