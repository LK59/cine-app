/**
 * Ce navigateur prend-il un AAC à PCE tel quel dans MediaSource ? Demandé une fois, par un vrai
 * envoi, la réponse gardée — DECISIONS.md §62, couche 4.
 *
 * `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')` ne répond pas à cette question : Chromium dit
 * oui et refuse le segment d'initialisation qui porte un PCE (« Elle s'appelle Ruby » sur une Fire
 * TV, 10/10/2026). La seule réponse vraie est un envoi : un segment d'initialisation audio portant
 * le PCE de Ruby, puis une trame AAC silencieuse au même PCE, et la plage tamponnée qui en résulte.
 * Accepté (Safari, peut-être), la piste se copie avec tous ses canaux, sans perte ; refusé ou
 * inconnu, elle se décode (voir `aacPlan`).
 *
 * Jamais sur le chemin d'une ouverture : la réponse se lit dans `localStorage`, et la question ne se
 * pose qu'en tâche de fond (`primePceProbe`) quand une piste à PCE se présente sans réponse connue
 * — cette ouverture-là prend le chemin sûr, les suivantes la réponse. Tout ici est gardé : une
 * sonde qui échoue ne répond rien, elle ne lève jamais.
 */
import { audioSampleEntryFor } from "./mp4SampleEntries";
import { initSegment, mediaSegment, type MuxTrackInfo } from "./mp4Muxer";
import { sourceConstructor } from "./mseSupport";
import { isChromiumEngine } from "./bufferBudget";

/**
 * Le PCE de « Ruby » à 48 kHz, tel que l'encodeur de FFmpeg l'écrit pour un 5.1 (`-aac_pce 1`) :
 * avant [paire, mono], côté [mono], arrière [paire]. Et une trame AAC silencieuse encodée avec ce
 * même PCE (FFmpeg 7, `anullsrc=r=48000:cl=5.1`, 192 kbit/s), sans son en-tête ADTS.
 */
export const PROBE_ASC = Uint8Array.from([
  0x11, 0x80, 0x04, 0xc8, 0x44, 0x00, 0x20, 0x00, 0xc4, 0x0d, 0x4c, 0x61, 0x76, 0x63, 0x36, 0x32, 0x2e, 0x32, 0x38, 0x2e, 0x31,
  0x30, 0x33, 0x56, 0xe5, 0x00,
]);
export const PROBE_FRAME = Uint8Array.from([
  0x21, 0x10, 0x04, 0x60, 0x8c, 0x00, 0x23, 0x04, 0x00, 0x03, 0x18, 0x20, 0x01, 0x18, 0x80, 0x23, 0x04, 0x60, 0xe0,
]);

const STORAGE_KEY = "cine-aac-pce-mse:v1";
const PROBE_TIMEOUT_MS = 1500;

/** La réponse gardée pour ce navigateur, ou `null` si la question n'a jamais été posée ici. */
export function pceCopyAccepted(): boolean | null {
  try {
    if (typeof localStorage === "undefined" || typeof navigator === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { ua?: string; ok?: unknown };
    // Une réponse vaut pour ce navigateur, à cette version : une mise à jour peut la changer.
    if (stored.ua !== navigator.userAgent || typeof stored.ok !== "boolean") return null;
    return stored.ok;
  } catch {
    return null;
  }
}

/**
 * La réponse à suivre pour cette ouverture : la réponse gardée, sinon celle du moteur.
 *
 * Sans réponse gardée, Chromium (Chrome, Edge, Silk sur Fire TV) décode : son refus du PCE est
 * prouvé (« Elle s'appelle Ruby » sur une Fire TV, 10/10/2026). Tout autre moteur COPIE, comme
 * avant le 10/10 — c'était le comportement de toujours pour un AAC, validé à l'oreille, et le
 * « chemin sûr » du décodage ne l'est pas sur WebKit : le décodeur de Safari (CoreAudio) échoue sur
 * ce même PCE (« InternalAudioDecoderCocoa decoding failed », iPhone de Louis, 10/10/2026, 21:52),
 * ce qui envoyait au lecteur serveur un film que Safari aurait peut-être copié. Si la copie est
 * refusée à l'envoi, `takePceCopyRefusal` le retient et l'hôte reconstruit une fois en décodant.
 */
export function effectivePceAnswer(): boolean | null {
  const stored = pceCopyAccepted();
  if (stored !== null) return stored;
  try {
    if (typeof navigator === "undefined") return null;
    return isChromiumEngine(navigator.userAgent ?? "") ? null : true;
  } catch {
    return null;
  }
}

/** Un AAC à PCE est-il copié tel quel par le pipeline qui s'ouvre ? Posé par le remultiplexeur. */
let pceCopyInEffect = false;
/** La dernière décision AAC à PCE de ce navigateur, pour la ligne `start` du journal. */
let lastPceDecision: { plan: string; answer: boolean | null } | null = null;

export function notePceDecision(plan: "copy" | "rewrite" | "decode", copiedAsIs: boolean): void {
  lastPceDecision = { plan, answer: pceCopyAccepted() };
  if (copiedAsIs) pceCopyInEffect = true;
}

/** Ce qui est écrit sur la ligne `start` : le plan AAC à PCE retenu et la réponse gardée, ou rien. */
export function pceDecisionFacts(): Record<string, unknown> {
  if (!lastPceDecision) return {};
  return { aacPcePlan: lastPceDecision.plan, aacPceAnswer: lastPceDecision.answer ?? "inconnue" };
}

/**
 * La copie d'un PCE vient d'être refusée par le navigateur avant la première image : vrai une seule
 * fois — la réponse est gardée (`false`), et la reconstruction qui suit décode. Faux sinon.
 */
export function takePceCopyRefusal(): boolean {
  if (!pceCopyInEffect) return false;
  pceCopyInEffect = false;
  remember(false);
  return true;
}

/** La copie d'un PCE a donné une image : ce navigateur la prend, c'est gardé. */
export function notePceCopyWorked(): void {
  if (!pceCopyInEffect) return;
  pceCopyInEffect = false;
  remember(true);
}

/** Un nouveau pipeline s'ouvre : l'état de la copie précédente ne le concerne plus. */
export function resetPceCopyState(): void {
  pceCopyInEffect = false;
  lastPceDecision = null;
}

function remember(ok: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ua: navigator.userAgent, ok }));
  } catch {
    // Stockage refusé (navigation privée) : la question sera reposée, le chemin sûr pris d'ici là.
  }
}

