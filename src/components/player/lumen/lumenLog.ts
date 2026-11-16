/**
 * Ce que Lumen serveur écrit dans player.log (étape 4, DECISIONS.md §180) — les mêmes lignes que les deux
 * autres lecteurs, sous `player: "lumen-serveur"` et `path: "remux-serveur"` (`ServerPlayerContext`, dont le
 * début de ligne est partagé avec le lecteur serveur : séance, navigateur, scène, banc).
 *
 * Des fonctions pures, testées seules : l'hôte ne se monte dans aucune empreinte, et ce qu'elles décident —
 * les champs, leur nom, le lecteur — est ce que la page d'activité lit. Le nom du lecteur est distinct de
 * `"serveur"` exprès : l'activité range `serveur` comme « Jellyfin transcode ou remultiplexe », alors que
 * Lumen serveur lit **le fichier** par **notre** remultiplexeur — le diagnostic fichier-ou-appareil doit le
 * traiter comme un témoin du fichier.
 *
 * `lumenSession` (l'identifiant de lecture `s` du serveur, celui de l'adresse) part sur chaque ligne : la route
 * du journal y retrouve le relevé de la lecture (`lumenPlaybackFields`, champs `srv.*`) pour `stop`, `stall`,
 * `error` et `fallback` — la page ne voit rien des requêtes HLS de Safari, le serveur voit tout.
 */
import { serverFailureFields, serverLineFields, serverStartFields, type ServerPlayerContext, type ServerStartWhy } from "@/lib/serverPlayerLog";

export const LUMEN_PLAYER = "lumen-serveur" as const;
export const LUMEN_PATH = "remux-serveur" as const;

/** Le contexte des lignes de Lumen serveur : celui du lecteur serveur, sous son propre nom. */
export function lumenContext(ctx: Omit<ServerPlayerContext, "player" | "path">): ServerPlayerContext {
  return { ...ctx, player: LUMEN_PLAYER, path: LUMEN_PATH };
}

/** Pourquoi Lumen serveur pose une adresse — un sous-ensemble du vocabulaire du lecteur serveur. */
export type LumenStartWhy = Extract<ServerStartWhy, "open" | "retry" | "audio-reload">;

/** Ce qu'on sait du fichier et de la lecture au moment de poser l'adresse. */
export interface LumenStartFacts {
  why: LumenStartWhy;
  at: number;
  /** La piste ouverte, numéro Matroska (celui des listes) et index Jellyfin quand il se relie. */
  audioTrack: number | null;
  audioStreamIndex?: number;
  /** La piste décrite, comme `fromTrack`/`toTrack` du lecteur actuel : codec, canaux, langue. */
  audio?: string;
  /** Réparations du son copié (§159) : `sbr-explicite`, `silence-devant`… */
  repairs?: string[];
  container?: string | null;
  video?: string | null;
  range?: string | null;
  lumenSession: string;
  version: string;
  segments?: number;
  targetS?: number;
  /** La position est passée en `#t=` (levier 2) — sinon un saut au `loadedmetadata`. */
  fragment: boolean;
  /** La fiche avait préparé ce titre (levier 1) : depuis combien de temps, et ce que le serveur avait répondu. */
  prepared?: { agoMs: number; status: string } | null;
  /** Ce qu'a coûté l'avant-adresse : description, verdict, pistes. */
  negotiateMs: number;
  /** Le son multiplexé dans les segments vidéo (essai `m1`, réglage serveur). */
  muxed?: boolean;
}

