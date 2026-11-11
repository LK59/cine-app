import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Camera, CanvasTexture, Color, Frustum, Group, LinearFilter, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial, Sphere, SRGBColorSpace, UnsignedByteType, Vector2, Vector3, VideoTexture, WebGLRenderTarget, type DepthTexture, type PerspectiveCamera } from "three";
import { perf } from "../lib/perf";
import { cueAt, drawCue, SUBTITLE_SIZE } from "../media/subtitles";
import { speaker } from "../media/audio";
import { getVideo } from "../media/playback";
import { useStore } from "../state/store";
import { effects, VIGNETTE } from "./Effects";
import { screenHeight, SCREENS } from "./layout";
import { applyScreenLight, screenLight, ZONES_X, ZONES_Y } from "./screenLight";

/**
 * L'image de la vidéo, cadrée dans une dalle 16:9 (bandes noires pour un film plus large ou plus
 * étroit). Deux emplois du même programme :
 * - dans la scène (`OVERLAY` absent) : l'écran tel que le reste de l'image le voit — il passera par
 *   le mappage de tons, et sa lumière nourrit le halo ;
 * - par-dessus le compositeur (`OVERLAY`) : la vidéo redessinée **telle quelle**, dans l'espace de
 *   couleur de l'écran, là où rien ne la cache.
 */
const SCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SCREEN_FRAGMENT = /* glsl */ `
  uniform sampler2D uVideo;
  uniform sampler2D uSub;
  uniform float uSubOn;
  uniform vec2 uFit;
  uniform float uOn;
  uniform float uGain;
  varying vec2 vUv;
  #ifdef OVERLAY
    #include <packing>
    uniform sampler2D uDepth;
    uniform vec2 uResolution;
    uniform float uNear;
    uniform float uFar;
    uniform vec2 uVignette;
  #endif
  void main() {
    vec2 uv = (vUv - 0.5) * uFit + 0.5;
    vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    vec3 color = texture2D(uVideo, uv).rgb * inside.x * inside.y * uGain;
    // Les sous-titres : un bandeau posé au bas de la dalle (pas de l'image — sous un film large, ils
    // tombent en partie dans la bande noire, comme sur une télévision).
    if (uSubOn > 0.5 && vUv.y < SUB_BAND) {
      vec4 sub = texture2D(uSub, vec2(vUv.x, vUv.y / SUB_BAND));
      color = mix(color, sub.rgb * uGain, sub.a);
    }
    float alpha = uOn;
    #ifdef OVERLAY
      // Ce qui est devant l'écran dans la scène (un lustre, un dossier) le cache ici aussi : la
      // profondeur de la scène est relue, et comparée en mètres.
      vec2 screenUv = gl_FragCoord.xy / uResolution;
      float sceneZ = -perspectiveDepthToViewZ(texture2D(uDepth, screenUv).r, uNear, uFar);
      float ownZ = -perspectiveDepthToViewZ(gl_FragCoord.z, uNear, uFar);
      if (ownZ > sceneZ + 0.03) discard;
      // Le bord de la dalle, adouci sur un pixel : cette passe n'a pas d'anticrénelage.
      vec2 edge = min(vUv, 1.0 - vUv) / max(fwidth(vUv), vec2(1e-6));
      alpha *= clamp(min(edge.x, edge.y), 0.0, 1.0);
      // La vignette du post-traitement, que cette passe contourne.
      float d = distance(screenUv, vec2(0.5));
      color *= smoothstep(0.8, uVignette.x * 0.799, d * (uVignette.y + uVignette.x));
    #endif
    // Pas de conversion vers l'espace de l'écran dans la passe finale : l'image de la vidéo y est déjà (le
    // navigateur la donne codée sRGB, telle qu'un écran l'attend). Elle y était convertie une seconde fois —
    // un gris moyen de 128 sortait à 187, un noir de 40 à 110 : des films délavés, aux noirs gris (constaté
    // par le propriétaire sur des films HDR, vérifié sur des aplats connus : tests/couleur.mjs).
    gl_FragColor = vec4(color, alpha);
  }
`;