let pending: Promise<boolean | null> | null = null;

/**
 * Pose la question si personne ne l'a encore fait pour ce navigateur, sans l'attendre. À appeler
 * quand une piste à PCE se présente ; ne bloque rien, ne lève rien.
 */
export function primePceProbe(): void {
  if (pceCopyAccepted() !== null || pending) return;
  pending = probePceCopy()
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
}

/** Le vrai envoi. `null` quand la question ne peut pas être posée ici (pas de MediaSource, pas de document). */
export async function probePceCopy(): Promise<boolean | null> {
  if (typeof document === "undefined") return null;
  const Source = sourceConstructor();
  if (!Source) return null;
  const mime = 'audio/mp4; codecs="mp4a.40.2"';
  try {
    if (!Source.isTypeSupported(mime)) {
      remember(false);
      return false;
    }
  } catch {
    return null;
  }
  const track: MuxTrackInfo = {
    id: 1,
    kind: "audio",
    timescale: 48000,
    sampleEntry: audioSampleEntryFor({ codecId: "A_AAC", codecPrivate: PROBE_ASC, channels: 6, sampleRate: 48000, firstFrame: null }),
    width: 0,
    height: 0,
    language: "und",
  };
  const init = initSegment(track, 0);
  const media = mediaSegment(track, 1, [
    { data: PROBE_FRAME, decodeTime: 0, duration: 1024, compositionOffset: 0, isKeyframe: true },
    { data: PROBE_FRAME, decodeTime: 1024, duration: 1024, compositionOffset: 0, isKeyframe: true },
  ]);
  const answer = await new Promise<boolean | null>((resolve) => {
    const element = document.createElement("audio");
    // Exigé par Safari pour attacher une source gérée (voir MseSource.open).
    (element as HTMLMediaElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    const source = new Source();
    let url: string | null = null;
    let settled = false;
    const finish = (result: boolean | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        element.removeAttribute("src");
        if (url) URL.revokeObjectURL(url);
        element.load();
      } catch {
        // L'élément est jeté de toute façon.
      }
      resolve(result);
    };
    // Une sonde qui n'aboutit pas ne dit rien : `null`, la question sera reposée.
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    source.addEventListener(
      "sourceopen",
      () => {
        try {
          const buffer = source.addSourceBuffer(mime);
          // Chromium refuse au segment d'initialisation : `error`, puis la source passe à `ended`.
          buffer.addEventListener("error", () => finish(false), { once: true });
          source.addEventListener("sourceended", () => finish(false), { once: true });
          buffer.addEventListener(
            "updateend",
            () => {
              try {
                buffer.addEventListener(
                  "updateend",
                  () => finish(source.readyState === "open" && buffer.buffered.length > 0),
                  { once: true }
                );
                buffer.appendBuffer(media);
              } catch {
                finish(false);
              }
            },
            { once: true }
          );
          buffer.appendBuffer(init);
        } catch {
          finish(false);
        }
      },
      { once: true }
    );
    // Comme MseSource.open : l'objet directement d'abord (seule voie d'une source gérée sur iPhone),
    // une URL sinon (Chromium refuse `srcObject = MediaSource`).
    try {
      (element as unknown as { srcObject: unknown }).srcObject = source;
    } catch {
      // Repli ci-dessous.
    }
    if (!(element as unknown as { srcObject: unknown }).srcObject) {
      try {
        url = URL.createObjectURL(source as MediaSource);
        element.src = url;
      } catch {
        finish(null);
      }
    }
  });
  if (answer !== null) remember(answer);
  return answer;
}

export const __testing = {
  reset: () => {
    pending = null;
    pceCopyInEffect = false;
    lastPceDecision = null;
  },
  STORAGE_KEY,
};
