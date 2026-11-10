import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, Frustum, Group, LinearFilter, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, RectAreaLight, Scene, ShaderMaterial, Sphere, SRGBColorSpace, Vector2, Vector3, VideoTexture, type DepthTexture, type PerspectiveCamera } from "three";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { speaker } from "../media/audio";
import { getVideo } from "../media/playback";
import { useProfile, useStore } from "../state/store";
import { effects, VIGNETTE } from "./Effects";
import { roomAt, screenHeight, SCREENS } from "./layout";
import { rig } from "./rig";

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
 * **L'ambilight** : la couleur moyenne de l'image, relevée cinq fois par seconde sur un canevas de
 * 8 × 8 pixels, éclaire la pièce — par **une** lumière rectangulaire, posée sur l'écran de la pièce
 * où se tient le visiteur (les autres écrans éclairent des pièces qu'il ne voit pas). Rien n'est
 * relevé quand aucun écran n'éclaire la pièce où il est.
 */
export function Screens() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const profile = useProfile();
  const status = useStore((s) => s.playback.status);
  const video = getVideo();
  const groups = useRef<(Group | null)[]>([]);
  const meshes = useRef<(Mesh | null)[]>([]);
  const light = useRef<RectAreaLight>(null);
  const on = useRef(0);
  const glow = useRef({ target: new Color(0, 0, 0), current: new Color(0, 0, 0), last: 0 });

  const { texture, sceneMaterial, overlay, off, bezel, sampler, speakers } = useMemo(() => {
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
    // La passe de la vidéo a sa propre scène : une dalle par écran, à la place exacte de l'écran.
    const overlayScene = new Scene();
    const overlayMeshes = SCREENS.map((screen) => {
      const mesh = new Mesh(new PlaneGeometry(screen.width, screenHeight(screen)), overlayMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      overlayScene.add(mesh);
      return mesh;
    });
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    return {
      texture,
      sceneMaterial,
      overlay: { scene: overlayScene, meshes: overlayMeshes, material: overlayMaterial },
      off: new MeshStandardMaterial({ color: "#010101", roughness: 0.05, metalness: 0, envMapIntensity: 3 }),
      bezel: new MeshStandardMaterial({ color: "#0b0b0c", roughness: 0.45, metalness: 0.7 }),
      sampler: { context: canvas.getContext("2d", { willReadFrequently: true }) },
      speakers: SCREENS.map((screen) => speaker(screen.id, screen.loudness)),
    };
  }, [video]);

  useEffect(
    () => () => {
      texture.dispose();
      sceneMaterial.dispose();
      overlay.material.dispose();
      for (const mesh of overlay.meshes) mesh.geometry.dispose();
      off.dispose();
      bezel.dispose();
    },
    [texture, sceneMaterial, overlay, off, bezel]
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

    // ── L'ambilight : l'écran de la pièce où se tient le visiteur ─────────────
    const here = roomAt(rig.position.x, rig.position.y, rig.position.z);
    const lamp = SCREENS.find((screen) => screen.room === here) ?? (here === "mezzanine" ? SCREENS[0] : null);
    const g = glow.current;
    const now = performance.now();
    if (playing && lamp && light.current && sampler.context && now - g.last > AMBILIGHT_EVERY_MS) {
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
    if (!playing || !lamp) g.target.setRGB(0, 0, 0);
    g.current.lerp(g.target, 1 - Math.exp(-delta * AMBILIGHT_RATE));
    if (light.current) {
      if (lamp) {
        // La lumière se pose sur l'écran de la pièce, à sa taille, tournée vers la pièce (l'axe −Z d'une lumière rectangulaire).
        light.current.position.set(lamp.center[0] + Math.sin(lamp.yaw) * 0.06, lamp.center[1], lamp.center[2] + Math.cos(lamp.yaw) * 0.06);
        light.current.rotation.set(0, lamp.yaw + Math.PI, 0);
        light.current.width = lamp.width * 0.92;
        light.current.height = screenHeight(lamp) * 0.92;
      }
      const peak = Math.max(g.current.r, g.current.g, g.current.b);
      // La couleur donne la teinte, la luminance donne la force : une scène sombre éclaire peu.
      light.current.color.copy(g.current).multiplyScalar(peak > 0.0001 ? 1 / peak : 0);
      light.current.intensity = peak * 14 * on.current;
    }

    // ── La passe de la vidéo, par-dessus le compositeur ──────────────────────
    const composer = effects.composer;
    if (!anyVisible || !composer) return;
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
      {/* Une seule lumière d'écran pour tout le chalet : elle suit le visiteur de pièce en pièce. */}
      {profile.fillLights ? <rectAreaLight ref={light} args={["#000000", 0, 1, 1]} /> : null}
    </group>
  );
}

/** Pour les tests : la position d'un écran dans l'espace, telle que la scène la tient. */
export function screenCenter(id: string): Vector3 | null {
  const screen = SCREENS.find((s) => s.id === id);
  return screen ? new Vector3(...screen.center) : null;
}
