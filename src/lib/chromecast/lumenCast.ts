/**
 * Lumen serveur vers un Chromecast, côté émetteur (DECISIONS.md §192).
 *
 * **Pourquoi l'émetteur décide seul, quel que soit le lecteur de la page.** Le Chromecast ne s'émet que de Chrome et
 * d'Edge (ordinateur, Android, `chromecastSenderEligible`), où Lumen serveur n'existe pas dans la page : il passe par le
 * HLS natif de WebKit (`lumenWanted`, §180). Une lecture « Lumen » ne peut donc jamais être celle qui passe la main au
 * Chromecast. Mais le récepteur, lui, n'a que faire du lecteur de la page : il reçoit une adresse et lit le flux
 * lui-même. Ce qui décide est donc **l'option de l'appareil émetteur** (« Lecteur expérimental : remux serveur »,
 * `lumenChoiceFor`, la même clé, lue une fois par séance) et **le verdict du serveur pour un récepteur** (`?cast=1` :
 * la vidéo telle quelle, le son en AAC, `castView`) — jamais le moteur du navigateur.
 *
 * Sans l'option, rien ne change : pas une requête de plus, le récepteur reçoit le flux de Jellyfin comme avant.
 *
 * Ce module ne fait que des questions : `ChromecastPlayer` charge, journalise et se replie.
 */

import { lumenChoiceFor } from "@/lib/lumenServerChoice";
import { matroskaNumberOf } from "@/components/player/lumen/lumenOpening";

/** Ce qu'une séance doit porter pour que le récepteur passe par Lumen serveur (l'option, ni banc, ni extrait, ni hors ligne). */
export function lumenCastWanted(session: { bench?: string; labSample?: unknown; offline?: unknown }, option: boolean = lumenChoiceFor(session)): boolean {
  if (!option) return false;
  return !session.bench && !session.labSample && !session.offline;
}

/**
 * Les récepteurs qui ont refusé un fichier HEVC par Lumen serveur, pour cette page : un Chromecast de 1re à 3e génération
 * ne décode pas le HEVC (seuls Ultra, Chromecast avec Google TV et Google TV Streamer le font), et le kit ne dit pas le
 * modèle. Le premier essai HEVC vers lui se replie sur le flux de Jellyfin (un refus de chargement, ou 25 s sans image) ;
 * les suivants demandent `hevc=0` et le serveur renvoie au flux de Jellyfin sans essai. En mémoire seulement : un
 * rechargement de la page refait l'essai, une fois.
 */
const hevcRefused = new Set<string>();

export function receiverRefusedHevc(device: string | null): boolean {
  return hevcRefused.has(device ?? "");
}

export function noteReceiverRefusedHevc(device: string | null): void {
  hevcRefused.add(device ?? "");
}

/** Pour les tests : une page neuve. */
export function resetLumenCastMemory(): void {
  hevcRefused.clear();
}

/** Un identifiant de lecture (`s` de l'adresse), tiré par la page comme le fait `LumenServerHost`. */
export function newLumenCastPlaybackId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Ce que le serveur attend un index qui se construit (la règle de `LumenServerHost`) : au-delà, le flux de Jellyfin. */
export const LUMEN_CAST_VERDICT_WAIT_MS = 8000;

export type LumenCastAnswer =
  | { ok: true; url: string; s: string; audioTrack: number | null; video: "h264" | "hevc" | null; converted: boolean }
  | { ok: false; reason: string };

interface VerdictBody {
  ok?: boolean;
  pending?: boolean;
  reason?: string;
  detail?: string;
  master?: string;
  audioTrack?: number | null;
  castVideo?: "h264" | "hevc";
  audio?: { number: number; converted: string | null }[];
}

async function askVerdict(itemId: string, params: URLSearchParams): Promise<VerdictBody> {
  const res = await fetch(`/api/lumen/${itemId}/eligibility?${params}`, { signal: AbortSignal.timeout(LUMEN_CAST_VERDICT_WAIT_MS + 6000) });
  const body = (await res.json().catch(() => ({}))) as VerdictBody;
  if (res.status === 202 || body.pending) return { ok: false, pending: true, reason: "index-en-cours" };
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  return body;
}

/**
 * L'adresse Lumen serveur d'un récepteur pour ce titre et cette piste, ou pourquoi pas (le flux de Jellyfin alors).
 *
 * `audioStreamIndex` est l'index **Jellyfin** de la piste (celui de la négociation, des menus de la télécommande) ;
 * le serveur parle en numéros Matroska. Le passage se fait par le rang (`matroskaNumberOf`, la règle de
 * `LumenServerHost`) : une première question sans piste rend la liste des pistes du fichier ; une seconde nomme la
 * bonne si ce n'est pas celle par défaut (l'index est alors gardé : quelques millisecondes). Des listes qui ne se
 * correspondent pas (un nombre de pistes différent) : pas de Lumen serveur pour ce titre.
 *
 * L'adresse rendue est **absolue** (le récepteur ne connaît pas notre origine), avec son laissez-passer `cc.{jeton}`.
 */
export async function requestLumenCast(args: {
  itemId: string;
  audioStreamIndex: number | undefined;
  jellyfinAudio: readonly { index: number }[];
  s: string;
  hevc: boolean;
  origin: string;
}): Promise<LumenCastAnswer> {
  const base = (audio?: number) => {
    const params = new URLSearchParams({ cast: "1", s: args.s, wait: String(LUMEN_CAST_VERDICT_WAIT_MS) });
    if (!args.hevc) params.set("hevc", "0");
    if (audio !== undefined) params.set("audio", String(audio));
    return params;
  };
  const refusal = (v: VerdictBody): LumenCastAnswer => ({ ok: false, reason: `${v.reason ?? "refus"}${v.detail ? ` (${v.detail})` : ""}` });
  try {
    let verdict = await askVerdict(args.itemId, base());
    if (verdict.pending) return { ok: false, reason: "index en cours de construction" };
    // Un refus du fichier entier (vidéo, index) ne liste aucune piste : il n'y a rien à faire correspondre.
    if (!verdict.ok && !verdict.audio?.length) return refusal(verdict);
    if (args.audioStreamIndex !== undefined) {
      const number = matroskaNumberOf(verdict.audio ?? [], args.jellyfinAudio, args.audioStreamIndex);
      if (number === null) return { ok: false, reason: "pistes son sans correspondance" };
      if (number !== verdict.audioTrack) {
        verdict = await askVerdict(args.itemId, base(number));
        if (verdict.pending) return { ok: false, reason: "index en cours de construction" };
      }
    }
    if (!verdict.ok || !verdict.master) return refusal(verdict);
    const chosen = verdict.audio?.find((a) => a.number === verdict.audioTrack);
    return {
      ok: true,
      url: new URL(verdict.master, args.origin).toString(),
      s: args.s,
      audioTrack: verdict.audioTrack ?? null,
      video: verdict.castVideo ?? null,
      converted: !!chosen?.converted,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? `éligibilité : ${error.message}` : "éligibilité injoignable" };
  }
}
