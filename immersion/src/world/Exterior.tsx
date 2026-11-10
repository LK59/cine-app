import { useLayoutEffect, useMemo, useRef } from "react";
import { useLoader, useThree } from "@react-three/fiber";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { BackSide, BufferAttribute, Color, ConeGeometry, CylinderGeometry, DoubleSide, InstancedMesh, MeshStandardMaterial, NoColorSpace, Object3D, PlaneGeometry, RepeatWrapping, Shape, ShapeGeometry, ShaderMaterial, SphereGeometry, Vector3 } from "three";
import { assetUrl } from "../lib/assets";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ROOM } from "./layout";
import { WEST_WINDOW, WEST_WINDOWS } from "./Shell";
import { configureKtx2 } from "./textures";
import { useProfile } from "../state/store";

/**
 * La lune, deux fois : là où on la **voit** dans le ciel (assez basse pour entrer dans le cadre de la
 * baie depuis le canapé), et d'où vient sa **lumière** (plus haute : ses rayons tombent sur le parquet
 * au pied de la baie, avec l'ombre des petits bois, au lieu de zébrer le canapé). L'écart ne se lit pas.
 */
export const MOON_DIRECTION = new Vector3(-0.3, 0.52, -0.8).normalize();
export const MOONLIGHT_FROM = new Vector3(-5, 22, -11);
const MOONLIGHT_DIRECTION = MOONLIGHT_FROM.clone().normalize();

// ── Un bruit simple et reproductible : le relief est le même à chaque visite ─────────────────────
function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, z: number, octaves = 5): number {
  let value = 0;
  let amplitude = 0.5;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise(x, z);
    x *= 2.03;
    z *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * La hauteur du terrain. Le chalet est posé sur un replat ; au nord la pente descend vers une
 * vallée, puis remonte en montagnes — ce que la baie cadre. Ailleurs, des crêtes ferment l'horizon.
 */
export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // Le replat, puis la descente vers la vallée du nord.
  const drop = smooth(9, 95, -z) * 22 + smooth(12, 70, r) * 3;
  const rolling = (fbm(x * 0.02 + 3, z * 0.02 + 7) - 0.5) * 9 * smooth(10, 60, r);
  // Les montagnes : au-delà de la vallée, un massif, plus haut au nord et au nord-est.
  const far = smooth(120, 330, r);
  const ridge = Math.pow(fbm(x * 0.006 + 11, z * 0.006 + 5, 6), 1.5);
  const north = 0.55 + 0.45 * smooth(-150, 150, -z + x * 0.25);
  const mountains = far * (30 + ridge * 235) * north;
  return -0.42 - drop + rolling + mountains;
}

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uMoon;
  varying vec3 vDirection;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  void main() {
    vec3 d = normalize(vDirection);
    float h = clamp(d.y, -0.2, 1.0);
    // L'heure bleue : un zénith profond, un horizon plus clair, encore un peu de jour au nord-ouest.
    vec3 zenith = vec3(0.012, 0.028, 0.085);
    vec3 horizon = vec3(0.075, 0.16, 0.36);
    vec3 sky = mix(horizon, zenith, pow(smoothstep(-0.05, 0.75, h), 0.62));
    float dusk = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(-0.75, 0.0, -0.66))), 0.0), 3.0) * pow(1.0 - smoothstep(0.0, 0.42, h), 2.0);
    sky += vec3(0.11, 0.15, 0.24) * dusk;
    // Les étoiles : une grille de directions, une étoile dans une cellule sur quarante.
    vec3 cell = floor(d * 190.0);
    float star = hash(cell);
    float twinkle = step(0.976, star) * smoothstep(0.02, 0.3, h);
    vec3 local = fract(d * 190.0) - 0.5;
    sky += vec3(0.85, 0.9, 1.0) * twinkle * smoothstep(0.42, 0.0, length(local)) * (0.55 + 1.6 * hash(cell + 3.0));
    // La lune : un disque net et son halo.
    float m = dot(d, normalize(uMoon));
    sky += vec3(1.0, 0.97, 0.9) * smoothstep(0.99955, 0.9997, m) * 5.5;
    sky += vec3(0.32, 0.42, 0.62) * (pow(max(m, 0.0), 420.0) * 0.9 + pow(max(m, 0.0), 26.0) * 0.16);
    gl_FragColor = vec4(sky, 1.0);
  }