/** Lissage des couleurs d'ambiance, par seconde. */
const AMBILIGHT_RATE = 4.5;
/** La copie réduite de l'image : relue quinze fois par seconde (les reflets flous, les zones). */
const SAMPLE_EVERY_MS = 66;
const SAMPLE_W = 48;
const SAMPLE_H = 27;
/** La part de la hauteur de la dalle où se posent les sous-titres (le canevas y est étiré). */
const SUB_BAND = "0.3";

/**
 * La copie réduite de l'image vidéo — les reflets flous et la couleur de chaque zone d'ambiance.
 *
 * Elle est faite **par la carte graphique**, dans une petite cible de rendu, et ses octets sont relus sans
 * attendre (`readRenderTargetPixelsAsync`). Elle passait par un canevas 2D (`drawImage` de la vidéo puis
 * `getImageData`) : pour une image décodée par la carte graphique, le navigateur doit alors la rapatrier
 * en mémoire, quinze fois par seconde, et tout le rendu attend. Mesuré le 11/11/2026 sur une puce graphique
 * intégrée : 56 images par seconde écrans éteints, 21 avec vidéo, à tous les préréglages — un coût fixe par
 * image, indépendant de la qualité.
 *
 * Les valeurs restent codées sRGB, comme le navigateur donne la vidéo : c'est `screenLight` qui les décode,
 * et `zoneColors` pour les zones.
 */
const SAMPLE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const SAMPLE_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uVideo;
  uniform vec2 uTexel;
  void main() {
    // Seize lectures par point : chacune moyenne déjà quatre points de l'image (filtrage linéaire).
    vec3 sum = vec3(0.0);
    for (int y = 0; y < 4; y++) {
      for (int x = 0; x < 4; x++) {
        vec2 offset = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
        sum += texture2D(uVideo, vUv + offset * uTexel).rgb;
      }
    }
    gl_FragColor = vec4(sum / 16.0, 1.0);
  }
