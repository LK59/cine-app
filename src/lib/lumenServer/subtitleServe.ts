// Les sous-titres de Lumen serveur dans le flux HLS, côté serveur (DECISIONS.md §191) : ce que Jellyfin dit des
// pistes, le WebVTT qu'il en tire, et les réponses de `GET /api/lumen/{titre}/{version}/{lecture}/…` pour
// `master.m3u8?st=N`, `s{N}h{empreinte}.m3u8` et `s{N}h{empreinte}/{n}.vtt`. Les règles pures sont dans `subtitles.ts`.
//
// Appelé par `serve.ts` **après** ses contrôles : le laissez-passer d'une Apple TV ou la session de l'administrateur
// (`lumenAccess`, `assertVisible`), la version de l'adresse, l'index du fichier. Rien ici ne relâche l'accès.
//
// Jellyfin est lu avec le compte de la session (celui que porte le laissez-passer pour un téléviseur), comme
// `/api/lumen/{id}/pistes` : un titre caché reste caché. Le WebVTT est demandé avec la clé du serveur, comme la route
// des sous-titres (`/api/jellyfin/stream/subtitle`), avec la correction de synchro appliquée par la même fonction
// (`rewriteVttTimes`, §141) — jamais une seconde copie de la règle.
//
// Les absences (CrowdSec, DECISIONS.md §156) : 410 pour un nom qui ne désigne plus rien (piste changée, synchro refaite,
// segment hors de l'index), 503 pour un Jellyfin muet ; jamais 404 ni 400. La liste maître, elle, ne refuse jamais pour
// les sous-titres : sans Jellyfin, elle part sans rendu de sous-titres (et le dit dans `X-Lumen-Sous-Titres`) — mieux
// vaut un film sans sous-titres au téléviseur qu'un film qui ne démarre pas.

import { NextResponse, type NextRequest } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { createT, loadLocaleDict, localeOf } from "@/lib/i18n";
import { labelSubtitleTracks } from "@/lib/trackLabel";
import { rewriteVttTimes } from "@/lib/subtitleSync";
import { subtitleSyncByIndex } from "@/lib/subtitleSync/store";
import type { SessionPayload } from "@/lib/auth";
import { logError } from "@/lib/logger";
import type { LumenIndex } from "./format";
import { busyResponse, goneResponse } from "./service";
import {
  chosenSubtitle,
  parseSubtitleParam,
  parseVttCues,
  subtitleMediaPlaylist,
  subtitleRenditionTag,
  subtitleSegment,
  withSubtitleRendition,
  type LumenSubtitlePath,
  type LumenSubtitleTrack,
  type VttCue,
} from "./subtitles";

/** Ce qu'on garde des pistes d'un élément pour un compte : une minute (une diffusion lit la liste puis ses segments). */
const FACTS_TTL_MS = 60_000;
/** Les répliques d'une piste : une demi-heure, quelques pistes — une diffusion à la fois, rarement deux. */
const CUES_TTL_MS = 30 * 60_000;
const CUES_MAX = 16;
const FACTS_MAX = 64;

export interface LumenSubtitleFacts {
  mediaSourceId: string;
  tracks: LumenSubtitleTrack[];
}

interface SubtitleCacheState {
  facts: Map<string, { at: number; value: LumenSubtitleFacts }>;
  cues: Map<string, { at: number; cues: VttCue[] }>;
  /** Une lecture en cours par piste : vingt segments demandés d'un coup ne font qu'une conversion chez Jellyfin. */
  pending: Map<string, Promise<VttCue[] | "absent" | "erreur">>;
}

/**
 * Sur `globalThis` (la leçon de `server-cache.ts`) : la route est un point d'entrée à part, et deux copies du module
 * garderaient deux caches.
 */
function state(): SubtitleCacheState {
  const key = Symbol.for("cine-app.lumenSubtitles");
  const g = globalThis as unknown as Record<symbol, SubtitleCacheState | undefined>;
  return (g[key] ??= { facts: new Map(), cues: new Map(), pending: new Map() });
}

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}

/**
 * Les pistes de sous-titres de l'élément pour ce compte, synchro comprise (§141) ; null si Jellyfin ne répond pas ou
 * n'a pas de source. Toutes les pistes (images comprises) : `chosenSubtitle` écarte ce que ce chemin ne porte pas.
 */
