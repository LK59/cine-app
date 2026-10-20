import { videoTranscodingAllowed } from "@/lib/transcodePolicy";
import { notePrewarmSession } from "@/lib/prewarmSessions";
import { publicOrigin } from "@/lib/publicOrigin";
import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { playerMarkers } from "@/lib/episodeMarkers";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";
import { playbackDevice } from "@/lib/playbackDevice";
import { HttpError } from "@/lib/http";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { stripAccessToken } from "@/lib/stripAccessToken";
import { audioNeedsReencode, buildChromecastProfile, buildDeviceProfile, castRefusalFor, castTargetOf, chosenAudioStream } from "@/lib/deviceProfile";
import type { CodecSupport } from "@/lib/codecSupport";
import { cachedMovies } from "@/lib/server-cache";
import { originalLanguageCode } from "@/lib/originalLanguage";
import { displayTitle } from "@/lib/displayTitle";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { signCastToken, CAST_TOKEN_PARAM } from "@/lib/castToken";
import { masterVariantFacts } from "@/lib/playbackPanel";
import { forwardedFor } from "@/lib/clientAddress";
import { transcodeTargetBps } from "@/lib/slowLink";

// Both "no Jellyfin identity in session" and "Jellyfin rejected our stored
// token" boil down to the same user-facing action: log back in with Jellyfin
// credentials. A single status + code lets the client show one clear message
// instead of a dead-end error (see PlayerHost + /login?reason=playback).
function reauthRequired() {
  return NextResponse.json(
    { error: "Ta session Jellyfin a expiré", code: "jellyfin_reauth_required" },
    { status: 401 }
  );
}

// TranscodeReasons only ever comes back embedded in TranscodingUrl's own query string in this
// Jellyfin version (verified against the real server — MediaSourceInfo has no such field of
// its own), never as a separate JSON field — so it has to be parsed out of the URL rather than
// read directly.
function parseTranscodingUrlInfo(transcodingUrl: string): { videoCodecs: string[]; reasons: string[]; streamBitrate: number | null } {
  const parsed = new URL(transcodingUrl, "http://internal");
  const videoCodecs = (parsed.searchParams.get("VideoCodec") ?? "").split(",").filter(Boolean);
  const reasons = (parsed.searchParams.get("TranscodeReasons") ?? "").split(",").filter(Boolean);
  // Le débit que ffmpeg vise (vidéo + son), écrit par Jellyfin dans l'adresse : celui du flux envoyé,
  // que `MediaStreams` (la source) ne dit pas — voir `streamNeedBps`.
  const videoBitrate = Number(parsed.searchParams.get("VideoBitrate"));
  const audioBitrate = Number(parsed.searchParams.get("AudioBitrate"));
  const streamBitrate =
    Number.isFinite(videoBitrate) && videoBitrate > 0 ? videoBitrate + (Number.isFinite(audioBitrate) && audioBitrate > 0 ? audioBitrate : 0) : null;
  return { videoCodecs, reasons, streamBitrate };
}

// Jellyfin's PlayMethod isn't handed to us directly by PlaybackInfo (unlike /Sessions, which
// only exists once playback has actually started) — the client is expected to derive it, same
// as jellyfin-web: DirectPlay when the source plays untouched, otherwise DirectStream when the
// video stream itself is copied (not re-encoded), otherwise a real Transcode.
//
// Two signals, crossed — neither alone is right, and each catches what the other misses.
//
// TranscodeReasons alone mis-predicts: the exact same file, negotiated for two different
// browsers, produced TranscodeReasons with no Video* entry in both cases, yet one browser's
// actual ffmpeg job did `-codec:v:0 copy` (a real DirectStream) while the other's did a full
// `-codec:v:0 h264_qsv` re-encode (a real Transcode). So the codec comparison stays: the source's
// own video codec against the VideoCodec list Jellyfin was asked to accept.
//
// But that comparison alone is wrong the other way round, and this is the case it got wrong:
// VideoCodec in TranscodingUrl is the list of codecs the client ACCEPTS, not the one ffmpeg will
// PRODUCE. On a device whose `mp4/hevc10` probe says no, a 10-bit HEVC file negotiates with
// VideoCodec=[h264,hevc] — `hevc` is still there, so the comparison said "copied" — while
// TranscodeReasons carried VideoBitDepthNotSupported, i.e. the server saying it will re-encode.
// Verified live on `(500) jours ensemble` against this installation's server.
//
// Hence: an explicit video-level reason wins over the codec comparison. The list below is closed
// and deliberate — ContainerNotSupported and the Audio* reasons are NOT in it, which is what
// preserves the genuine DirectStream (container remux, video copied) the codec comparison exists
// to catch.
const VIDEO_TRANSCODE_REASONS = new Set([
  "VideoCodecNotSupported",
  "VideoBitDepthNotSupported",
  "VideoProfileNotSupported",
  "VideoLevelNotSupported",
  "VideoResolutionNotSupported",
  "VideoBitrateNotSupported",
  "VideoRangeTypeNotSupported",
  "VideoFramerateNotSupported",
  "AnamorphicVideoNotSupported",
  "InterlacedVideoNotSupported",
]);
/** Le débit de la source (vidéo + son retenu), ou `null` sans débit vidéo connu. */
function sourceBitrate(video: number | null | undefined, audio: number | null | undefined): number | null {
  if (typeof video !== "number" || !(video > 0)) return null;
  return video + (typeof audio === "number" && audio > 0 ? audio : 0);
}

