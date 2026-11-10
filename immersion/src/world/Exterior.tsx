import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLoader, useThree } from "@react-three/fiber";
import { BackSide, BufferAttribute, Color, ConeGeometry, type BufferGeometry, CylinderGeometry, DoubleSide, InstancedMesh, LinearFilter, LinearMipmapLinearFilter, MeshStandardMaterial, NoColorSpace, Object3D, PlaneGeometry, RepeatWrapping, Shape, ShapeGeometry, ShaderMaterial, SphereGeometry, SRGBColorSpace, Vector2, Vector3, type CompressedTexture } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { assetUrl } from "../lib/assets";
import { useProfile } from "../state/store";
import { WEST_WINDOW, WEST_WINDOWS } from "./geometry/salon";
import { ktx2For } from "./ktx2";
import { BEDROOM_WINDOW, KITCHEN, MOON, PLAN, ROOM } from "./layout";
import { Snow } from "./Snow";

/** La lune vue dans le ciel, et la direction de sa lumière — voir `MOON` dans le plan. */
export const MOON_DIRECTION = new Vector3(...MOON.seen).normalize();
export const MOONLIGHT_FROM = new Vector3(...MOON.lightFrom);
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

/** Jusqu'où va le premier plan modelé ; au-delà, ce sont les couches du panorama. */
const FOREGROUND = 240;

/**
 * La hauteur du sol au premier plan. Le chalet est posé sur un replat ; tout autour le terrain
 * s'abaisse — plus vite au nord, vers la vallée — pour que son bord lointain passe sous l'horizon du
 * panorama au lieu de le couper.
 */
export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const north = 0.55 + 0.45 * smooth(-60, 60, -z);
  const drop = smooth(11, FOREGROUND, r) * 46 * north;
  const rolling = (fbm(x * 0.022 + 3, z * 0.022 + 7) - 0.5) * 7 * smooth(12, 70, r);
  return -0.42 - drop + rolling;
}

/**
 * Le panorama lointain (`public/assets/panorama/`, rendu une fois hors ligne à partir d'un relief
 * réel — voir `tools/panorama/`) : trois images équirectangulaires recadrées en hauteur.
 * `far` porte les sommets et le ciel ; `mid` et `near`, les pentes plus proches, détourées.
 */
interface PanoramaMeta {
  elevationMin: number;
  elevationMax: number;
  layers: Record<"far" | "mid" | "near", { file: string; from?: number }>;
  moon?: { azimuthDeg: number; elevationDeg: number };
  sky?: { horizon: [number, number, number]; zenith: [number, number, number] };
}
interface Panorama {
  meta: PanoramaMeta;
  far: CompressedTexture;
  mid: CompressedTexture;
  near: CompressedTexture;
}

/** Charge le panorama s'il est là ; sans lui, le ciel dessiné par le code suffit à faire nuit. */
function usePanorama(): Panorama | null {
  const gl = useThree((s) => s.gl);
  const [panorama, setPanorama] = useState<Panorama | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const response = await fetch(assetUrl("panorama/panorama.json"), { credentials: "same-origin" });
      if (!response.ok) return;
      const meta = (await response.json()) as PanoramaMeta;
      const loader = ktx2For(gl);
      const [far, mid, near] = await Promise.all((["far", "mid", "near"] as const).map((layer) => loader.loadAsync(assetUrl(`panorama/${meta.layers[layer].file}`))));
      for (const texture of [far, mid, near]) {
        texture.colorSpace = SRGBColorSpace;
        // L'image fait le tour de l'horizon : elle se répète en largeur, pas en hauteur.
        texture.wrapS = RepeatWrapping;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.magFilter = LinearFilter;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
      }
      if (alive) setPanorama({ meta, far, mid, near });
    })().catch(() => {
      // Panorama absent ou illisible : le ciel de secours reste en place.
    });
    return () => {
      alive = false;
    };
  }, [gl]);
  return panorama;
}