`;

/**
 * Le dehors a son propre éclairage, écrit ici : la lune, le ciel, la brume — et rien d'autre.
 *
 * Avec les matières ordinaires, la lumière orangée du lustre sortait par la baie et, mêlée au bleu de
 * la lune sur une neige presque blanche, donnait du gris : la nuit bleue de la référence disparaissait.
 * Ces matières-ci ignorent les lumières de la pièce (et coûtent bien moins : la neige couvre la moitié
 * des pixels de la baie). La lueur chaude au pied des fenêtres est ajoutée à la main, là où elle a un
 * sens.
 */
const OUTDOOR_COMMON = /* glsl */ `
  uniform vec3 uMoonDir;
  uniform vec3 uMoonColor;
  uniform vec3 uSkyColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  vec3 outdoorFog(vec3 color, float distance) {
    float f = 1.0 - exp(-pow(uFogDensity * distance, 2.0));
    return mix(color, uFogColor, clamp(f, 0.0, 1.0));
  }
`;

const SNOW_VERTEX = /* glsl */ `
  attribute vec3 color;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vTint;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vTint = color;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const SNOW_FRAGMENT = /* glsl */ `
  ${OUTDOOR_COMMON}
  uniform sampler2D uDetail;
  uniform vec3 uWindow;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vTint;
  void main() {
    float distance = length(cameraPosition - vWorld);
    // Le grain de la neige, près du chalet seulement : au loin il ne ferait que scintiller.
    vec3 detail = texture2D(uDetail, vWorld.xz / 3.2).xyz * 2.0 - 1.0;
    float near = 1.0 - smoothstep(18.0, 70.0, distance);
    vec3 n = normalize(vNormal + vec3(detail.x, 0.0, detail.y) * 0.5 * near);
    float moon = max(dot(n, uMoonDir), 0.0);
    vec3 albedo = vec3(0.9, 0.93, 1.0) * vTint;
    vec3 color = albedo * (uSkyColor + uMoonColor * moon);
    // La poudreuse renvoie la lune en paillettes.
    vec3 view = normalize(cameraPosition - vWorld);
    color += uMoonColor * pow(max(dot(reflect(-uMoonDir, n), view), 0.0), 48.0) * 0.35 * near * vTint.b;
    // La lumière des fenêtres, sur la neige à leur pied.
    vec2 toWindow = vec2(max(abs(vWorld.x) - 5.2, 0.0), max(uWindow.z - vWorld.z, 0.0));
    float glow = exp(-length(toWindow) * 0.34) * step(vWorld.z, uWindow.z + 0.5);
    color += vec3(1.0, 0.62, 0.3) * 0.42 * glow * albedo;
    gl_FragColor = vec4(outdoorFog(color, distance), 1.0);
  }
`;

const FIR_VERTEX = /* glsl */ `
  attribute vec3 color;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vTint;
  void main() {
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = modelMatrix * instanceMatrix;
    #endif
    vec4 world = m * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(m) * normal);
    vTint = color;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const FIR_FRAGMENT = /* glsl */ `
  ${OUTDOOR_COMMON}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vTint;
  void main() {
    vec3 n = normalize(vNormal);
    float moon = max(dot(n, uMoonDir), 0.0) * 0.8 + 0.2 * max(n.y, 0.0);
    vec3 color = vTint * (uSkyColor * 1.1 + uMoonColor * moon);
    gl_FragColor = vec4(outdoorFog(color, length(cameraPosition - vWorld)), 1.0);
  }