`;

/** La couleur moyenne de chaque zone, en linéaire. Les lignes relues vont de bas en haut ; les zones, de haut en bas. */
function zoneColors(pixels: Uint8Array, target: Color[]): void {
  const zoneW = SAMPLE_W / ZONES_X;
  const zoneH = SAMPLE_H / ZONES_Y;
  for (let zy = 0; zy < ZONES_Y; zy++) {
    for (let zx = 0; zx < ZONES_X; zx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = Math.floor(zy * zoneH); y < Math.floor((zy + 1) * zoneH); y++) {
        for (let x = Math.floor(zx * zoneW); x < Math.floor((zx + 1) * zoneW); x++) {
          const i = ((SAMPLE_H - 1 - y) * SAMPLE_W + x) * 4;
          r += srgbToLinear(pixels[i] / 255);
          g += srgbToLinear(pixels[i + 1] / 255);
          b += srgbToLinear(pixels[i + 2] / 255);
          n += 1;
        }
      }
      target[zy * ZONES_X + zx].setRGB(r / n, g / n, b / n);
    }
  }
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const frustum = new Frustum();
const projection = new Matrix4();
const sphere = new Sphere();

/**
 * Les télévisions du chalet. **Un seul flux, une seule texture** : toutes les dalles montrent la même
 * image, au même instant — rien n'est décodé ni demandé au serveur en plus pour un écran de plus.
 *
 * **Éteinte**, une dalle est un noir brillant où la pièce se reflète.
 *
 * **Allumée**, elle porte la vidéo. Le post-traitement mappe les tons de toute l'image, vidéo
 * comprise (`toneMapped={false}` ne vaut que pour un rendu direct à l'écran) : un film y perdrait
 * ses couleurs. La vidéo est donc redessinée après le compositeur, intacte, par une passe qui relit
 * la profondeur de la scène pour rester derrière ce qui la cache. La version qui traverse le
 * compositeur n'apporte que son halo. Une dalle hors du champ n'est pas redessinée.
 *
 * **La lumière des écrans** — l'ambilight par zones et le reflet du film — est dans `screenLight.ts`,
 * greffée sur toutes les matières. Ici, on la nourrit : une copie réduite de l'image (48 × 27), relue
 * quinze fois par seconde, sert de version floue pour les reflets et donne la couleur de chaque zone.
 */
export function Screens() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const status = useStore((s) => s.playback.status);
  const video = getVideo();
  const groups = useRef<(Group | null)[]>([]);
  const meshes = useRef<(Mesh | null)[]>([]);
  const on = useRef(0);
  const subtitleShown = useRef("");
  const zones = useRef({ target: Array.from({ length: ZONES_X * ZONES_Y }, () => new Color(0, 0, 0)), last: 0, reading: false, pixels: new Uint8Array(SAMPLE_W * SAMPLE_H * 4) });

  const { texture, sceneMaterial, overlay, off, bezel, sampler, subtitles, speakers } = useMemo(() => {
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    const subCanvas = document.createElement("canvas");
    subCanvas.width = SUBTITLE_SIZE.width;
    subCanvas.height = SUBTITLE_SIZE.height;
    const subs = new CanvasTexture(subCanvas);
    subs.minFilter = LinearFilter;
    subs.magFilter = LinearFilter;
    subs.generateMipmaps = false;
    const subOn = { value: 0 };
    const uniforms = () => ({ uVideo: { value: texture }, uSub: { value: subs }, uSubOn: subOn, uFit: { value: new Vector2(1, 1) }, uOn: { value: 0 }, uGain: { value: 1 } });
    // Dans la scène : au-dessus de 1, pour que les images claires débordent un peu en halo.
    const sceneMaterial = new ShaderMaterial({ defines: { SUB_BAND }, vertexShader: SCREEN_VERTEX, fragmentShader: SCREEN_FRAGMENT, uniforms: { ...uniforms(), uGain: { value: 1.35 } }, toneMapped: false });
    const overlayMaterial = new ShaderMaterial({
      vertexShader: SCREEN_VERTEX,
      fragmentShader: SCREEN_FRAGMENT,
      defines: { OVERLAY: "", SUB_BAND },
      uniforms: { ...uniforms(), uDepth: { value: null }, uResolution: { value: new Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 100 }, uVignette: { value: new Vector2(VIGNETTE.offset, VIGNETTE.darkness) } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    // La passe de la vidéo a sa propre scène : une dalle par écran, à la place exacte de l'écran.
    const overlayScene = new Scene();
    const overlayMeshes = SCREENS.map((screen) => {
      const mesh = new Mesh(new PlaneGeometry(screen.width, screenHeight(screen)), overlayMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      overlayScene.add(mesh);
      return mesh;
    });
    // La copie réduite de l'image, faite par la carte graphique (voir `SAMPLE_FRAGMENT`).
    const target = new WebGLRenderTarget(SAMPLE_W, SAMPLE_H, { format: RGBAFormat, type: UnsignedByteType, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
    const sampleMaterial = new ShaderMaterial({
      vertexShader: SAMPLE_VERTEX,
      fragmentShader: SAMPLE_FRAGMENT,
      uniforms: { uVideo: { value: texture }, uTexel: { value: new Vector2(1 / SAMPLE_W, 1 / SAMPLE_H) } },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sampleScene = new Scene();
    const sampleMesh = new Mesh(new PlaneGeometry(2, 2), sampleMaterial);
    sampleMesh.frustumCulled = false;
    sampleScene.add(sampleMesh);
    screenLight.uniforms.uSlVideo.value = texture;
    screenLight.uniforms.uSlBlur.value = target.texture;
    // Une dalle éteinte ne renvoie presque rien des lampes : sans cela, le lustre y posait un disque éblouissant.
    const off = new MeshStandardMaterial({ color: "#010101", roughness: 0.22, metalness: 0, envMapIntensity: 0.7 });
    off.onBeforeCompile = (shader) => {
      applyScreenLight(shader);
      shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directSpecular *= 0.05;");
    };
    off.customProgramCacheKey = () => "dalle-eteinte";
    return {
      texture,
      sceneMaterial,
      overlay: { scene: overlayScene, meshes: overlayMeshes, material: overlayMaterial },
      // Une dalle éteinte : noire, à peine brillante. À 3 de reflet et presque sans rugosité c'était un miroir.
      off,
      bezel: new MeshStandardMaterial({ color: "#0b0b0c", roughness: 0.45, metalness: 0.7 }),
      sampler: { target, scene: sampleScene, camera: new Camera(), material: sampleMaterial, mesh: sampleMesh },
      subtitles: { texture: subs, context: subCanvas.getContext("2d"), on: subOn },
      speakers: SCREENS.map((screen) => speaker(screen.id, screen.loudness)),
    };
  }, [video]);

  useEffect(
    () => () => {
      texture.dispose();
      sampler.target.dispose();
      subtitles.texture.dispose();
      sampler.material.dispose();
      sampler.mesh.geometry.dispose();
      screenLight.uniforms.uSlBlur.value = null;
      screenLight.uniforms.uSlOn.value = 0;
      sceneMaterial.dispose();
      overlay.material.dispose();
      for (const mesh of overlay.meshes) mesh.geometry.dispose();
      off.dispose();
      bezel.dispose();
    },
    [texture, sceneMaterial, overlay, off, bezel, sampler, subtitles]
  );

  // Après le compositeur (priorité 1) : la vidéo, telle quelle.
  useFrame((_, delta) => {
    const playing = (status === "playing" || status === "paused") && video.readyState >= 2 && video.videoWidth > 0;
    // Les écrans s'allument et s'éteignent en fondu.
    on.current += ((playing ? 1 : 0) - on.current) * (1 - Math.exp(-delta * 5));
    if (on.current < 0.002) on.current = 0;
    const lit = on.current > 0;

    if (lit) {
      // Le cadrage : l'image entière dans la dalle, des bandes noires pour le reste.
      const ratio = video.videoWidth / video.videoHeight / (16 / 9);
      const fit = ratio >= 1 ? [1, ratio] : [1 / ratio, 1];
      for (const material of [sceneMaterial, overlay.material]) {
        material.uniforms.uFit.value.set(fit[0], fit[1]);
        material.uniforms.uOn.value = on.current;
      }
      screenLight.uniforms.uSlFit.value.set(fit[0], fit[1]);
    }
    screenLight.uniforms.uSlOn.value = perf.screenLight ? on.current : 0;

    // La réplique du moment : redessinée seulement quand elle change.
    const line = playing ? cueAt(video.currentTime) : "";
    if (line !== subtitleShown.current && subtitles.context) {
      subtitleShown.current = line;
      drawCue(subtitles.context, line);
      subtitles.texture.needsUpdate = true;
      subtitles.on.value = line ? 1 : 0;
    }

    // Quels écrans sont dans le champ ? Les autres ne sont pas redessinés.
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projection);
    let anyVisible = false;
    SCREENS.forEach((screen, i) => {
      const mesh = meshes.current[i];
      if (!mesh) return;
      mesh.material = lit ? sceneMaterial : off;
      sphere.center.set(...screen.center);
      sphere.radius = screen.width * 0.6;
      const visible = lit && frustum.intersectsSphere(sphere);
      overlay.meshes[i].visible = visible;
      if (visible) {
        anyVisible = true;
        mesh.updateWorldMatrix(true, false);
        // Dans sa propre scène, la dalle de la passe prend la place exacte de l'écran : sa matrice locale
        // est celle de l'écran dans le monde (three recalcule la matrice monde à partir d'elle au rendu).
        overlay.meshes[i].matrix.copy(mesh.matrixWorld);
        overlay.meshes[i].matrixWorldNeedsUpdate = true;
      }
    });

    // ── La copie réduite de l'image : les reflets flous, et la couleur de chaque zone ──
    const z = zones.current;
    const now = performance.now();
    if (playing && perf.sample && now - z.last > SAMPLE_EVERY_MS) {
      z.last = now;
      const previous = gl.getRenderTarget();
      gl.setRenderTarget(sampler.target);
      gl.render(sampler.scene, sampler.camera);
      gl.setRenderTarget(previous);
      // La lecture des couleurs ne bloque rien : la carte graphique rend les octets quand elle les a
      // (une à deux images plus tard), et une seule lecture est en route à la fois.
      if (!z.reading) {
        z.reading = true;
        gl.readRenderTargetPixelsAsync(sampler.target, 0, 0, SAMPLE_W, SAMPLE_H, z.pixels)
          .then(() => zoneColors(z.pixels, z.target))
          // Lecture refusée : pas d'ambiance, la lecture du film continue.
          .catch(() => z.target.forEach((color) => color.setRGB(0, 0, 0)))
          .finally(() => {
            z.reading = false;
          });
      }
    }
    if (!playing) for (const color of z.target) color.setRGB(0, 0, 0);
    const ease = 1 - Math.exp(-delta * AMBILIGHT_RATE);
    screenLight.uniforms.uSlZones.value.forEach((color, i) => color.lerp(z.target[i], ease));

    // ── La passe de la vidéo, par-dessus le compositeur ──────────────────────
    const composer = effects.composer;
    if (!anyVisible || !composer || !perf.overlay) return;
    // La profondeur de la scène. Le compositeur n'en garde une copie stable (recopiée après le rendu
    // de la scène) que si un effet la demande ; on la lui fait donc créer. Ces deux membres sont
    // internes à la bibliothèque — d'où la forme, et l'épinglage exact de sa version.
    const internals = composer as unknown as { depthRenderTarget: { depthTexture: DepthTexture } | null; createDepthTexture(): void };
    if (!internals.depthRenderTarget) internals.createDepthTexture();
    const depth = internals.depthRenderTarget?.depthTexture ?? null;
    if (!depth) return;
    const uniforms = overlay.material.uniforms;
    uniforms.uDepth.value = depth;
    gl.getDrawingBufferSize(uniforms.uResolution.value);
    uniforms.uNear.value = camera.near;
    uniforms.uFar.value = camera.far;
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    gl.render(overlay.scene, camera);
    gl.autoClear = autoClear;
  }, 2);

  return (
    <group name="screens">
      {SCREENS.map((screen, i) => {
        const h = screenHeight(screen);
        const frame = Math.max(0.012, screen.width * 0.006);
        // Le salon a sa dalle encastrée dans la pierre ; les autres sont des téléviseurs accrochés, avec leur coque.
        const hung = screen.id !== "salon";
        return (
          <group key={screen.id} ref={(node) => void (groups.current[i] = node)} position={screen.center} rotation-y={screen.yaw} name={`screen-${screen.id}`}>
            <mesh ref={(node) => void (meshes.current[i] = node)} material={off}>
              <planeGeometry args={[screen.width, h]} />
            </mesh>
            {[
              [0, h / 2 + frame / 2, screen.width + frame * 2, frame],
              [0, -h / 2 - frame / 2, screen.width + frame * 2, frame],
              [screen.width / 2 + frame / 2, 0, frame, h],
              [-screen.width / 2 - frame / 2, 0, frame, h],
            ].map(([x, y, w, hh], k) => (
              <mesh key={k} position={[x, y, 0.006]} material={bezel}>
                <boxGeometry args={[w, hh, 0.03]} />
              </mesh>
            ))}
            {hung ? (
              <mesh position={[0, 0, -0.018]} material={bezel}>
                <boxGeometry args={[screen.width + frame * 2, h + frame * 2, 0.03]} />
              </mesh>
            ) : null}
            <primitive object={speakers[i]} position={[0, 0, 0.05]} />
          </group>
        );
      })}
    </group>
  );
}

/** Pour les tests : la position d'un écran dans l'espace, telle que la scène la tient. */
export function screenCenter(id: string): Vector3 | null {
  const screen = SCREENS.find((s) => s.id === id);
  return screen ? new Vector3(...screen.center) : null;
}
