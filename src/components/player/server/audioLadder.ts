/**
 * L'échelle du lecteur serveur quand l'élément refuse un flux : les marches du son, la marche
 * H.264 de l'image, et ce qu'elles retiennent — le temps d'une ouverture, porté à travers un
 * rechargement de page WebKit. Sorti de `PlayerHost.tsx` le 23/10/2026, à l'identique.
 */

// ── Audio-codec fallback ladder (native HLS path) ────────────────────────────────────────────
// Ground truth from live testing: a device's own canPlayType() can overreport what its native
// HLS pipeline really accepts — the concrete case being an iPhone whose canPlayType claims
// E-AC-3 support while its HLS master-playlist variant filter rejects any CODECS="…,ec-3"
// stream outright (MediaError 4, instantly, with byte-identical playlists to a working AC-3
// negotiation — every other explanation was tested and eliminated one by one). Since claimed
// support can't be trusted, actual playback is the only reliable probe: on a fatal native
// error, retry the same request with a progressively reduced audio codec set, which makes
// Jellyfin fall back to a genuine server-side audio transcode. The final rung (AAC only) is
// always transcodable and universally decodable, so the ladder can't strand the user.
//
// Ce qu'une marche a appris ne vaut que pour l'ouverture du lecteur en cours (`learnedExclusions`,
// épisodes enchaînés compris) : chaque nouvelle séance repart de la marche 0 (DECISIONS §67, décision
// du 11/10/2026). Les codecs exclus étaient retenus pour toujours par navigateur, quelle que soit la
// cause de l'échec — une coupure ou une image illisible suffisait à faire convertir l'E-AC3 par le
// serveur sur cet appareil, à jamais.
export const AUDIO_FALLBACK_RUNGS: string[][] = [
  [], // replay the identical request first — absorbs transient teardown races, learns nothing
  ["eac3", "flac", "opus"], // keep aac+ac3, the two most reliably decoded codecs on Apple hw
  ["eac3", "flac", "opus", "ac3"], // AAC only — forces a clean server transcode, always works
];

/**
 * Après l'échelle du son, une marche pour l'image : H.264 seul, ré-encodé par Jellyfin (`videoH264Only`,
 * la route). Seulement sur une erreur de décodage (code 3, ou une erreur média de hls.js), une fois
 * par ouverture.
 *
 * L'échelle ne touchait que le son et la vidéo restait copiée telle quelle : un Android 10 dont le
 * décodeur HEVC s'était bloqué (19/10/2026, après une heure sans souci) a vu cinq ouvertures de titres
 * HEVC, film 4K comme épisode 1080p, rejouer la même image illisible jusqu'à l'écran d'erreur — alors
 * que ses films H.264 passaient dans la même soirée.
 */
export const H264_RUNG = AUDIO_FALLBACK_RUNGS.length + 1;

/** L'échelon final : AAC seul, et le son ré-encodé plutôt que copié — voir `forceAudioTranscode`. */
export function isLastAudioRung(index: number): boolean {
  return index === AUDIO_FALLBACK_RUNGS.length - 1;
}

/** L'ancienne mémoire permanente des codecs exclus, par navigateur — retirée le 11/10/2026 (§67). */
export const LEGACY_AUDIO_BLOCKLIST_KEY = "cine:audio-codec-blocklist:v1";
let legacyBlocklistPurged = false;

/**
 * Efface, une fois par page, ce que l'ancienne mémoire avait retenu : un appareil « banni » d'un
 * codec par un échec d'il y a des semaines repart propre, et l'échelle réessaie depuis la marche 0.
 */
export function purgeLegacyAudioBlocklist(): void {
  if (legacyBlocklistPurged) return;
  legacyBlocklistPurged = true;
  try {
    localStorage.removeItem(LEGACY_AUDIO_BLOCKLIST_KEY);
  } catch {
    // Stockage indisponible : il n'y a rien à lire non plus.
  }
}

/**
 * Ce que l'échelle a appris, porté à travers le rechargement de page du changement de piste sur
 * WebKit (`fromReload`) — qui continue la même séance : sans lui, chaque changement de langue sur un
 * iPhone rejouait les trois marches. `sessionStorage`, lu par cette seule ouverture rechargée et
 * effacé par toute autre : une nouvelle séance repart de la marche 0.
 */
const LADDER_CARRY_KEY = "cine:audio-ladder-carry:v1";

export function carryLearnedExclusions(itemId: string, codecs: string[]): void {
  try {
    sessionStorage.setItem(LADDER_CARRY_KEY, JSON.stringify({ itemId, codecs }));
  } catch {
    // Stockage indisponible : le rechargement rejouera l'échelle, comme une séance neuve.
  }
}

/** Ce qu'un rechargement de la même séance a apporté — et la mémoire vidée dans tous les cas. */
export function takeCarriedExclusions(itemId: string, fromReload: boolean | undefined): string[] {
  try {
    const raw = sessionStorage.getItem(LADDER_CARRY_KEY);
    sessionStorage.removeItem(LADDER_CARRY_KEY);
    if (!fromReload || !raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const { itemId: carriedFor, codecs } = parsed as { itemId?: unknown; codecs?: unknown };
    if (carriedFor !== itemId || !Array.isArray(codecs)) return [];
    return codecs.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

/** Pour les tests : la purge se refait à la prochaine négociation. */
export function __resetLegacyBlocklistPurgeForTests(): void {
  legacyBlocklistPurged = false;
}