export async function lumenSubtitleFacts(jfId: string, itemId: string, now = Date.now()): Promise<LumenSubtitleFacts | null> {
  const key = `${jfId}|${itemId}`;
  const kept = state().facts.get(key);
  if (kept && now - kept.at < FACTS_TTL_MS) return kept.value;
  try {
    const item = await jellyfin.getItemMediaSources(jfId, itemId, { pass: true });
    const source = item.MediaSources?.[0];
    if (!source?.Id) return null;
    const streams = source.MediaStreams ?? [];
    const syncByIndex = subtitleSyncByIndex(itemId, source.ETag, streams);
    const tracks = streams
      .filter((s) => s.Type === "Subtitle" && typeof s.Index === "number")
      .map((s): LumenSubtitleTrack => {
        const sync = syncByIndex?.[String(s.Index)];
        return {
          index: s.Index,
          language: s.Language ?? null,
          title: s.Title ?? null,
          codec: s.Codec ?? null,
          isDefault: s.IsDefault ?? false,
          isForced: s.IsForced ?? false,
          isHearingImpaired: s.IsHearingImpaired ?? false,
          isExternal: s.IsExternal ?? false,
          path: s.IsExternal ? (s.Path ?? null) : null,
          isText: s.IsTextSubtitleStream ?? null,
          sync: sync ? { offset: sync.offset, scale: sync.scale, version: sync.version } : null,
        };
      });
    const value = { mediaSourceId: source.Id, tracks };
    remember(state().facts, key, { at: now, value }, FACTS_MAX);
    return value;
  } catch (error) {
    logError("lumen/sous-titres", error, { itemId, stage: "pistes" });
    return null;
  }
}

/**
 * Les répliques d'une piste : le WebVTT de Jellyfin (clé du serveur, la conversion de la route des sous-titres), la
 * synchro appliquée, lues une fois. `absent` : Jellyfin refuse la piste (rien à réessayer) ; `erreur` : muet.
 */
export async function lumenSubtitleCues(itemId: string, mediaSourceId: string, tag: string, track: LumenSubtitleTrack, now = Date.now()): Promise<VttCue[] | "absent" | "erreur"> {
  // Le nom du rendu porte déjà tout ce qui fait les octets (source, piste, synchro) : c'est la clé.
  const key = `${itemId}|${tag}`;
  const s = state();
  const kept = s.cues.get(key);
  if (kept && now - kept.at < CUES_TTL_MS) return kept.cues;
  const running = s.pending.get(key);
  if (running) return running;
  const work = (async (): Promise<VttCue[] | "absent" | "erreur"> => {
    const target = `${config.jellyfin.url}/Videos/${itemId}/${mediaSourceId}/Subtitles/${track.index}/Stream.vtt`;
    try {
      const res = await passJellyfinFetch(target, { signal: AbortSignal.timeout(15_000), headers: jellyfinAuthHeaders(config.jellyfin.apiKey) });
      if (res.status === 404 || res.status === 400) return "absent";
      if (!res.ok) return "erreur";
      const text = await res.text();
      const cues = parseVttCues(track.sync ? rewriteVttTimes(text, track.sync) : text);
      remember(s.cues, key, { at: Date.now(), cues }, CUES_MAX);
      return cues;
    } catch (error) {
      logError("lumen/sous-titres", error, { itemId, index: track.index, stage: "webvtt" });
      return "erreur";
    }
  })();
  s.pending.set(key, work);
  try {
    return await work;
  } finally {
    s.pending.delete(key);
  }
}

/** L'étiquette d'une piste, comme dans les menus des lecteurs (`trackLabel.ts`), parmi les pistes de texte de l'élément. */
async function subtitleName(req: NextRequest, tracks: readonly LumenSubtitleTrack[], chosen: LumenSubtitleTrack): Promise<string> {
  const locale = localeOf(req);
  const t = createT(await loadLocaleDict(locale), await loadLocaleDict("fr"), locale);
  const labels = labelSubtitleTracks(
    tracks.map((st) => ({ number: st.index, language: st.language, name: st.title, isDefault: st.isDefault, isForced: st.isForced, isHearingImpaired: st.isHearingImpaired, isExternal: st.isExternal })),
    {
      locale,
      forces: t("player.trackLabel.forced"),
      complets: t("player.trackLabel.full"),
      malentendants: t("player.trackLabel.sdh"),
      externe: t("player.trackLabel.external"),
      piste: (n: number) => t("player.trackLabel.track", { n }),
    }
  );
  return labels.find((l) => l.number === chosen.index)?.label ?? String(chosen.index);
}

