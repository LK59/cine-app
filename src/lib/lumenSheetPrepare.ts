/**
 * Le levier (1) de Lumen serveur dans le cinéma (étape 4, DECISIONS.md §180) : la fiche ouverte fait préparer au
 * serveur ce que « Lire » va demander — `POST /api/lumen/{id}/prepare` : l'index du fichier, puis le segment de la
 * reprise (vidéo et son), gardés deux minutes (`segmentCache.ts`). Mesuré par Louis sur iPhone (banc « Leviers de
 * démarrage », 17/11/2026) : première image en 0,47 à 0,49 s au lieu de 0,81 à 1,36 s.
 *
 * Seulement là où Lumen serveur lira vraiment (`lumenWanted` sans le titre : l'option de l'appareil, WebKit et
 * son HLS natif, une page sans MediaSource) — rien ne part pour les autres comptes ni les autres navigateurs. Et
 * sobre, contre les règles du pare-feu (CLAUDE.md, « An expected absence… » : `http-crawl-non_statics` compte les
 * noms distincts en rafale) :
 * - **une demi-seconde de fiche d'abord** : une fiche traversée ne coûte rien (la préparation de l'en-tête du
 *   lecteur actuel attend une seconde, `sheetHeaderWarmup.ts` ; ici le serveur a l'index en ~0,2 s depuis les Cues
 *   et le segment en quelques dizaines de ms — plus tôt, c'est plus de chances d'être prêt à l'appui) ;
 * - **une seule en vol** : la fiche suivante coupe la précédente ; fermer la fiche avant le délai n'envoie rien ;
 * - **une par titre toutes les deux minutes** (la durée de garde du segment au serveur) et **huit par minute au
 *   plus** : rouvrir la même fiche ne redemande rien, et parcourir trente fiches ne fait pas trente requêtes ;
 * - **jamais pendant un film**, ni page cachée, ni « économiseur de données ».
 * Un échec ne coûte rien : la lecture prépare elle-même, comme avant.
 *
 * La position : la reprise que la fiche a déjà demandée au serveur (`playback-state`, lue sans être prise), avec le
 * même recul que la lecture (`openingPosition`, §28) — le segment préparé est celui que `#t=` demandera. Le son :
 * celui que le serveur choisirait par défaut ; une piste différente choisie à la lecture garde la vidéo préparée.
 */
import { lumenChoiceFor, lumenWanted } from "@/lib/lumenServerChoice";
import { readDialogueMode } from "@/lib/dialoguePreference";
import { peekPrefetchedPlaybackState } from "@/lib/playbackPrefetch";
import { openingPosition } from "@/lib/resumeRewind";

export const LUMEN_PREPARE_DELAY_MS = 500;
/** La garde du segment préparé au serveur (`segmentCache.ts`) : au-delà, préparer de nouveau a un sens. */
export const LUMEN_PREPARE_AGAIN_MS = 2 * 60_000;
/** Au plus tant de préparations par minute glissante. */
export const LUMEN_PREPARE_PER_MINUTE = 8;

let current: AbortController | null = null;
/** Le dernier envoi par titre, et ce que le serveur a répondu (`ok`, `pending`, `refus`, `erreur`). */
const sent = new Map<string, { at: number; status: string }>();
const recent: number[] = [];

function savesData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/** Ce que la fiche a préparé pour ce titre, s'il y a moins de deux minutes — porté par la ligne `start`. */
export function readLumenPrepared(itemId: string, now = Date.now()): { agoMs: number; status: string } | null {
  const entry = sent.get(itemId);
  if (!entry || now - entry.at > LUMEN_PREPARE_AGAIN_MS) return null;
  return { agoMs: now - entry.at, status: entry.status };
}

/**
 * Prépare `itemId` au serveur après le délai, sauf si la fiche se ferme avant (la fonction rendue). Rien du tout
 * hors des conditions de Lumen serveur.
 */
export function scheduleLumenPrepare(itemId: string, probe: { wanted?: () => boolean; now?: () => number } = {}): () => void {
  const wanted = probe.wanted ?? (() => lumenWanted({ itemId }, { option: lumenChoiceFor(lumenSheetToken) }));
  if (!wanted()) return () => {};
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (controller.signal.aborted || document.hidden || savesData()) return;
    void prepareLumen(itemId, controller, probe.now ?? Date.now);
  }, LUMEN_PREPARE_DELAY_MS);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

/**
 * L'option relue à chaque fiche : un objet neuf par appel serait relu à chaque fois, un objet unique figerait la
 * première lecture pour toute la page. Un jeton par minute : basculer l'option vaut à la fiche suivante, au plus
 * une minute plus tard.
 */
let lumenSheetToken: object = {};
let tokenAt = 0;
function refreshToken(now: number): void {
  if (now - tokenAt > 60_000) {
    lumenSheetToken = {};
    tokenAt = now;
  }
}

/** Exportée pour les tests ; ailleurs, passer par `scheduleLumenPrepare`. */
export async function prepareLumen(itemId: string, controller: AbortController, now: () => number = Date.now): Promise<void> {
  const at = now();
  refreshToken(at);
  const previous = sent.get(itemId);
  if (previous && at - previous.at < LUMEN_PREPARE_AGAIN_MS) return;
  while (recent.length && at - recent[0] > 60_000) recent.shift();
  if (recent.length >= LUMEN_PREPARE_PER_MINUTE) return;
  current?.abort();
  current = controller;
  recent.push(at);
  const entry = { at, status: "envoyée" };
  sent.set(itemId, entry);
  try {
    // La reprise que la fiche a déjà demandée (sans la prendre : la lecture la prendra) ; sinon le début.
    const state = await (peekPrefetchedPlaybackState(itemId) ?? Promise.resolve(null)).catch(() => null);
    if (controller.signal.aborted) return;
    const resume = state && !state.positionUnknown ? state.resumeSeconds : 0;
    const position = openingPosition(itemId, resume, null);
    const dialogue = readDialogueMode();
    const res = await fetch(`/api/lumen/${itemId}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // « Améliorer les dialogues » allumé sur l'appareil (§191) : le segment de reprise du rendu traité par le serveur.
      body: JSON.stringify(dialogue === "off" ? { position } : { position, dialogue }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; pending?: boolean } | null;
    entry.status = res.status === 202 || body?.pending ? "pending" : res.ok && body?.ok ? "ok" : res.ok ? "refus" : `http ${res.status}`;
  } catch {
    // Coupée (fiche fermée, une autre ouverte) ou réseau : la lecture préparera elle-même.
    entry.status = controller.signal.aborted ? "coupée" : "erreur";
  } finally {
    if (current === controller) current = null;
  }
}

/** Pour les tests : l'état d'une page neuve. */
export function forgetLumenPrepares(): void {
  current?.abort();
  current = null;
  sent.clear();
  recent.length = 0;
  tokenAt = 0;
}