export function lumenStartFields(ctx: ServerPlayerContext, facts: LumenStartFacts): Record<string, unknown> {
  return {
    ...serverStartFields(ctx, { directPlay: false, nativeHls: true, resumeAt: facts.at, audioStreamIndex: facts.audioStreamIndex }, { why: facts.why }),
    // À la place de « transcodé par le serveur », à la même position dans la ligne.
    reason: "remultiplexé par le serveur",
    ...(facts.audioTrack !== null ? { audioTrack: facts.audioTrack } : {}),
    ...(facts.audio ? { audio: facts.audio } : {}),
    ...(facts.repairs?.length ? { repairs: facts.repairs.join(",") } : {}),
    ...(facts.container ? { container: facts.container } : {}),
    ...(facts.video ? { video: facts.video } : {}),
    ...(facts.range ? { range: facts.range } : {}),
    // Le cache du serveur, et non l'appareil : `openedFrom` se lit dans la même colonne que le lecteur actuel.
    openedFrom: "serveur",
    lumenSession: facts.lumenSession,
    lumenVersion: facts.version,
    ...(facts.segments !== undefined ? { segments: facts.segments } : {}),
    ...(facts.targetS !== undefined ? { targetS: facts.targetS } : {}),
    resumeBy: facts.fragment ? "fragment" : facts.at > 0 ? "saut" : "début",
    ...(facts.prepared ? { prepared: facts.prepared.status, preparedAgoMs: facts.prepared.agoMs } : {}),
    negotiateMs: Math.round(facts.negotiateMs),
    ...(facts.muxed ? { muxed: true } : {}),
  };
}

/** La première image : ce que le démarrage a coûté (une ligne par séance, comme `opening` du lecteur actuel). */
export function lumenOpeningFields(
  ctx: ServerPlayerContext,
  facts: { lumenSession: string; firstMoveMs: number; pictureMs: number; srcToPictureMs: number; at: number; landedAt: number; reopened: boolean; steps: string }
): Record<string, unknown> {
  return {
    ...serverLineFields(ctx),
    firstMoveMs: Math.round(facts.firstMoveMs),
    pictureMs: Math.round(facts.pictureMs),
    srcToPictureMs: Math.round(facts.srcToPictureMs),
    at: Math.round(facts.at),
    landedAt: Math.round(facts.landedAt * 10) / 10,
    ...(facts.reopened ? { reopened: true } : {}),
    lumenSession: facts.lumenSession,
    steps: facts.steps,
  };
}

/** Un saut, de la demande à `seeked` — les champs de `seekLineFields` du lecteur actuel. */
export function lumenSeekFields(
  ctx: ServerPlayerContext,
  seek: { from: number; to: number; buffered: boolean; ranges: string; tookMs: number; landedAt?: number; arrived?: boolean; superseded?: boolean },
  lumenSession: string
): Record<string, unknown> {
  return {
    ...serverLineFields(ctx),
    from: Math.round(seek.from),
    to: Math.round(seek.to),
    buffered: seek.buffered,
    ranges: seek.ranges,
    ...(seek.arrived !== undefined ? { arrived: seek.arrived } : {}),
    ...(seek.superseded ? { superseded: true } : {}),
    ...(seek.landedAt !== undefined ? { landedAt: Math.round(seek.landedAt * 10) / 10 } : {}),
    tookMs: Math.round(seek.tookMs),
    lumenSession,
  };
}

/** Comment un changement de piste a été servi. */
export type LumenAudioVia = "rendition" | "rechargement" | "refus";

export function lumenAudioFields(
  ctx: ServerPlayerContext,
  change: { from: number | null; to: number; fromTrack: string; toTrack: string; via: LumenAudioVia; applied: boolean; tookMs: number; at: number },
  lumenSession: string
): Record<string, unknown> {
  return {
    ...serverLineFields(ctx),
    from: change.from ?? -1,
    to: change.to,
    via: change.via,
    fromTrack: change.fromTrack,
    toTrack: change.toTrack,
    // Phase 1 : le serveur ne sert que des pistes copiées telles quelles (§159 : réparées sans réencoder).
    processing: "copié tel quel",
    applied: change.applied,
    tookMs: Math.round(change.tookMs),
    at: Math.round(change.at),
    lumenSession,
  };
}

/** Une horloge figée en lecture : ce que l'élément en dit. Le serveur ajoute ce qu'il a servi (`srv.*`). */
export function lumenStallFields(
  ctx: ServerPlayerContext,
  stall: { position: number; stalledMs: number; readyState: number; networkState: number; seeking: boolean; videoBuffered: string; lead: number | null; onLine: boolean },
  lumenSession: string,
  background: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...serverLineFields(ctx),
    position: Math.round(stall.position * 10) / 10,
    stalledMs: Math.round(stall.stalledMs),
    readyState: stall.readyState,
    networkState: stall.networkState,
    seeking: stall.seeking,
    videoBuffered: stall.videoBuffered,
    ...(stall.lead !== null ? { lead: Math.round(stall.lead * 10) / 10 } : {}),
    onLine: stall.onLine,
    lumenSession,
    ...background,
  };
}