/** Du sens de regard à la coordonnée dans une image du panorama : l'azimut 0 (le nord, la baie) est au centre. */
const PANORAMA_GLSL = /* glsl */ `
  uniform vec2 uElevation;
  vec2 panoramaUv(vec3 d) {
    float azimuth = atan(d.x, -d.z);
    float elevation = degrees(asin(clamp(d.y, -1.0, 1.0)));
    return vec2(azimuth / 6.2831853 + 0.5, (uElevation.y - elevation) / (uElevation.y - uElevation.x));
  }
`;

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
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform sampler2D uFar;
  uniform float uHasFar;
  uniform float uGain;
  varying vec3 vDirection;
  ${PANORAMA_GLSL}
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  vec3 night(vec3 d) {
    float h = clamp(d.y, -0.2, 1.0);
    // L'heure bleue : un zénith profond, un horizon plus clair.
    vec3 sky = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 0.75, h), 0.62));
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
    return sky;
  }
  void main() {
    vec3 d = normalize(vDirection);
    vec3 color = night(d);
    if (uHasFar > 0.5) {
      vec2 uv = panoramaUv(d);
      // Dans la bande du panorama : son image. Au-dessus : le ciel dessiné ici, raccordé en fondu
      // sur le haut de l'image (les teintes du ciel sont celles du rendu).
      vec3 far = texture2D(uFar, vec2(uv.x, clamp(uv.y, 0.002, 0.998))).rgb * uGain;
      float inside = smoothstep(0.0, 0.12, uv.y);
      color = uv.y > 1.0 ? far * 0.6 : mix(color, far, inside);
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;

const LAYER_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const LAYER_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uOrigin;
  uniform float uGain;
  uniform vec2 uSides;
  varying vec3 vWorld;
  ${PANORAMA_GLSL}
  void main() {
    // La direction est prise depuis le point de vue du rendu (le chalet), pas depuis la caméra : la
    // couche est un décor posé à distance, qui glisse un peu devant le fond quand on se déplace.
    vec2 uv = panoramaUv(normalize(vWorld - uOrigin));
    if (uv.y < 0.0 || uv.y > 1.0) discard;
    vec4 texel = texture2D(uMap, uv);
    // La couche la plus proche ne tient que face à la vallée : sur les côtés et derrière le chalet, ce
    // sont des pentes à cent mètres, étirées par leur image — elles s'effacent (uSides : de quel écart
    // à l'axe de la baie, en fraction de tour, à quel écart).
    float alpha = texel.a * (1.0 - smoothstep(uSides.x, uSides.y, abs(uv.x - 0.5)));
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(texel.rgb * uGain, alpha);
  }
`;

/**
 * Le premier plan a son propre éclairage, écrit ici : la lune, le ciel, la brume — et rien d'autre.
 *
 * Avec les matières ordinaires, la lumière du lustre sortait par la baie et, mêlée au bleu de la lune
 * sur une neige presque blanche, donnait du gris. Ces matières-ci ignorent les lumières de la pièce
 * (et coûtent bien moins). La lueur chaude au pied des fenêtres est ajoutée à la main.
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
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const SNOW_FRAGMENT = /* glsl */ `
  ${OUTDOOR_COMMON}
  uniform sampler2D uDetail;
  uniform float uNorth;
  uniform float uEdge;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    float distance = length(cameraPosition - vWorld);
    // Le grain de la neige, près du chalet seulement : au loin il ne ferait que scintiller.
    vec3 detail = texture2D(uDetail, vWorld.xz / 3.2).xyz * 2.0 - 1.0;
    float near = 1.0 - smoothstep(18.0, 70.0, distance);
    vec3 n = normalize(vNormal + vec3(detail.x, 0.0, detail.y) * 0.5 * near);
    float moon = max(dot(n, uMoonDir), 0.0);
    vec3 albedo = vec3(0.9, 0.93, 1.0);
    vec3 color = albedo * (uSkyColor + uMoonColor * moon);
    // La poudreuse renvoie la lune en paillettes.
    vec3 view = normalize(cameraPosition - vWorld);
    color += uMoonColor * pow(max(dot(reflect(-uMoonDir, n), view), 0.0), 48.0) * 0.35 * near;
    // La lumière des fenêtres, sur la neige à leur pied.
    vec2 toWindow = vec2(max(abs(vWorld.x) - 5.2, 0.0), max(uNorth - vWorld.z, 0.0));
    float glow = exp(-length(toWindow) * 0.34) * step(vWorld.z, uNorth + 0.5);
    color += vec3(1.0, 0.62, 0.3) * 0.42 * glow * albedo;
    // Le bord du premier plan s'efface : derrière lui, ce sont les couches du panorama.
    float alpha = 1.0 - smoothstep(uEdge * 0.72, uEdge, length(vWorld.xz));
    gl_FragColor = vec4(outdoorFog(color, distance), alpha);
  }
`;
const FIR_VERTEX = /* glsl */ `
  attribute vec3 color;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vShape;
  varying float vTree;
  void main() {
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = modelMatrix * instanceMatrix;
    #endif
    vec4 world = m * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(m) * normal);
    vShape = color;
    // Un nombre par arbre, tiré de sa place : chaque sapin a sa teinte et sa charge de neige.
    vTree = fract(sin(dot(m[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const FIR_FRAGMENT = /* glsl */ `
  ${OUTDOOR_COMMON}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vShape;
  varying float vTree;
  float cell(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  // Un bruit lissé : des paquets de neige aux bords doux, pas des carrés.
  float grain(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(cell(i), cell(i + vec3(1, 0, 0)), f.x), mix(cell(i + vec3(0, 1, 0)), cell(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(cell(i + vec3(0, 0, 1)), cell(i + vec3(1, 0, 1)), f.x), mix(cell(i + vec3(0, 1, 1)), cell(i + vec3(1, 1, 1)), f.x), f.y),
      f.z
    );
  }
  void main() {
    vec3 n = normalize(vNormal);
    // Les branches sont des nappes sans épaisseur : vues par-dessous, leur normale se retourne.
    if (!gl_FrontFacing) n = -n;
    float distance = length(cameraPosition - vWorld);
    // La neige : sur ce qui regarde le ciel, davantage vers la pointe des branches et en haut de
    // l'arbre, par paquets irréguliers ; dessous, les aiguilles, presque noires la nuit.
    float clumps = mix(grain(vWorld * 2.3), grain(vWorld * 7.1), 0.35);
    float snow = smoothstep(0.5, 0.78, n.y * 0.5 + vShape.x * 0.26 + vShape.y * 0.1 + clumps * 0.42 + vTree * 0.1);
    snow *= step(0.5, float(gl_FrontFacing));
    vec3 needles = mix(vec3(0.012, 0.03, 0.022), vec3(0.03, 0.055, 0.04), vTree) * (0.55 + 0.45 * vShape.x);
    vec3 albedo = mix(needles, vec3(0.86, 0.9, 1.0), snow);
    float moon = max(dot(n, uMoonDir), 0.0);
    // Le cœur de l'arbre est dans sa propre ombre.
    float shade = mix(0.35, 1.0, vShape.x);
    vec3 color = albedo * (uSkyColor * 1.2 + uMoonColor * moon * shade);
    gl_FragColor = vec4(outdoorFog(color, distance), 1.0);
  }
`;

const FOG_COLOR = new Color("#0c1a36");
const outdoorUniforms = () => ({
  uMoonDir: { value: MOONLIGHT_DIRECTION },
  uMoonColor: { value: new Color(0.42, 0.56, 0.95) },
  uSkyColor: { value: new Color(0.035, 0.065, 0.16) },
  uFogColor: { value: FOG_COLOR },
  uFogDensity: { value: 0.0052 },
});

const dummy = new Object3D();

/**
 * Un sapin : un tronc et seize étages de branches. Chaque étage est une couronne de branches de
 * longueurs inégales qui retombent vers leur pointe — pas un cône lisse —, et chaque étage tourne et
 * penche un peu autrement que le précédent. La neige n'est pas peinte ici : c'est le programme de la
 * matière qui la pose sur ce qui regarde le ciel (`FIR_FRAGMENT`).
 *
 * L'attribut `color` porte deux mesures par sommet : à quel point on est près de la pointe d'une
 * branche (rouge), et la hauteur dans l'arbre (vert).
 */
function firGeometry() {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const parts: BufferGeometry[] = [];
  const trunk = new CylinderGeometry(0.012, 0.03, 0.34, 6).translate(0, 0.17, 0);
  trunk.setAttribute("color", new BufferAttribute(new Float32Array(trunk.getAttribute("position").count * 3), 3));
  parts.push(trunk);
  const tiers = 16;
  const segments = 22;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    // La silhouette : large en bas, effilée, avec un léger ventre.
    const radius = 0.3 * Math.pow(1 - t, 0.85) + 0.012;
    const height = 0.15 - t * 0.07;
    const y = 0.12 + t * 0.8;
    const cone = new ConeGeometry(radius, height, segments, 2, true);
    const positions = cone.getAttribute("position");
    const colors = new Float32Array(positions.count * 3);
    const lengths = Array.from({ length: segments }, () => 0.62 + random() * 0.5);
    for (let v = 0; v < positions.count; v++) {
      const py = positions.getY(v);
      // 0 au sommet de l'étage (contre le tronc), 1 à la pointe des branches.
      const out = 1 - (py + height / 2) / height;
      const angle = Math.atan2(positions.getZ(v), positions.getX(v));
      const lobe = ((Math.round((angle / (Math.PI * 2)) * segments) % segments) + segments) % segments;
      // Une branche sur deux est une vraie branche ; entre deux, la couronne se creuse.
      const reach = lobe % 2 === 0 ? lengths[lobe] : lengths[lobe] * 0.5;
      const k = 1 + (reach - 1) * out;
      positions.setXYZ(v, positions.getX(v) * k, py - out * out * height * (lobe % 2 === 0 ? 0.55 : 0.1), positions.getZ(v) * k);
      colors.set([out, t, 0], v * 3);
    }
    cone.setAttribute("color", new BufferAttribute(colors, 3));
    cone.rotateX((random() - 0.5) * 0.09).rotateZ((random() - 0.5) * 0.09).rotateY(random() * Math.PI * 2).translate(0, y + height / 2, 0);
    parts.push(cone);
  }
  const merged = mergeGeometries(
    parts.map((p) => (p.index ? p.toNonIndexed() : p)),
    false
  )!;
  merged.computeVertexNormals();
  return merged;
}

/**
 * Le dehors, en couches :
 *
 * 1. **le fond** — le ciel, et la chaîne de montagnes du panorama (une texture, à l'infini) ;
 * 2. **le plan intermédiaire** — deux couches détourées du même panorama, posées à quelques centaines
 *    de mètres : elles glissent légèrement devant le fond quand on se déplace ;
 * 3. **le premier plan** — le sol de neige autour du chalet et de vrais sapins ;
 * 4. **la neige qui tombe**, devant tout cela ;
 * et les vitrages par lesquels on regarde. Rien ici n'a besoin d'être beau de près : on ne sort pas.
 */
export function Exterior() {
  const profile = useProfile();
  const gl = useThree((s) => s.gl);
  const detail = useLoader(ktx2For(gl), assetUrl("textures/snow/normal.ktx2"));
  const panorama = usePanorama();

  const terrain = useMemo(() => {
    const size = FOREGROUND * 2;
    const segments = 110;
    const geometry = new PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2);
    const positions = geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      // Un maillage plus serré près du chalet : la grille est resserrée vers son centre.
      const gx = positions.getX(i) / (size / 2);
      const gz = positions.getZ(i) / (size / 2);
      const x = Math.sign(gx) * Math.pow(Math.abs(gx), 1.7) * (size / 2);
      const z = Math.sign(gz) * Math.pow(Math.abs(gz), 1.7) * (size / 2);
      positions.setXYZ(i, x, groundHeight(x, z), z);
    }
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
      uniforms: { ...outdoorUniforms(), uDetail: { value: detail }, uNorth: { value: ROOM.north }, uEdge: { value: FOREGROUND } },
      transparent: true,
    });
  }, [detail]);

  const sky = useMemo(
    () => ({
      geometry: new SphereGeometry(1, 48, 24),
      material: new ShaderMaterial({
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        uniforms: {
          uMoon: { value: MOON_DIRECTION.clone() },
          uHorizon: { value: new Color(0.075, 0.16, 0.36) },
          uZenith: { value: new Color(0.012, 0.028, 0.085) },
          uFar: { value: null },
          uHasFar: { value: 0 },
          uGain: { value: 1 },
          uElevation: { value: new Vector2(-28, 32) },
        },
        side: BackSide,
        depthWrite: false,
        fog: false,
      }),
    }),
    []
  );

  // Les deux couches détourées : des cylindres centrés sur le chalet.
  const layers = useMemo(() => {
    const make = (radius: number, sides: [number, number]) => {
      const material = new ShaderMaterial({
        vertexShader: LAYER_VERTEX,
        fragmentShader: LAYER_FRAGMENT,
        uniforms: { uMap: { value: null }, uOrigin: { value: new Vector3(0, 1.64, 0) }, uGain: { value: 1 }, uElevation: { value: new Vector2(-28, 32) }, uSides: { value: new Vector2(...sides) } },
        transparent: true,
        depthWrite: false,
        side: BackSide,
        fog: false,
      });
      // Assez haut pour couvrir toute la bande du panorama vue depuis le chalet.
      const geometry = new CylinderGeometry(radius, radius, radius * 1.4, 96, 1, true);
      return { geometry, material, radius };
    };
    return { mid: make(1400, [0.6, 0.7]), near: make(340, [0.15, 0.23]) };
  }, []);

  // Quand le panorama arrive : il prend la place du ciel de secours, et donne ses teintes et sa lune.
  useEffect(() => {
    if (!panorama) return;
    const { meta } = panorama;
    const elevation = new Vector2(meta.elevationMin, meta.elevationMax);
    sky.material.uniforms.uFar.value = panorama.far;
    sky.material.uniforms.uHasFar.value = 1;
    sky.material.uniforms.uElevation.value = elevation;
    sky.material.uniforms.uGain.value = PANORAMA_GAIN;
    if (meta.sky) {
      sky.material.uniforms.uHorizon.value.setRGB(...meta.sky.horizon).multiplyScalar(PANORAMA_GAIN);
      sky.material.uniforms.uZenith.value.setRGB(...meta.sky.zenith).multiplyScalar(PANORAMA_GAIN);
    }
    // La lune du panorama est au-dessus de sa bande d'image (qui s'arrête à 32°) : c'est le ciel dessiné
    // ici qui en porte le disque, à l'endroit d'où le rendu a éclairé les montagnes.
    if (meta.moon) {
      const azimuth = (meta.moon.azimuthDeg * Math.PI) / 180;
      const elevation = (meta.moon.elevationDeg * Math.PI) / 180;
      sky.material.uniforms.uMoon.value.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
    }
    for (const [name, layer] of Object.entries(layers) as ["mid" | "near", (typeof layers)["mid"]][]) {
      layer.material.uniforms.uMap.value = panorama[name];
      layer.material.uniforms.uElevation.value = elevation;
      layer.material.uniforms.uGain.value = PANORAMA_GAIN;
    }
  }, [panorama, sky, layers]);

  // ── Les sapins du premier plan : un seul maillage instancié ─────────────────
  const firs = useRef<InstancedMesh>(null);
  const fir = useMemo(() => ({ geometry: firGeometry(), material: new ShaderMaterial({ vertexShader: FIR_VERTEX, fragmentShader: FIR_FRAGMENT, uniforms: outdoorUniforms(), side: DoubleSide }) }), []);
  const firCount = profile.snow >= 8000 ? 260 : profile.snow >= 4000 ? 170 : 90;
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
    while (placed < firCount && guard++ < firCount * 60) {
      const angle = random() * Math.PI * 2;
      const radius = 24 + Math.pow(random(), 1.3) * (FOREGROUND * 0.62);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      // Pas devant la baie de trop près : la vue plonge d'abord sur la pente, vers la vallée.
      if (z < 0 && z > -70 && Math.abs(x) < 12 + (-z - 8) * 0.22) continue;
      // Des bosquets, pas un semis régulier.
      if (fbm(x * 0.04 + 20, z * 0.04 + 20, 3) < 0.42 + random() * 0.14) continue;
      const height = 6 + random() * 9;
      dummy.position.set(x, groundHeight(x, z) - 0.3, z);
      dummy.rotation.set((random() - 0.5) * 0.06, random() * Math.PI, (random() - 0.5) * 0.06);
      dummy.scale.set(height * (0.8 + random() * 0.3), height, height * (0.8 + random() * 0.3));
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
  const glass = useMemo(() => new MeshStandardMaterial({ color: "#ffffff", roughness: 0.03, metalness: 1, transparent: true, opacity: 0.13, envMapIntensity: 1.3, depthWrite: false, side: DoubleSide }), []);
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
      <mesh geometry={sky.geometry} material={sky.material} scale={2500} frustumCulled={false} renderOrder={-10} />
      {panorama ? (
        <>
          <mesh geometry={layers.mid.geometry} material={layers.mid.material} frustumCulled={false} renderOrder={-9} />
          <mesh geometry={layers.near.geometry} material={layers.near.material} frustumCulled={false} renderOrder={-8} />
        </>
      ) : null}
      <mesh geometry={terrain} material={snowMaterial} renderOrder={-7} />
      <instancedMesh ref={firs} args={[fir.geometry, fir.material, firCount]} key={firCount} frustumCulled={false} />
      <Snow />
      <mesh geometry={gable} material={glass} position={[0, 0, ROOM.north + 0.13]} renderOrder={3} />
      {/* La fenêtre de la cuisine et celle de la chambre, dans leurs murs sud. */}
      <mesh material={glass} position={[(KITCHEN.window.x0 + KITCHEN.window.x1) / 2, (KITCHEN.window.y0 + KITCHEN.window.y1) / 2, ROOM.back + 0.02]} renderOrder={3}>
        <planeGeometry args={[KITCHEN.window.x1 - KITCHEN.window.x0, KITCHEN.window.y1 - KITCHEN.window.y0]} />
      </mesh>
      <mesh material={glass} position={[(BEDROOM_WINDOW.x0 + BEDROOM_WINDOW.x1) / 2, (BEDROOM_WINDOW.y0 + BEDROOM_WINDOW.y1) / 2, PLAN.bedroom.z1 - 0.01]} renderOrder={3}>
        <planeGeometry args={[BEDROOM_WINDOW.x1 - BEDROOM_WINDOW.x0, BEDROOM_WINDOW.y1 - BEDROOM_WINDOW.y0]} />
      </mesh>
      {WEST_WINDOWS.map((z) => (
        <mesh key={z} geometry={pane} material={glass} position={[-ROOM.halfW + 0.02, (WEST_WINDOW.sill + WEST_WINDOW.top) / 2, z]} rotation-y={Math.PI / 2} renderOrder={3} />
      ))}
    </group>
  );
}

/**
 * Le panorama est une image finie, faite pour être vue telle quelle ; ici elle traverse le mappage de
 * tons de la scène, qui l'assombrit. Ce gain le compense (réglé à l'œil, sur captures).
 */
const PANORAMA_GAIN = 1.6;
