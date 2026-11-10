import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, LinearFilter, MeshStandardMaterial, PlaneGeometry, RectAreaLight, Scene, ShaderMaterial, SRGBColorSpace, Mesh, Vector2, VideoTexture, type DepthTexture, type PerspectiveCamera } from "three";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { audio } from "../media/audio";
import { getVideo } from "../media/playback";
import { useProfile, useStore } from "../state/store";
import { effects, VIGNETTE } from "./Effects";
import { TV } from "./layout";

/**
 * L'image de la vidéo, cadrée dans l'écran 16:9 (bandes noires pour un film plus large ou plus
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
    gl_FragColor = vec4(color, alpha);
    #ifdef OVERLAY
      #include <colorspace_fragment>
    #endif
  }
`;

/** Lissage de la couleur d'ambiance, par seconde. */
const AMBILIGHT_RATE = 3.2;
const AMBILIGHT_EVERY_MS = 200;
const SAMPLE = 8;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * La télévision : sa dalle, son cadre, son haut-parleur, et la lumière qu'elle jette dans la pièce.
 *
 * **Éteinte**, la dalle est un noir brillant où la pièce se reflète.
 *
 * **Allumée**, elle porte la vidéo. Le post-traitement mappe les tons de toute l'image, vidéo
 * comprise (`toneMapped={false}` ne vaut que pour un rendu direct à l'écran) : un film y perdrait
 * ses couleurs. La vidéo est donc redessinée après le compositeur, intacte, par une passe qui relit
 * la profondeur de la scène pour rester derrière ce qui la cache. La version qui traverse le
 * compositeur n'apporte que son halo.
 *
 * **L'ambilight** : la couleur moyenne de l'image, relevée cinq fois par seconde sur un canevas de
 * 8 × 8 pixels, éclaire la pièce par une lumière rectangulaire posée sur l'écran, lissée dans le temps.
 */
export function Television() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const profile = useProfile();
  const status = useStore((s) => s.playback.status);
  const video = getVideo();
  const screen = useRef<Mesh>(null);
  const light = useRef<RectAreaLight>(null);
  const on = useRef(0);
  const glow = useRef({ target: new Color(0, 0, 0), current: new Color(0, 0, 0), level: 0, last: 0 });

  const { texture, sceneMaterial, overlay, off, bezel, sampler } = useMemo(() => {
    RectAreaLightUniformsLib.init();
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    const uniforms = () => ({ uVideo: { value: texture }, uFit: { value: new Vector2(1, 1) }, uOn: { value: 0 }, uGain: { value: 1 } });
    // Dans la scène : au-dessus de 1, pour que les images claires débordent un peu en halo.
    const sceneMaterial = new ShaderMaterial({ vertexShader: SCREEN_VERTEX, fragmentShader: SCREEN_FRAGMENT, uniforms: { ...uniforms(), uGain: { value: 1.35 } }, toneMapped: false });
    const overlayMaterial = new ShaderMaterial({
      vertexShader: SCREEN_VERTEX,
      fragmentShader: SCREEN_FRAGMENT,
      defines: { OVERLAY: "" },
      uniforms: { ...uniforms(), uDepth: { value: null }, uResolution: { value: new Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 100 }, uVignette: { value: new Vector2(VIGNETTE.offset, VIGNETTE.darkness) } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const overlayScene = new Scene();
    const overlayMesh = new Mesh(new PlaneGeometry(TV.width, TV.height), overlayMaterial);
    overlayMesh.matrixAutoUpdate = false;
    overlayMesh.frustumCulled = false;
    overlayScene.add(overlayMesh);
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    return {
      texture,
      sceneMaterial,
      overlay: { scene: overlayScene, mesh: overlayMesh, material: overlayMaterial },
      off: new MeshStandardMaterial({ color: "#010101", roughness: 0.05, metalness: 0, envMapIntensity: 3 }),
      bezel: new MeshStandardMaterial({ color: "#0b0b0c", roughness: 0.45, metalness: 0.7 }),
      sampler: { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) },
    };
  }, [video]);

  useEffect(
    () => () => {
      texture.dispose();
      sceneMaterial.dispose();
      overlay.material.dispose();
      overlay.mesh.geometry.dispose();
      off.dispose();
      bezel.dispose();
    },
    [texture, sceneMaterial, overlay, off, bezel]
  );

  const speaker = useMemo(() => audio().tv, []);

  // Après le compositeur (priorité 1) : la vidéo, telle quelle.
  useFrame((_, delta) => {
    const mesh = screen.current;
    if (!mesh) return;
    const playing = (status === "playing" || status === "paused") && video.readyState >= 2 && video.videoWidth > 0;
    // L'écran s'allume et s'éteint en fondu.
    on.current += ((playing ? 1 : 0) - on.current) * (1 - Math.exp(-delta * 5));
    if (on.current < 0.002) on.current = 0;
    const lit = on.current > 0;
    mesh.material = lit ? sceneMaterial : off;

    if (lit) {
      // Le cadrage : l'image entière dans la dalle, des bandes noires pour le reste.
      const ratio = video.videoWidth / video.videoHeight / (TV.width / TV.height);
      const fit = ratio >= 1 ? [1, ratio] : [1 / ratio, 1];
      for (const material of [sceneMaterial, overlay.material]) {
        material.uniforms.uFit.value.set(fit[0], fit[1]);
        material.uniforms.uOn.value = on.current;
      }
    }

    // ── L'ambilight ──────────────────────────────────────────────────────────
    const g = glow.current;
    const now = performance.now();
    if (playing && sampler.context && now - g.last > AMBILIGHT_EVERY_MS) {
      g.last = now;
      try {
        sampler.context.drawImage(video, 0, 0, SAMPLE, SAMPLE);
        const pixels = sampler.context.getImageData(0, 0, SAMPLE, SAMPLE).data;
        let r = 0;
        let gr = 0;
        let b = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          r += srgbToLinear(pixels[i] / 255);
          gr += srgbToLinear(pixels[i + 1] / 255);
          b += srgbToLinear(pixels[i + 2] / 255);
        }
        const n = pixels.length / 4;
        g.target.setRGB(r / n, gr / n, b / n);
      } catch {
        // Image illisible (source d'une autre origine) : pas d'ambiance, la lecture continue.
        g.target.setRGB(0, 0, 0);
      }
    }
    if (!playing) g.target.setRGB(0, 0, 0);
    g.current.lerp(g.target, 1 - Math.exp(-delta * AMBILIGHT_RATE));
    if (light.current) {
      const peak = Math.max(g.current.r, g.current.g, g.current.b);
      // La couleur donne la teinte, la luminance donne la force : une scène sombre éclaire peu.
      light.current.color.copy(g.current).multiplyScalar(peak > 0.0001 ? 1 / peak : 0);
      light.current.intensity = peak * 14 * on.current;
    }

    // ── La passe de la vidéo, par-dessus le compositeur ──────────────────────
    const composer = effects.composer;
    if (!lit || !composer) return;
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
    mesh.updateWorldMatrix(true, false);
    // Dans sa propre scène, la dalle de la passe prend la place exacte de l'écran : sa matrice locale
    // est celle de l'écran dans le monde (three recalcule la matrice monde à partir d'elle au rendu).
    overlay.mesh.matrix.copy(mesh.matrixWorld);
    overlay.mesh.matrixWorldNeedsUpdate = true;
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    gl.render(overlay.scene, camera);
    gl.autoClear = autoClear;
  }, 2);

  return (
    <group position={[TV.x, TV.y, TV.z]} rotation-y={-Math.PI / 2} name="tv">
      <mesh ref={screen} name="tv-screen" material={off}>
        <planeGeometry args={[TV.width, TV.height]} />
      </mesh>
      {/* Le cadre : quatre baguettes noires autour de la dalle. */}
      {[
        [0, TV.height / 2 + 0.014, TV.width + 0.056, 0.028],
        [0, -TV.height / 2 - 0.014, TV.width + 0.056, 0.028],
        [TV.width / 2 + 0.014, 0, 0.028, TV.height],
        [-TV.width / 2 - 0.014, 0, 0.028, TV.height],
      ].map(([x, y, w, h], i) => (
        <mesh key={i} position={[x, y, 0.012]} material={bezel}>
          <boxGeometry args={[w, h, 0.05]} />
        </mesh>
      ))}
      {/* La lumière de l'écran : elle rayonne vers la pièce (l'axe −Z d'une lumière rectangulaire). */}
      {profile.fillLights ? <rectAreaLight ref={light} args={["#000000", 0, TV.width * 0.92, TV.height * 0.92]} position={[0, 0, 0.06]} rotation-y={Math.PI} /> : null}
      <primitive object={speaker} position={[0, 0, 0.05]} />
    </group>
  );
}