/** L'en-tête qui dit, sur la liste maître, ce qui est arrivé des sous-titres demandés : `rendu`, `absent`, `indisponible`. */
export const SUBTITLE_HEADER = "X-Lumen-Sous-Titres";

/**
 * La liste maître de la règle, augmentée du rendu que `?st=` demande. Sans `st` : le texte tel quel (et aucun appel à
 * Jellyfin). `st` mal formé : null — l'appelant répond 410 comme pour `?audio=` mal formé.
 */
export async function masterWithSubtitles(
  req: NextRequest,
  text: string,
  { session, itemId }: { session: Pick<SessionPayload, "jfId">; itemId: string }
): Promise<{ text: string; outcome: "rendu" | "absent" | "indisponible" | null } | null> {
  const wanted = parseSubtitleParam(req.nextUrl.searchParams.get("st"));
  if (wanted === null) return null;
  if (wanted === undefined) return { text, outcome: null };
  if (!session.jfId) return { text, outcome: "indisponible" };
  const facts = await lumenSubtitleFacts(session.jfId, itemId);
  if (!facts) return { text, outcome: "indisponible" };
  const chosen = chosenSubtitle(facts.tracks, wanted);
  if (!chosen) return { text, outcome: "absent" };
  const tag = subtitleRenditionTag(facts.mediaSourceId, chosen);
  const name = await subtitleName(req, facts.tracks.filter((t) => t.isText !== false), chosen);
  return { text: withSubtitleRendition(text, { tag, track: chosen, name }), outcome: "rendu" };
}

/** Le WebVTT d'un segment : petit, servi tel quel (Next le compresse s'il veut — aucune longueur déclarée ici). */
const VTT_TYPE = "text/vtt; charset=utf-8";
/** Une heure, comme la route des sous-titres : le nom porte la piste et sa synchro, mais le WebVTT vient de Jellyfin. */
const VTT_CACHE = "private, max-age=3600";

/**
 * La liste média ou un segment d'un rendu de sous-titres. `index` : l'index du fichier sous la version de l'adresse
 * (les frontières et le délai D). Le nom est revérifié contre les pistes d'aujourd'hui : une empreinte qui ne
 * correspond plus répond 410, jamais les répliques d'une autre piste.
 */
export async function serveSubtitleRendition(
  req: NextRequest,
  {
    path,
    index,
    session,
    itemId,
    playlistResponse,
  }: {
    path: LumenSubtitlePath;
    index: Pick<LumenIndex, "segments" | "delayUs">;
    session: Pick<SessionPayload, "jfId">;
    itemId: string;
    playlistResponse: (req: NextRequest, text: string) => Promise<NextResponse>;
  }
): Promise<NextResponse> {
  if (!session.jfId) return goneResponse("lumen-inconnu", "Sous-titres sans compte Jellyfin");
  const facts = await lumenSubtitleFacts(session.jfId, itemId);
  if (!facts) return busyResponse("Jellyfin injoignable pour les sous-titres, réessayer");
  const track = chosenSubtitle(facts.tracks, path.index);
  if (!track || subtitleRenditionTag(facts.mediaSourceId, track) !== path.tag) return goneResponse("lumen-perime", "Piste de sous-titres changée");
  if (path.kind === "playlist") return playlistResponse(req, subtitleMediaPlaylist(index.segments, path.tag));
  if (path.n >= index.segments.length) return goneResponse("lumen-inconnu", "Segment hors de l'index");
  const cues = await lumenSubtitleCues(itemId, facts.mediaSourceId, path.tag, track);
  if (cues === "absent") return goneResponse("lumen-perime", "Piste de sous-titres refusée par Jellyfin");
  if (cues === "erreur") return busyResponse("Sous-titres indisponibles, réessayer");
  return new NextResponse(subtitleSegment(cues, index.segments, path.n, index.delayUs), { headers: { "Content-Type": VTT_TYPE, "Cache-Control": VTT_CACHE } });
}

export const __testing = {
  reset(): void {
    const s = state();
    s.facts.clear();
    s.cues.clear();
    s.pending.clear();
  },
};
