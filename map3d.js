// Three.js 3D 한국 지도: 시·도 지형을 입체로 세우고, 지역마다 기둥(색=등급, 높이=수치)과 날씨 라벨을 올린다
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const LON0 = 127.5;
const LAT0 = 36.3;
const COS = Math.cos((LAT0 * Math.PI) / 180);
const S = 1; // 위도 1도 = 월드 1.0
const DEPTH = 0.08; // 지형 두께

const toX = (lon) => (lon - LON0) * COS * S;
const toZ = (lat) => -(lat - LAT0) * S;
const toLon = (x) => x / (COS * S) + LON0;
const toLat = (z) => LAT0 - z / S;

function makeLabel(text) {
  const c = document.createElement("canvas");
  c.width = 160;
  c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(15,23,42,.82)";
  g.beginPath();
  g.roundRect(4, 6, 152, 52, 26);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 30px 'Segoe UI Emoji','Segoe UI',sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 80, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export async function createMap3D({ container, geoUrl, onPickItem, onPickPoint }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 7.5, 6.5);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.1;
  controls.minDistance = 2;
  controls.maxDistance = 16;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 9, 5);
  scene.add(sun);

  /* --- 지형 --- */
  const land = new THREE.Group();
  scene.add(land);
  const landMat = new THREE.MeshStandardMaterial({ color: 0xdbe7f3, roughness: 0.9 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x4b6584 });

  const geo = await (await fetch(geoUrl)).json();
  for (const f of geo.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) {
      // Shape 좌표 (x, y) → rotateX(-90°) 후 월드 (x, 높이, -y) 이므로 y = -z
      const pts = (ring) => ring.map(([lo, la]) => new THREE.Vector2(toX(lo), -toZ(la)));
      const shape = new THREE.Shape(pts(rings[0]));
      for (const hole of rings.slice(1)) shape.holes.push(new THREE.Path(pts(hole)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, landMat);
      land.add(m);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 40), lineMat);
      land.add(edges);
    }
  }

  /* --- 지역 기둥 + 라벨 --- */
  const pins = new THREE.Group();
  scene.add(pins);
  let items = [];
  const pickables = [];

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.12, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide })
  );
  ring.visible = false;
  scene.add(ring);

  const pointMarker = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.25, 16).rotateX(Math.PI),
    new THREE.MeshStandardMaterial({ color: 0xe11d48 })
  );
  pointMarker.visible = false;
  scene.add(pointMarker);

  function clearPins() {
    for (const o of [...pins.children]) {
      o.geometry?.dispose();
      o.material?.map?.dispose();
      o.material?.dispose();
      pins.remove(o);
    }
    pickables.length = 0;
  }

  // item: { lat, lon, label, name, color, value(0~1), text }
  function setItems(newItems, selectedLabel) {
    items = newItems;
    clearPins();
    items.forEach((it, idx) => {
      const sel = it.label === selectedLabel;
      const h = 0.08 + it.value * 1.1;
      const r = sel ? 0.07 : 0.045;
      const bar = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, h, 16),
        new THREE.MeshStandardMaterial({ color: it.color, roughness: 0.5 })
      );
      bar.position.set(toX(it.lon), DEPTH + h / 2, toZ(it.lat));
      bar.userData.idx = idx;
      pins.add(bar);
      pickables.push(bar);

      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabel(it.text), depthTest: false }));
      sp.scale.set(sel ? 0.7 : 0.5, sel ? 0.28 : 0.2, 1);
      sp.position.set(toX(it.lon), DEPTH + h + 0.14, toZ(it.lat));
      sp.renderOrder = sel ? 3 : 2;
      sp.userData.idx = idx;
      pins.add(sp);
      pickables.push(sp);
    });
    const s = items.find((it) => it.label === selectedLabel);
    ring.visible = !!s;
    if (s) ring.position.set(toX(s.lon), DEPTH + 0.01, toZ(s.lat));
  }

  /* --- 선택/이동 --- */
  let fly = null;
  function focus(lat, lon, isPoint) {
    fly = new THREE.Vector3(toX(lon), 0, toZ(lat));
    pointMarker.visible = !!isPoint;
    if (isPoint) pointMarker.position.set(toX(lon), DEPTH + 0.2, toZ(lat));
    ring.visible = !isPoint && ring.visible;
  }

  /* --- 입력 --- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const el = renderer.domElement;

  function cast(e, objs) {
    const r = el.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(objs, false);
  }

  let down = null;
  el.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  el.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const hit = cast(e, pickables)[0];
    if (hit) return onPickItem(items[hit.object.userData.idx]);
    const ground = cast(e, land.children.filter((o) => o.isMesh))[0];
    if (ground) onPickPoint(toLat(ground.point.z), toLon(ground.point.x));
  });

  const tip = document.createElement("div");
  tip.className = "tip3d";
  tip.hidden = true;
  container.appendChild(tip);
  let moving = false;
  el.addEventListener("pointermove", (e) => {
    if (moving) return;
    moving = true;
    requestAnimationFrame(() => {
      moving = false;
      const hit = cast(e, pickables)[0];
      el.style.cursor = hit ? "pointer" : "grab";
      tip.hidden = !hit;
      if (hit) {
        const r = el.getBoundingClientRect();
        tip.textContent = items[hit.object.userData.idx].name;
        tip.style.left = `${e.clientX - r.left + 12}px`;
        tip.style.top = `${e.clientY - r.top + 12}px`;
      }
    });
  });
  el.addEventListener("pointerleave", () => { tip.hidden = true; });

  /* --- 렌더 루프 --- */
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    if (fly) {
      const d = fly.clone().sub(controls.target).multiplyScalar(0.12);
      controls.target.add(d);
      camera.position.add(d);
      if (d.length() < 0.001) fly = null;
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return { setItems, focus };
}