`;

const FOG_COLOR = new Color("#0c1a36");
const outdoorUniforms = () => ({
  uMoonDir: { value: MOONLIGHT_DIRECTION },
  uMoonColor: { value: new Color(0.42, 0.56, 0.95) },
  uSkyColor: { value: new Color(0.035, 0.065, 0.16) },
  uFogColor: { value: FOG_COLOR },
  uFogDensity: { value: 0.0048 },
});

const dummy = new Object3D();

/** Un sapin : un tronc et sept étages de branches, de plus en plus courts, la neige sur le dessus. */
function firGeometry() {
  const parts = [];
  const paint = (geometry: ConeGeometry | CylinderGeometry, low: Color, high: Color, y0: number, y1: number) => {
    const positions = geometry.getAttribute("position");
    const colors = new Float32Array(positions.count * 3);
    const c = new Color();
    for (let i = 0; i < positions.count; i++) {
      const t = Math.min(1, Math.max(0, (positions.getY(i) - y0) / (y1 - y0)));
      c.copy(low).lerp(high, t * t * t);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    return geometry;
  };
  parts.push(paint(new CylinderGeometry(0.03, 0.05, 0.2, 6).translate(0, 0.1, 0), new Color("#120d09"), new Color("#120d09"), 0, 1));
  const tiers = 7;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const radius = 0.3 * (1 - t * 0.8);
    const height = 0.3 - t * 0.1;
    const y = 0.14 + t * 0.66;
    // Chaque étage est un cône ouvert, un peu décalé en rotation : la silhouette n'est pas un cône lisse.
    const cone = new ConeGeometry(radius, height, 11, 1, true).rotateY(i * 0.9).translate(0, y + height / 2, 0);
    parts.push(paint(cone, new Color("#05110d"), new Color("#6f87ab"), y - height * 0.1, y + height));
  }
  const merged = mergeGeometries(
    parts.map((p) => (p.index ? p.toNonIndexed() : p)),
    false
  )!;
  merged.computeVertexNormals();
  return merged;
}

/**
 * Le dehors : la nuit, la neige, les sapins, les montagnes — et les vitrages par lesquels on les
 * voit. Rien de ce qui est ici n'a besoin d'être beau de près : on ne sort pas.
 */
export function Exterior() {
  const profile = useProfile();
  const gl = useThree((s) => s.gl);
  const detail = useLoader(KTX2Loader, assetUrl("textures/snow/normal.ktx2"), configureKtx2(gl));

  const terrain = useMemo(() => {
    const size = 900;
    const segments = 150;
    const geometry = new PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2);
    const positions = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    const colors = new Float32Array(positions.count * 3);
    const c = new Color();
    const forest = new Color("#10202c");
    const white = new Color("#ffffff");
    for (let i = 0; i < positions.count; i++) {
      // Un maillage plus serré près du chalet : la grille est resserrée vers son centre.
      const gx = positions.getX(i) / (size / 2);
      const gz = positions.getZ(i) / (size / 2);
      const x = Math.sign(gx) * Math.pow(Math.abs(gx), 1.9) * (size / 2);
      const z = Math.sign(gz) * Math.pow(Math.abs(gz), 1.9) * (size / 2);
      const y = groundHeight(x, z);
      positions.setXYZ(i, x, y, z);
      uv.setXY(i, x / 7, z / 7);
      // Au loin, les pentes moyennes sont boisées : une bande sombre sous les sommets blancs.
      const r = Math.hypot(x, z);
      const band = smooth(110, 200, r) * (1 - smooth(55, 120, y)) * smooth(0.35, 0.6, fbm(x * 0.03, z * 0.03, 3));
      c.copy(white).lerp(forest, band * 0.8);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return geometry;
  }, []);

  const snowMaterial = useMemo(() => {
    detail.wrapS = RepeatWrapping;
    detail.wrapT = RepeatWrapping;
    detail.colorSpace = NoColorSpace;
    detail.needsUpdate = true;
    return new ShaderMaterial({
      vertexShader: SNOW_VERTEX,
      fragmentShader: SNOW_FRAGMENT,
      uniforms: { ...outdoorUniforms(), uDetail: { value: detail }, uWindow: { value: new Vector3(0, 0, ROOM.north) } },
    });
  }, [detail]);

  const sky = useMemo(
    () => ({
      geometry: new SphereGeometry(1, 48, 24),
      material: new ShaderMaterial({ vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, uniforms: { uMoon: { value: MOON_DIRECTION } }, side: BackSide, depthWrite: false, fog: false }),
    }),
    []
  );

  // ── Les sapins : un seul maillage instancié ─────────────────────────────────
  const firs = useRef<InstancedMesh>(null);
  const fir = useMemo(() => ({ geometry: firGeometry(), material: new ShaderMaterial({ vertexShader: FIR_VERTEX, fragmentShader: FIR_FRAGMENT, uniforms: outdoorUniforms() }) }), []);
  const firCount = profile.snow >= 8000 ? 900 : profile.snow >= 4000 ? 600 : 320;
  useLayoutEffect(() => {
    const mesh = firs.current;
    if (!mesh) return;
    let placed = 0;
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let guard = 0;
    while (placed < firCount && guard++ < firCount * 40) {
      // Plus denses vers le nord (ce que la baie regarde), jusqu'au pied des montagnes.
      const angle = random() * Math.PI * 2;
      const radius = 15 + Math.pow(random(), 1.5) * 230;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius * (Math.sin(angle) < 0 ? 1.15 : 0.7);
      // Pas devant la baie de trop près : la vue plonge d'abord sur la pente.
      if (z < 0 && z > -42 && Math.abs(x) < 13 + (-z - 8) * 0.15) continue;
      if (radius < 30) continue;
      // Des bosquets, pas un semis régulier.
      if (fbm(x * 0.035 + 20, z * 0.035 + 20, 3) < 0.44 + random() * 0.12) continue;
      const y = groundHeight(x, z);
      if (y > 70) continue;
      const height = 4.5 + random() * 7.5;
      dummy.position.set(x, y - 0.2, z);
      dummy.rotation.set(0, random() * Math.PI, 0);
      dummy.scale.set(height * (0.85 + random() * 0.3), height, height * (0.85 + random() * 0.3));
      dummy.updateMatrix();
      mesh.setMatrixAt(placed++, dummy.matrix);
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [firCount]);

  // ── Les vitrages : presque rien, sauf un reflet ─────────────────────────────
  // Un miroir presque transparent : ce qu'on voit du vitrage, c'est la pièce qui s'y reflète faiblement
  // par-dessus la nuit — les lampes dans les carreaux, comme sur une vraie baie le soir.
  const glass = useMemo(() => new MeshStandardMaterial({ color: "#ffffff", roughness: 0.03, metalness: 1, transparent: true, opacity: 0.13, envMapIntensity: 2.2, depthWrite: false, side: DoubleSide }), []);
  const gable = useMemo(() => {
    const shape = new Shape();
    shape.moveTo(-ROOM.halfW, 0.2);
    shape.lineTo(ROOM.halfW, 0.2);
    shape.lineTo(ROOM.halfW, ROOM.eave);
    shape.lineTo(0, ROOM.ridge);
    shape.lineTo(-ROOM.halfW, ROOM.eave);
    shape.closePath();
    return new ShapeGeometry(shape);
  }, []);
  const pane = useMemo(() => new PlaneGeometry(WEST_WINDOW.width, WEST_WINDOW.top - WEST_WINDOW.sill), []);

  return (
    <group>
      <mesh geometry={sky.geometry} material={sky.material} scale={500} frustumCulled={false} renderOrder={-10} />
      <mesh geometry={terrain} material={snowMaterial} />
      <instancedMesh ref={firs} args={[fir.geometry, fir.material, firCount]} key={firCount} frustumCulled={false} />
      <mesh geometry={gable} material={glass} position={[0, 0, ROOM.north + 0.13]} renderOrder={3} />
      {WEST_WINDOWS.map((z) => (
        <mesh key={z} geometry={pane} material={glass} position={[-ROOM.halfW + 0.02, (WEST_WINDOW.sill + WEST_WINDOW.top) / 2, z]} rotation-y={Math.PI / 2} renderOrder={3} />
      ))}
    </group>
  );
}