type PlayMethod = "DirectPlay" | "DirectStream" | "Transcode";
function derivePlayMethod(isDirectPlay: boolean, isVideoCopied: boolean): PlayMethod {
  if (isDirectPlay) return "DirectPlay";
  return isVideoCopied ? "DirectStream" : "Transcode";
}

export async function POST(req: NextRequest) {
  if (!config.player.enabled) {
    return NextResponse.json({ error: "Lecteur intégré désactivé" }, { status: 404 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (!session?.jfId || !session?.jfToken) {
    return reauthRequired();
  }

  const body = await req.json().catch(() => null);
  const itemId = body?.itemId as string | undefined;
  const maxBitrate = Number(body?.maxBitrate) || 8_000_000;
  const audioStreamIndex = body?.audioStreamIndex as number | undefined;
  const subtitleStreamIndex = body?.subtitleStreamIndex as number | undefined;
  const startTicks = body?.startTicks as number | undefined;
  const codecSupport = (body?.codecSupport as CodecSupport | undefined) ?? { video: {}, audio: {} };
  // Client-driven audio-codec exclusions, on top of the browser's own claimed support: real
  // playback attempts are the only trustworthy probe of what a device actually decodes (its
  // canPlayType can overreport — verified live with an iPhone claiming E-AC-3 support whose
  // native HLS pipeline then rejects any ec-3 stream). The client's fallback ladder retries a
  // failed load with codecs disabled here, which makes Jellyfin negotiate a genuine server-side
  // audio transcode to a codec the device has actually proven it can play.
  // Whether the client will play the HLS stream with the browser's own pipeline (Safari, iOS)
  // rather than hls.js. Defaults to TRUE when absent, so a client from before this field existed
  // keeps the pre-warm it has always had — see where it's used below.
  const nativeHls = body?.nativeHls !== false;
  /**
   * Ce flux part-il vers un téléviseur ?
   *
   * Deux conséquences, et aucune n'est cosmétique : les sous-titres doivent voyager **dans** le
   * manifeste (le récepteur ne voit rien de ce que la page dessine), et l'adresse doit être
   * absolue et porter son laissez-passer, puisque c'est le téléviseur qui ira la chercher, sans
   * notre cookie.
   */
  /**
   * Vers un Chromecast (DECISIONS.md §64) : son propre profil, prudent, au lieu de celui de la page
   * — `buildChromecastProfile`. Absent, tout ce qui suit est exactement ce qu'il était, AirPlay
   * compris. Un Chromecast est toujours une diffusion.
   */
  const castTarget = castTargetOf(body?.castTarget);
  const forCast = body?.forCast === true || castTarget !== null;
  /**
   * Une lecture du banc d'essai : rien n'est annoncé à Jellyfin.
   *
   * Le banc saute à la fin des films ; annoncée, la séance aurait pu marquer le film vu et poser
   * une reprise au milieu de nulle part sur le compte qui le lance — c'est la règle de
   * `PlaybackSession.bench`, que le lecteur natif tenait et que ce chemin ignorait (27/09/2026).
   */
  const bench = body?.bench === true;
  /**
   * Une scène ouverte depuis une réplique (DECISIONS.md §91) : pas d'annonce non plus — elle ferait
   * entrer le titre dans « Reprendre ». Le lecteur l'annoncera lui-même si la scène devient une
   * lecture ordinaire (dix minutes jouées, `sceneMode.ts`).
   */
  const scene = body?.scene === true;
  /**
   * Le dernier échelon de l'échelle de repli du client : le son ré-encodé, quel qu'il soit.
   *
   * L'échelon « AAC seul » supposait l'AAC toujours lisible ; il ne l'est pas quand sa disposition
   * est un PCE, et les quatre essais finissaient sur le même refus. Celui-ci ne copie plus rien.
   */
  const forceAudioTranscode = body?.forceAudioTranscode === true;
  /**
   * La « version allégée » (DECISIONS.md §78) : HEVC ou H.264, SDR, 1080p au plus, au débit demandé —
   * le profil le décide (`buildDeviceProfile`, `lighter`). Absente, le profil est l'ordinaire.
   */
  const lighter = body?.lighter === true;
  /**
   * Un préchauffage (§78, `lighterPrewarm.ts`) : la négociation est faite, mais rien n'est annoncé à
   * Jellyfin — ce n'est pas encore une lecture. Le lecteur serveur l'annoncera s'il la reprend.
   */
  const prewarm = body?.prewarm === true;
  /**
   * Le recours de l'image (`H264_RUNG`, PlayerHost) : seul le H.264 est déclaré, et Jellyfin
   * ré-encode toute autre image. Pour un appareil qui annonce le HEVC et ne le décode plus — un
   * Android 10 dont le décodeur HEVC s'est bloqué un soir (19/10/2026) : chaque titre HEVC, film 4K
   * comme épisode 1080p, finissait en erreur de décodage, et l'échelle du son rejouait la même image.
   * Par le profil de la version allégée (§78) — sans HEVC déclaré, il donne du H.264 en SDR, 1080p au
   * plus : la forme que tout décodeur matériel tient, et un ré-encodage que Jellyfin sait déjà faire.
   */
  const videoH264Only = body?.videoH264Only === true;
  const disableAudioCodecs = Array.isArray(body?.disableAudioCodecs)
    ? (body.disableAudioCodecs as unknown[]).filter((c): c is string => typeof c === "string" && /^[a-z0-9]{1,16}$/.test(c))
    : [];

  if (!isJellyfinId(itemId)) {
    return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  }

  try {
    const effectiveSupport: CodecSupport = {
      video: videoH264Only ? { "mp4/h264": true } : codecSupport.video,
      audio: Object.fromEntries(
        Object.entries(codecSupport.audio ?? {}).map(([codec, ok]) => [codec, disableAudioCodecs.includes(codec) ? false : ok])
      ),
    };
    const { jfId, jfToken } = session;
    const item = itemId;
    const negotiate = (reencodeAudio: "stereo" | "surround" | undefined) =>
      jellyfin.getPlaybackInfo(jfId, item, jfToken, {
        maxBitrate,
        mediaSourceId: item,
        audioStreamIndex,
        subtitleStreamIndex,
        startTicks,
        deviceProfile: castTarget
          ? buildChromecastProfile(maxBitrate, { reencodeAudio })
          : buildDeviceProfile(effectiveSupport, maxBitrate, { subtitlesInStream: forCast, reencodeAudio, ...(lighter || videoH264Only ? { lighter: { targetBps: maxBitrate } } : {}) }),
      });
    let info = await negotiate(forceAudioTranscode ? "stereo" : undefined);
    // Un son que Jellyfin copierait et que le navigateur refuserait — l'AAC à PCE, voir
    // `audioNeedsReencode` : renégocié aussitôt, ré-encodé en 5.1 standard (`"surround"`, voir
    // `reencodeAudio`). Une seconde demande à Jellyfin pour ces fichiers-là seulement, plutôt que
    // quatre essais perdus et une erreur au bout de vingt secondes (« Elle s'appelle Ruby », Fire TV,
    // 10/10/2026).
    if (!forceAudioTranscode && audioNeedsReencode(chosenAudioStream(info.MediaSources?.[0], audioStreamIndex))) {
      info = await negotiate("surround");
    }
    const source = info.MediaSources?.[0];
    if (!source) {
      return NextResponse.json({ error: "Jellyfin n'a renvoyé aucun flux" }, { status: 502 });
    }

    // Refusé avant d'avoir lancé quoi que ce soit : un sous-titre image forcerait Jellyfin à
    // ré-encoder la vidéo pour l'incruster, et la diffusion perdrait la seule chose qui la rend
    // acceptable — l'image copiée telle quelle. Le dire vaut mieux que le faire en silence.
    // Pas pour un Chromecast : son image est souvent transcodée de toute façon, et il reçoit le
    // sous-titre en images incrusté — voir `buildChromecastProfile`.
    if (forCast && !castTarget) {
      const refusal = castRefusalFor(source.MediaStreams, subtitleStreamIndex);
      if (refusal) return NextResponse.json({ error: "cast-refused", code: refusal }, { status: 409 });
    }

    const isDirectPlay = source.SupportsDirectPlay === true;

    let manifestUrl: string;
    let videoCodecs: string[] = [];
    let transcodeReasons: string[] = [];
    let streamBitrate: number | null = null;
    let served: { codecs: string | null; videoRange: string | null } | null = null;

    if (isDirectPlay) {
      // No TranscodingUrl is returned for DirectPlay — jellyfin-web builds this same static
      // endpoint itself; we just re-root it under our own stream proxy like the HLS case below,
      // so the browser never talks to Jellyfin directly.
      const container = (source.Container ?? "mp4").split(",")[0];
      manifestUrl = `/api/jellyfin/stream/${itemId}/stream.${container}?static=true&mediaSourceId=${source.Id}`;
      videoCodecs = (source.MediaStreams ?? [])
        .filter((s) => s.Type === "Video")
        .map((s) => s.Codec)
        .filter((c): c is string => !!c);
    } else {
      if (!source.TranscodingUrl) {
        return NextResponse.json({ error: "Jellyfin n'a renvoyé aucun flux" }, { status: 502 });
      }
      // TranscodingUrl is a Jellyfin-relative path like "/videos/{itemId}/master.m3u8?...",
      // but Jellyfin writes the id there in dashed UUID form while ours is the bare
      // 32-char hex used everywhere else in the app — match generically instead of
      // rebuilding its dashed form. Keep only what comes after that prefix and re-root
      // it under our own stream proxy, so the browser never talks to Jellyfin directly.
      const parsed = new URL(source.TranscodingUrl, "http://internal");
      const restPath = parsed.pathname.replace(/^\/videos\/[0-9a-f-]{32,36}\//i, "");
      // Sans le jeton que Jellyfin y a écrit (`ApiKey=`) : le relais signe lui-même chaque requête,
      // et cette adresse finit dans la page, l'historique et le journal du relais inverse — voir
      // `stripAccessToken`.
      manifestUrl = `/api/jellyfin/stream/${itemId}/${restPath}${stripAccessToken(parsed.search)}`;
      ({ videoCodecs, reasons: transcodeReasons, streamBitrate } = parseTranscodingUrlInfo(source.TranscodingUrl));
      // Un préchauffage (§78) : sa séance est retenue pour ce compte — la route d'arrêt `prewarm` ne
      // coupera qu'elle, sous l'appareil que Jellyfin a écrit dans l'adresse.
      const prewarmDevice = parsed.searchParams.get("DeviceId");
      if (prewarm && prewarmDevice && info.PlaySessionId) notePrewarmSession(session.jfId, info.PlaySessionId, prewarmDevice);

      // Found live: a track switch that needs a genuine transcode (not just a remux copy — e.g.
      // Dolby TrueHD/Atmos audio, which nothing in our codec-support detection claims, forcing a
      // real re-encode down to AAC/AC3 alongside the video) took long enough for Jellyfin to spin
      // up a fresh ffmpeg job that the client's own request for the manifest timed out client-side
      // before ever getting a response — Safari's native HLS bootstrap appears far less patient
      // for this than hls.js, which is why Firefox never surfaced it. Pre-fetching the manifest
      // ourselves, server-side, before responding to the client absorbs that startup cost here —
      // by the time the client makes its own request through the proxy, ffmpeg is already running
      // and Jellyfin can answer near-instantly. Best-effort and bounded: if this itself times out,
      // fall through anyway and let the client's own request (plus the proxy's existing retry) be
      // the fallback, rather than hanging the whole "start playback" action indefinitely.
      //
      // Only for the clients it was written for. On the hls.js path this wait buys nothing — that
      // library retries a slow first manifest on its own, patiently, which is exactly why Firefox
      // never hit the bug — and blocking here delays the response that lets the browser get on
      // with downloading hls.js itself. Skipping it there lets ffmpeg warm up in parallel with
      // that download instead of in front of it. Safari's behaviour is unchanged.
      if (nativeHls) {
        try {
          const warmup = await fetch(`${config.jellyfin.url}${source.TranscodingUrl}`, {
            headers: { ...jellyfinAuthHeaders(session.jfToken), ...(await forwardedFor()) },
            signal: AbortSignal.timeout(15_000),
          });
          // Read it to completion (a ~700 byte playlist) rather than dropping the response on the
          // floor: an unconsumed body holds its connection open until the GC gets to it.
          const master = await warmup.text().catch(() => "");
          // Ce que ce maître annonce, pour le panneau d'infos techniques (le lecteur HLS natif ne le dit pas).
          if (warmup.ok) served = masterVariantFacts(master);
        } catch {
          // Fall through — see comment above.
        }
      }
    }

    const videoStream = (source.MediaStreams ?? []).find((s) => s.Type === "Video") ?? null;
    const forcedByReason = transcodeReasons.some((r) => VIDEO_TRANSCODE_REASONS.has(r));
    const isVideoCopied =
      isDirectPlay || (!forcedByReason && !!videoStream?.Codec && videoCodecs.includes(videoStream.Codec));
    const playMethod = derivePlayMethod(isDirectPlay, isVideoCopied);

    const audioStreamForPlayback = (source.MediaStreams ?? []).find(
      (s) => s.Type === "Audio" && (audioStreamIndex === undefined || s.Index === audioStreamIndex)
    );

    // External VTT delivery works the same regardless of PlayMethod (Jellyfin extracts embedded
    // subtitles server-side on demand, via the SubtitleProfiles "External" method declared in
    // deviceProfile.ts) — this is the client's primary subtitle source in every case, with
    // real DisplayTitle/Language from the source file rather than hls.js's own less complete
    // SUBTITLE_TRACKS_UPDATED-derived names.
    /**
     * Le laissez-passer, signé une fois et porté aussi par les sous-titres.
     *
     * Une diffusion ne donne au téléviseur que des adresses ; il ira chercher lui-même les pistes
     * de sous-titres, sans notre cookie. Sans jeton dessus, chacune lui répondait 401 — ce qui se
     * voyait comme une liste réduite à ce qu'il devinait tout seul. Signé ici, à côté de l'adresse
     * du manifeste, plutôt que deux fois : c'est le même titre et le même spectateur.
     */
    // Signé pour toute lecture, et non plus seulement pour une diffusion demandée : voir `castUrl`.
    // Hors diffusion demandée, un échec de signature ne coûte que l'AirPlay des commandes de la
    // vidéo — jamais la lecture elle-même (voir `castUrl`).
    // Lié à la session qui le demande : il meurt avec elle — voir `CastClaims.s`.
    const castPass = forCast
      ? await signCastToken(itemId, session.u, Date.now(), session.jti, session.jfId)
      : await signCastToken(itemId, session.u, Date.now(), session.jti, session.jfId).catch(() => null);
    /**
     * Les **faits** des pistes, et non une étiquette déjà écrite.
     *
     * Cette route composait le libellé du menu à partir du `DisplayTitle` de Jellyfin — « French -
     * Dolby Digital - 5.1 - Par défaut ». Le lecteur natif, lui, écrit « Français — 5.1 » depuis
     * `src/lib/trackLabel.ts`. Deux vocabulaires pour les mêmes pistes, et le second s'affiche
     * précisément quand on vient de basculer depuis le premier : au moment où quelque chose s'est
     * mal passé, le menu se mettait à parler autrement.
     *
     * L'étiquette se construit donc côté navigateur, parce que lui seul sait dans quelle langue
     * l'interface est réglée. Ici on n'envoie que ce qui vient du fichier.
     */
    const subtitleTracks = (source.MediaStreams ?? [])
      .filter((s) => s.Type === "Subtitle")
      .map((s) => ({
        index: s.Index,
        language: s.Language ?? null,
        title: s.Title ?? null,
        isDefault: s.IsDefault ?? false,
        isForced: s.IsForced ?? false,
        isHearingImpaired: s.IsHearingImpaired ?? false,
        isExternal: s.IsExternal ?? false,
        // Pour un Chromecast seulement : une piste texte s'allume sur le récepteur sans relancer le
        // flux, une piste en images doit être incrustée par le serveur — voir `ChromecastPlayer`.
        // Absent ailleurs, pour que la réponse des autres lecteurs reste ce qu'elle était.
        ...(castTarget ? { isText: s.IsTextSubtitleStream ?? null } : {}),
        url:
          `/api/jellyfin/stream/subtitle/${itemId}?mediaSourceId=${source.Id}&index=${s.Index}` +
          (castPass ? `&${CAST_TOKEN_PARAM}=${encodeURIComponent(castPass)}` : ""),
      }));

    const audioTracks = (source.MediaStreams ?? [])
      .filter((s) => s.Type === "Audio")
      .map((s) => ({
        index: s.Index,
        language: s.Language ?? null,
        title: s.Title ?? null,
        codec: s.Codec ?? null,
        channels: s.Channels ?? null,
        profile: s.Profile ?? null,
        isDefault: s.IsDefault ?? false,
      }));

    // Best-effort: a failed "now playing" report shouldn't block playback itself.
    // Same for intro/credits timestamps — 404s for movies and unanalyzed
    // episodes, which just means no skip-intro / next-up prompt for this item.
    const [, timestamps, naming, transcodingAllowed] = await Promise.all([
      bench || prewarm || scene
        ? Promise.resolve()
        : jellyfin
            // Sous l'appareil de la connexion, comme les rapports qui suivront — `playbackDevice.ts`.
            .reportPlaybackStart(session.jfId, itemId, session.jfToken, info.PlaySessionId, source.Id, playMethod, PLAYBACK_CLIENTS.stable, playbackDevice(req, session.jti))
            .catch(() => {}),
      jellyfin.getEpisodeTimestamps(itemId).catch(() => null),
      // Alongside the others, so naming the film costs nothing on the way to its first frame.
      jellyfin.getItemNaming(session.jfId, itemId).catch(() => null),
      // La version allégée est un transcodage vidéo : permis au compte, ou pas proposée (§78).
      config.player.serverFallback ? videoTranscodingAllowed(session.jfId) : Promise.resolve(false),
    ]);

    /**
     * La langue de tournage, reliée au film par son identifiant TMDB — voir la route « direct ».
     *
     * Recherche en mémoire dans le cache Radarr, qui est chargé au démarrage du conteneur : aucun
     * appel réseau. Toute incertitude — série, film absent du catalogue, langue non reconnue —
     * rend `null`, et le lecteur n'affiche alors aucune mention.
     */
    const tmdbId = Number(naming?.ProviderIds?.Tmdb ?? "");
    const originalLanguage =
      Number.isFinite(tmdbId) && tmdbId > 0
        ? await cachedMovies()
            .then((films) => originalLanguageCode(films.find((f) => f.tmdbId === tmdbId)?.originalLanguage?.name))
            .catch(() => null)
        : null;

    const { introSkip, recapSkip, creditsStart } = playerMarkers(timestamps);

    /**
     * Pour un téléviseur, l'adresse doit être complète et porter son laissez-passer.
     *
     * **Absolue** : une adresse relative n'a de sens que pour qui connaît la page d'où elle vient.
     * Le récepteur n'a que la chaîne qu'on lui tend.
     *
     * **Signée** : il ira la chercher sans notre cookie. Le laissez-passer n'ouvre que ce titre,
     * en lecture, six heures — voir `castToken`. Le proxy de flux reportera ensuite ce même jeton
     * dans chaque segment que le manifeste désigne, sans quoi la lecture s'arrêterait au bout de
     * deux secondes.
     *
     * L'origine vient des en-têtes du mandataire inverse, qui est le seul à savoir sous quel nom
     * le monde extérieur joint cette application — `nextUrl.origin` ne connaît que le conteneur.
     *
     * **Pour toute lecture** depuis le 24/09/2026, et non plus seulement quand la diffusion est
     * demandée par l'application. Le bouton AirPlay des commandes de la vidéo marche partout : une
     * lecture ouverte sur le téléphone puis envoyée à la télé de là tendait au téléviseur l'adresse
     * relative et sans jeton. Il a essuyé 624 refus en une heure, iOS a relayé la vidéo par le
     * téléphone, et l'image sautait ; relancée par « Diffuser », la même télé a tout reçu.
     */
    let castUrl: string | null = null;
    try {
      if (castPass) {
        const separator = manifestUrl.includes("?") ? "&" : "?";
        castUrl = `${publicOrigin(req)}${manifestUrl}${separator}${CAST_TOKEN_PARAM}=${encodeURIComponent(castPass)}`;
      }
    } catch (error) {
      // Une lecture ordinaire se passe de l'adresse signée : l'élément reçoit alors `manifestUrl`,
      // comme avant. Une diffusion demandée, non — elle n'aurait rien à tendre au téléviseur.
      if (forCast) throw error;
    }

    return NextResponse.json({
      playSessionId: info.PlaySessionId,
      mediaSourceId: source.Id,
      manifestUrl,
      /** L'adresse que l'élément reçoit, et que le téléviseur ira chercher s'il la prend. */
      castUrl,
      isDirectPlay,
      /** La « version allégée » est-elle possible pour ce compte (§78) ? */
      lighterAllowed: transcodingAllowed,
      /**
       * Le débit du fichier d'origine, en pleine qualité (§78) : ce que le lien doit retrouver, pendant
       * une version allégée, pour que la lecture suivante revienne au lecteur natif.
       */
      sourceBitrateBps: typeof source.Bitrate === "number" && source.Bitrate > 0 ? source.Bitrate : null,
      subtitleTracks,
      audioTracks,
      /**
       * La langue de tournage, pour la mention « (VO) » — la même que sur le lecteur natif.
       *
       * Reliée au film par son identifiant TMDB, dans le cache Radarr déjà chargé : aucun appel
       * réseau, et l'item est déjà demandé ici pour nommer le titre. Nulle pour une série.
       */
      originalLanguage,
      introSkip,
      recapSkip,
      creditsStart,
      /** "Série — S02E05 · Titre", from the server rather than from whoever opened the player. */
      title: naming ? displayTitle(naming, "") || null : null,
      // Everything below is purely for the Playback Info panel (Phase 4) — no extra request,
      // all derived from the PlaybackInfo response already fetched above.
      playbackInfo: {
        playMethod,
        transcodeReasons,
        container: source.Container ?? null,
        requestedVideoCodecs: videoCodecs,
        video: videoStream && {
          codec: videoStream.Codec ?? null,
          profile: videoStream.Profile ?? null,
          width: videoStream.Width ?? null,
          height: videoStream.Height ?? null,
          bitDepth: videoStream.BitDepth ?? null,
          frameRate: videoStream.AverageFrameRate ?? null,
          bitRate: videoStream.BitRate ?? null,
          rangeType: videoStream.VideoRangeType ?? null,
        },
        audio: audioStreamForPlayback && {
          codec: audioStreamForPlayback.Codec ?? null,
          channels: audioStreamForPlayback.Channels ?? null,
          bitRate: audioStreamForPlayback.BitRate ?? null,
          language: audioStreamForPlayback.Language ?? null,
        },
        // Le flux envoyé quand Jellyfin transcode — voir `streamNeedBps` et le panneau (« Diffusé »).
        // Une vidéo copiée ignore le débit visé : rien hors transcodage. Notre plafond recopié par
        // Jellyfin n'est pas un débit visé (`transcodeTargetBps`, LECTEUR-9 : « 100 Mb/s » pour un
        // fichier de 2,5).
        streamBitrate:
          playMethod === "Transcode"
            ? transcodeTargetBps(streamBitrate, {
                maxBitrate,
                lighter,
                sourceBps: sourceBitrate(videoStream?.BitRate, audioStreamForPlayback?.BitRate),
              })
            : null,
        served,
      },
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      return reauthRequired();
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur Jellyfin" },
      { status: 502 }
    );
  }
}