/** Où va la lecture quand Lumen serveur renonce : avant l'image, au lecteur actuel ; après, au lecteur serveur. */
export type LumenFallbackTarget = "natif" | "serveur";

/**
 * Un repli. `planned` : un refus annoncé (le serveur ne sert pas ce fichier, la langue du compte n'y est pas,
 * l'appareil a déjà servi une MediaSource) — le chemin prévu, pas une panne : la page d'activité ne le compte
 * pas comme un échec (`isPlannedHandoff`). Le motif commence par « remux serveur » pour se lire d'un coup d'œil.
 */
export function lumenFallbackFields(
  ctx: ServerPlayerContext,
  fallback: { to: LumenFallbackTarget; planned: boolean; reason: string; watched: number; stage?: string; mediaError?: string | null; cast?: boolean; takeover?: unknown },
  lumenSession: string | null,
  background: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...serverFailureFields(ctx, fallback.reason, {
      to: fallback.to,
      planned: fallback.planned,
      ...(fallback.stage ? { stage: fallback.stage } : {}),
      ...(fallback.mediaError ? { mediaError: fallback.mediaError } : {}),
      ...(fallback.takeover ? { takeover: fallback.takeover } : {}),
      ...(fallback.cast ? { cast: true } : {}),
      watched: fallback.watched,
      ...(lumenSession ? { lumenSession } : {}),
      ...background,
    }),
  };
}

/**
 * Une réouverture sur ce chemin, après la première image (`recover` : une erreur de l'élément, une horloge figée,
 * un déploiement qui a changé la version — les segments répondent alors 410). La lecture continue ici : ce n'est
 * pas un repli, et la page d'activité la compte comme une reconstruction, motif lisible.
 */
export function lumenRebuildFields(
  ctx: ServerPlayerContext,
  rebuild: { reason: string; at: number; fromVersion: string; toVersion: string },
  lumenSession: string,
  background: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...serverLineFields(ctx),
    reason: lumenReason(rebuild.reason),
    at: Math.round(rebuild.at),
    ...(rebuild.fromVersion !== rebuild.toVersion ? { fromVersion: rebuild.fromVersion, toVersion: rebuild.toVersion } : { version: rebuild.toVersion }),
    lumenSession,
    ...background,
  };
}

/** Une erreur affichée ou une relance après une erreur de l'élément : `error`, avec ce que l'élément en dit. */
export function lumenErrorFields(ctx: ServerPlayerContext, reason: string, extra: Record<string, unknown>): Record<string, unknown> {
  return serverFailureFields(ctx, reason, extra);
}

/** Le préfixe de tout motif de repli de Lumen serveur. */
export const LUMEN_REASON_PREFIX = "remux serveur";

export function lumenReason(detail: string): string {
  return `${LUMEN_REASON_PREFIX} : ${detail}`.slice(0, 300);
}

/** Un repli prévu de Lumen serveur se reconnaît à sa ligne (`planned`), pas à sa phrase. */
export function isLumenPlannedFallback(r: { player?: unknown; planned?: unknown }): boolean {
  return r.player === LUMEN_PLAYER && r.planned === true;
}

/** `MediaError` en quelques mots : le code et le message, ce que la page en sait (fait 2 de 3-client.md). */
export function mediaErrorText(error: MediaError | null | undefined): string | null {
  if (!error) return null;
  return `code ${error.code}${error.message ? ` : ${error.message.slice(0, 160)}` : ""}`;
}

/** Les plages en tampon de l'élément, écrites court. */
export function bufferedText(buffered: TimeRanges | null | undefined): string {
  if (!buffered || buffered.length === 0) return "vide";
  const parts: string[] = [];
  for (let i = 0; i < Math.min(buffered.length, 6); i++) parts.push(`${buffered.start(i).toFixed(1)}-${buffered.end(i).toFixed(1)}`);
  return parts.join(",");
}
