// Les classes des décodeurs que mediabunny se fait enregistrer — essai du 19/11/2026.
//
// @mediabunny/ac3 et @mediabunny/dts n'exportent pas leurs décodeurs : seulement une fonction qui
// les enregistre auprès de mediabunny, lequel les retrouve ensuite par `supports(codec)` quand SON
// lecteur de conteneur décode. Pour leur passer NOS paquets (audioDemux.ts), il faut la classe.
//
// `registerDecoder` vérifie la classe par `decoder.prototype instanceof CustomAudioDecoder` — une
// vérification qui passe par `CustomAudioDecoder[Symbol.hasInstance]`. On y pose, le temps d'un
// enregistrement, un relais qui note la classe et répond comme le ferait `instanceof`. Rien d'autre
// ne change : mediabunny l'enregistre comme avant, et son propre chemin reste intact.
//
// Limite connue : l'enregistrement n'a lieu qu'une fois par page (chaque extension garde un drapeau).
// Tout enregistrement doit donc passer par `registerCapturing`, sinon la classe n'est jamais vue —
// `decoderClassFor` rend alors `null`, et l'appelant retombe sur le chemin de mediabunny.

type Core = typeof import("mediabunny");
type AudioDecoderClass = Core["CustomAudioDecoder"] & { supports(codec: string, config: unknown): boolean };

const captured: AudioDecoderClass[] = [];

/** Enregistre par `register` (l'appel de l'extension), en notant au passage la classe enregistrée. */
export function registerCapturing(core: Core, register: () => void): void {
  // Une capture qui échouerait ne doit jamais empêcher l'enregistrement lui-même : sans la classe de
  // base (un mediabunny factice des tests, une version qui la renommerait), on enregistre seulement.
  let base: Record<symbol, unknown> | undefined;
  try {
    base = core.CustomAudioDecoder as unknown as Record<symbol, unknown> | undefined;
  } catch {
    base = undefined;
  }
  if (typeof base !== "function") {
    register();
    return;
  }
  const own = Object.getOwnPropertyDescriptor(base, Symbol.hasInstance);
  Object.defineProperty(base, Symbol.hasInstance, {
    configurable: true,
    value(this: unknown, candidate: unknown) {
      const result = Function.prototype[Symbol.hasInstance].call(this, candidate);
      const ctor = (candidate as { constructor?: unknown } | null)?.constructor as AudioDecoderClass | undefined;
      if (result && typeof ctor === "function" && !captured.includes(ctor)) captured.push(ctor);
      return result;
    },
  });
  try {
    register();
  } finally {
    if (own) Object.defineProperty(base, Symbol.hasInstance, own);
    else delete base[Symbol.hasInstance];
  }
}

/** La classe notée qui accepte ce codec (au sens de mediabunny : "ac3", "eac3", "dts", "flac"…). */
export function decoderClassFor(codec: string, config: unknown): AudioDecoderClass | null {
  return captured.find((c) => c.supports(codec, config)) ?? null;
}
