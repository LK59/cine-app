import { xray, xrayConfigured } from "@/lib/clients/xray";
import { logError } from "@/lib/logger";
import { analysisTarget, castOf, tmdbPhotoUrl, type XrayPerson } from "./cast";
import { keepsAnalysis } from "./rebind";

/**
 * Ce que le lecteur lira des acteurs à l'écran (DECISIONS.md §138) : les scènes du service, jointes à la
 * distribution de l'élément — nom, personnage, photo. Aucune interface ne la lit encore ; la forme est
 * fixée ici pour qu'elle n'ait pas à changer quand elle viendra.
 *
 * Une absence attendue n'est jamais une erreur : option coupée, rien d'analysé, service injoignable,
 * résultat d'une autre version du fichier — chaque cas rend `scenes: []` avec un `status` qui le dit.
 */

export type XrayPlayerStatus = "off" | "none" | "queued" | "running" | "done" | "failed" | "stale" | "unavailable";

export interface XrayPlayerPerson {
  personId: number;
  /** `null` : un visage nommé dans un autre épisode de la série, absent de la distribution de celui-ci. */
  name: string | null;
  character: string | null;
  /** Adresse `image.tmdb.org` (w185), comme les vignettes de distribution du cinéma. */
  photo: string | null;
  screenTime: number;
  confidence: number;
}

export interface XrayPlayerScene {
  start: number;
  end: number;
  people: XrayPlayerPerson[];
}

export interface XrayPlayerPayload {
  status: XrayPlayerStatus;
  /** Toute la durée est analysée ; sinon, seulement jusqu'à `analyzedUntil` secondes. */
  complete: boolean;
  analyzedUntil: number;
  scenes: XrayPlayerScene[];
}

export const emptyXray = (status: XrayPlayerStatus): XrayPlayerPayload => ({ status, complete: false, analyzedUntil: 0, scenes: [] });

const finite = (n: unknown, fallback = 0): number => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

/** Les scènes d'un élément pour le lecteur. Ne lève jamais. */
export async function scenesForPlayer(itemId: string): Promise<XrayPlayerPayload> {
  if (!xrayConfigured()) return emptyXray("off");
  const id = itemId.toLowerCase();
  try {
    const [result, target] = await Promise.all([xray.scenes(id), analysisTarget(id).catch(() => null)]);
    if (!result) {
      const state = await xray.itemStatus(id);
      if (!state) return emptyXray("none");
      return { ...emptyXray(state.status === "done" ? "none" : state.status), analyzedUntil: finite(state.analyzedUntil) };
    }
    // Le fichier a changé depuis l'analyse : ses temps ne correspondent plus à rien — sauf s'il a gardé
    // sa durée à une seconde près (un réencodage : §138, 09/11/2026), où les scènes tombent toujours juste.
    if (target && result.etag && result.etag !== target.etag) {
      // La durée lue par le service n'est que dans `/items` : demandée seulement dans ce cas-là.
      const state = target.durationS ? await xray.itemStatus(id).catch(() => null) : null;
      const durationS = state && state.etag === result.etag ? (state as { durationS?: number | null }).durationS : null;
      const kept = keepsAnalysis(id, { etag: result.etag, status: result.complete ? "done" : "running", analyzedUntil: finite(result.analyzedUntil), durationS }, target.durationS, result.complete === true);
      if (!kept) return emptyXray("stale");
    }
    // La distribution, pour nommer : un échec de TMDB laisse les visages sans nom, pas le lecteur sans scènes.
    const cast = target?.tmdb ? await castOf(target.tmdb).catch(() => [] as XrayPerson[]) : [];
    const byId = new Map(cast.map((p) => [p.personId, p]));
    const scenes: XrayPlayerScene[] = (Array.isArray(result.scenes) ? result.scenes : []).map((scene) => ({
      start: finite(scene.start),
      end: finite(scene.end),
      people: (Array.isArray(scene.people) ? scene.people : [])
        .filter((p) => typeof p?.personId === "number")
        .map((p) => {
          const known = byId.get(p.personId);
          return {
            personId: p.personId,
            name: known?.name ?? null,
            character: known?.character || null,
            photo: known?.profilePath ? tmdbPhotoUrl(known.profilePath) : null,
            screenTime: finite(p.screenTime),
            confidence: finite(p.confidence),
          };
        }),
    }));
    return { status: result.complete ? "done" : "running", complete: result.complete === true, analyzedUntil: finite(result.analyzedUntil), scenes };
  } catch (error) {
    logError("xray/scenes", error, { itemId: id });
    return emptyXray("unavailable");
  }
}
