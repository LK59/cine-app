import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { cachedMovies } from "@/lib/server-cache";
import { originalLanguageCode } from "@/lib/originalLanguage";
import { displayTitle } from "@/lib/displayTitle";
import { userPrefsDb } from "@/lib/db";
import { isJellyfinId } from "@/lib/jellyfinPath";

/** What Jellyfin can hand back as WebVTT. Anything else is a picture and has nothing to read. */
const TEXT_SUBTITLE_FORMATS = new Set(["srt", "subrip", "ass", "ssa", "vtt", "webvtt", "mov_text"]);

// Containers the experimental player's demuxer understands. Matroska is 99.7% of this library;
// anything else is refused with a reason rather than half-played.
// All four go through the same pipeline: mkv and webm are read as Matroska, mp4 and m4v as ISO
// BMFF (mp4Demux.ts) — the container told apart by the file's bytes, not by this name. A
// fragmented MP4 is refused there, by name, and ends at the server player like any refusal.
const SUPPORTED_CONTAINERS = new Set(["mkv", "webm", "mp4", "m4v"]);

// HDR ranges the WebGL tone-mapping path can handle. Dolby Vision profile 5 is deliberately
// absent: it has no HDR10 base layer, so there is nothing standard to tone-map from and the
// picture would come out with inverted-looking colours rather than merely flat ones.
const TONE_MAPPABLE_RANGES = new Set(["HDR10", "HDR10Plus", "HLG", "DOVIWithHDR10", "DOVIWithHDR10Plus", "DOVIWithSDR"]);

export interface DirectPlayAudioTrack {
  index: number;
  codec: string;
  language: string | null;
  displayTitle: string | null;
  channels: number | null;
  isDefault: boolean;
  /**
   * Ce que Jellyfin sait du profil : « Dolby Digital Plus + Dolby Atmos », « DTS-HD MA », « DTS:X ».
   *
   * Le conteneur ne le porte pas — le fichier dit `A_EAC3`, point — alors que c'est exactement ce
   * qui distingue une piste d'une autre à l'œil de qui choisit. Descendu jusqu'ici pour l'étiquette
   * du menu, et pour rien d'autre.
   */
  profile: string | null;
}

export interface ExternalSubtitle {
  /** Negative in the player's menus, so it can never collide with a track number from the file. */
  id: number;
  language: string | null;
  title: string | null;
  /** Through this app's own proxy, which asks Jellyfin for it as WebVTT. */
  url: string;
}

/**
 * La description du fichier, et rien qui appartienne au spectateur.
 *
 * `resumeSeconds` et `preferences` vivaient ici et sont partis dans
 * `/api/jellyfin/playback-state/[itemId]` : le lecteur garde cette charge-ci en mémoire pour
 * rouvrir un film instantanément, ce qui est juste pour un fichier qui ne change jamais et faux
 * pour deux valeurs qui changent entre chaque lecture. Voir la doc de `PlaybackState` pour les
 * deux symptômes que ça produisait.
 */
export interface DirectPlayInfo {
  /** Range-seekable URL for the untouched file, through this app's own proxy. */
  streamUrl: string;
  container: string;
  sizeBytes: number | null;
  runtimeSeconds: number | null;

  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    bitDepth: number | null;
    rangeType: string | null;
    isHdr: boolean;
    /** Images par seconde du fichier, d'après Jellyfin — pour que le banc d'essai voie des saccades. */
    frameRate?: number | null;
  } | null;
  audio: DirectPlayAudioTrack[];
  /**
   * La langue de tournage, quand on la tient d'une source sûre — pour la mention « (VO) ».
   *
   * Elle vient de Radarr, qui la tient de TMDB, et se trouve **déjà dans le cache du serveur** :
   * la relier à cet item ne coûte donc aucun appel réseau, seulement une recherche par
   * identifiant TMDB. Nulle pour une série, dont le chemin équivalent passerait par Sonarr et n'a
   * pas été fait — et nulle aussi quand le nom de langue n'est pas reconnu, parce qu'une mention
   * « (VO) » posée à côté de la mauvaise piste serait pire que pas de mention du tout.
   */
  originalLanguage: string | null;
  /** Null when the file can be attempted; a user-facing explanation when it cannot. */
  refusedReason: string | null;
  /**
   * Applies only if playback falls back to decoding on a canvas. The native path shows HDR
   * without converting anything, so this is enforced by the client rather than here.
   */
  canvasHdrRefusal: string | null;
  /**
   * Subtitle files sitting beside the film rather than inside it.
   *
   * Nothing in the container names them, so without this they simply do not exist for a player
   * that reads the file directly — while Jellyfin, which lists them, shows them. On this library
   * that is the difference between subtitles and none on ninety films — remeasured 2026-09-18 over
   * the full catalogue — which carry no text subtitle inside the container at all. See
   * `externalSubtitles.ts` for how that number was arrived at, and why the one it replaces was
   * too small.
   */
  externalSubtitles: ExternalSubtitle[];
  /**
   * What the viewer's Jellyfin account asks for, so this player opens on the same track their
   * other clients would. Null when the server would not say.
   */

  /** How to name this on screen — "Série — S02E05 · Titre" for an episode. Null if unknown. */
  title: string | null;
  /** Where the opening titles run, when Jellyfin has analysed the episode. Null otherwise. */
  introSkip: { start: number; end: number } | null;
  /** Where the closing credits begin, which is when the next episode is offered. */
  creditsStart: number | null;
}

export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  if (!config.player.enabled) return NextResponse.json({ error: "Lecteur intégré désactivé" }, { status: 404 });

  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  // Gated on the same per-user flag the UI toggles, checked server-side. It only ever refuses
  // now: this is the ordinary path, and the flag exists for the account that has asked to be
  // sent back to the server-side player instead.
  //
  // Honoured only where that player exists. With PLAYER_SERVER_FALLBACK off there is nothing to
  // send anyone back to, so a preference left over from before — or set through the API — would
  // refuse the only playback this install has. The interface stops offering the option in that
  // case; this is the same rule, enforced where it counts.
  if (config.player.serverFallback) {
    const prefs = userPrefsDb.getLegacyPlayer(session.jfId ?? session.u);
    if (prefs.enabled) return NextResponse.json({ error: "Lecteur legacy demandé pour ce compte" }, { status: 403 });
  }

  // Fetched together: the timestamps 404 for films and for episodes nobody has analysed, which
  // simply means no skip-intro and no next-up prompt for this one.
  const [item, timestamps, naming] = await Promise.all([
    jellyfin.getItemMediaSources(session.jfId, itemId).catch(() => null),
    jellyfin.getEpisodeTimestamps(itemId).catch(() => null),
    // Alongside the others rather than after them: naming the film must not delay showing it.
    jellyfin.getItemNaming(session.jfId, itemId).catch(() => null),
  ]);
  const source = item?.MediaSources?.[0];
  if (!source) return NextResponse.json({ error: "Fichier introuvable côté Jellyfin" }, { status: 404 });

  const streams = source.MediaStreams ?? [];
  const videoStream = streams.find((s) => s.Type === "Video") ?? null;
  // Jellyfin reports whatever ffmpeg's demuxer is called, and one demuxer covers several
  // containers: an ordinary MP4 comes back as "mov,mp4,m4a,3gp,3g2,mj2". Reading only the first
  // name called every MP4 in the library a "mov" and refused it.
  const containers = (source.Container ?? "").toLowerCase().split(",").filter(Boolean);
  const container = containers.find((name) => SUPPORTED_CONTAINERS.has(name)) ?? containers[0] ?? "";
  const rangeType = videoStream?.VideoRangeType ?? null;
  const isHdr = !!rangeType && rangeType !== "SDR";

  /**
   * Le Dolby Vision sans couche de base standard, refusé pour **tout** le lecteur natif.
   *
   * Ce refus existait, mais il ne gardait que le chemin canevas — et le commentaire ci-dessous
   * disait pourquoi : « le chemin natif aurait montré le HDR de ce fichier sans rien convertir ».
   * C'est vrai d'un HDR10, et faux d'un Dolby Vision profil 5. Le remultiplexeur reconstruit une
   * entrée `hvc1` à partir du seul `hvcC` et laisse tomber la configuration Dolby : le navigateur
   * reçoit donc ce qu'il croit être du HEVC Main 10 ordinaire, et décode une couche de base en
   * IPT-PQ comme si elle était en BT.2020. L'image sort avec des couleurs fausses — pas ternes,
   * fausses.
   *
   * Prédit en lisant le code, puis **confirmé à l'écran par Louis** le 19/09/2026 sur
   * « Disclosure Day » (profil 5.6, compatibilité 0). Deux fichiers sur 691 sont dans ce cas ;
   * les 188 autres titres Dolby Vision de cette bibliothèque sont en profil 8 avec une couche de
   * base HDR10, que ce même chemin rend correctement — en HDR10, faute de porter la
   * configuration Dolby, ce qui est exact quoique moins riche.
   *
   * **Et la décision est repassée au client.** Elle a vécu ici le temps d'un correctif, parce que
   * le serveur savait nommer le cas et que le lecteur natif ne le savait pas. Il le sait
   * maintenant — et lui seul peut poser la seule question qui décide vraiment : *ce navigateur-ci
   * accepte-t-il le Dolby Vision ?* Un appareil Apple le lit, un PC sous Chrome non, et le serveur
   * n'a aucun moyen de les distinguer. Voir `planDolbyVision`, qui porte les trois issues.
   *
   * Ce qui reste ici est la donnée, pas le verdict : `rangeType` descend jusqu'au sélecteur de
   * chemin, parce que le conteneur seul ne dit pas toujours s'il existe une couche de base.
   */
  // Refused outright unless the remuxer reads the container (Matroska or MP4).
  // Anything else — AVI above all, whose codecs no browser decodes — belongs to the server.
  const refusedReason = SUPPORTED_CONTAINERS.has(container)
    ? null
    : `Le lecteur expérimental ne lit pas les fichiers « ${container || "inconnu"} » (Matroska et MP4 seulement).`;

  // HDR is a different matter now, and the server is the wrong place to decide it. Repackaging the
  // file for the browser's own decoder carries the HDR signalling through untouched and the
  // display handles it — there is nothing to tone map and nothing to warn about. It is only the
  // canvas pipeline that has to convert the picture by hand, so this is passed down as a reason
  // that *may* apply and is enforced by the client once it knows which path it is on.
  //
  // There is no longer anything to consent to, either. Converting HDR on the GPU was once a
  // setting because it was the only way HDR played at all and it costs the picture something;
  // now the native path shows it untouched and the conversion is what happens on the fallback
  // instead of nothing. A file that cannot be converted is still refused, and says why.
  // Conservé, et désormais toujours nul en pratique : le seul cas qu'il portait est remonté dans
  // `refusedReason` ci-dessus, où il garde les deux chemins au lieu d'un. Le champ reste parce que
  // le canevas peut se voir refuser une conversion pour d'autres raisons que celle-là, et que le
  // client sait déjà quoi en faire.
  const canvasHdrRefusal: string | null = null;

  /**
   * La langue de tournage, reliée au film par son identifiant TMDB.
   *
   * `cachedMovies()` est déjà chargé — il l'est au démarrage du conteneur — donc c'est une
   * recherche en mémoire et rien d'autre. Un épisode n'a pas de correspondance ici : son chemin
   * passerait par Sonarr, et il n'a pas été fait. Toute incertitude rend `null`, et la mention
   * « (VO) » disparaît simplement.
   */
  const tmdbId = Number(naming?.ProviderIds?.Tmdb ?? "");
  const originalLanguage = Number.isFinite(tmdbId) && tmdbId > 0
    ? await cachedMovies()
        .then((films) => originalLanguageCode(films.find((f) => f.tmdbId === tmdbId)?.originalLanguage?.name))
        .catch(() => null)
    : null;

  // Text only, and external only: an image subtitle has nothing to read, and an embedded text
  // track is already found by whichever pipeline opens the file.
  const externalSubtitles: ExternalSubtitle[] = streams
    .filter((s) => s.Type === "Subtitle" && s.IsExternal && TEXT_SUBTITLE_FORMATS.has((s.Codec ?? "").toLowerCase()))
    .map((s) => ({
      id: -1 - s.Index,
      language: s.Language ?? null,
      title: s.DisplayTitle ?? null,
      url: `/api/jellyfin/stream/subtitle/${itemId}?mediaSourceId=${encodeURIComponent(source.Id ?? itemId)}&index=${s.Index}`,
    }));

  const payload: DirectPlayInfo = {
    // The same static endpoint DirectPlay already uses: the proxy forwards Range headers for it,
    // which is exactly what a demuxer jumping around a 40 GB file needs.
    streamUrl: `/api/jellyfin/stream/${itemId}/stream.${container || "mkv"}?static=true&mediaSourceId=${source.Id}`,
    container,
    // Ce que Jellyfin sait de la taille du fichier. Le lecteur s'en sert pour ouvrir le flux sans
    // la redemander par un HEAD ; nul si Jellyfin ne la donne pas, et le HEAD revient.
    sizeBytes: typeof source.Size === "number" && Number.isFinite(source.Size) && source.Size > 0 ? source.Size : null,
    runtimeSeconds: item?.RunTimeTicks ? item.RunTimeTicks / 10_000_000 : null,
    video: videoStream
      ? {
          codec: videoStream.Codec ?? null,
          width: videoStream.Width ?? null,
          height: videoStream.Height ?? null,
          bitDepth: videoStream.BitDepth ?? null,
          rangeType,
          frameRate: videoStream.AverageFrameRate ?? null,
          isHdr,
        }
      : null,
    audio: streams
      .filter((s) => s.Type === "Audio")
      .map((s) => ({
        index: s.Index,
        codec: s.Codec ?? "",
        language: s.Language ?? null,
        displayTitle: s.DisplayTitle ?? null,
        channels: s.Channels ?? null,
        isDefault: s.IsDefault ?? false,
        profile: s.Profile ?? null,
      })),
    originalLanguage,
    refusedReason,
    canvasHdrRefusal,
    externalSubtitles,
    title: naming ? displayTitle(naming, "") || null : null,
    introSkip: timestamps?.Introduction?.Valid
      ? { start: timestamps.Introduction.Start, end: timestamps.Introduction.End }
      : null,
    creditsStart: timestamps?.Credits?.Valid ? timestamps.Credits.Start : null,
  };

  return NextResponse.json(payload);
}
