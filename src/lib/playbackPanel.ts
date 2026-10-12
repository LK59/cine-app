import type { PlaybackPanelData, PanelSection } from "@/components/PlaybackInfoPanel";
import type { LinkReading } from "@/lib/slowLink";
import { formatTime } from "@/lib/playerClock";

/** La fonction de traduction, passée plutôt qu'appelée : ces constructeurs restent purs. */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Toutes les valeurs de `TranscodeReasons` que Jellyfin sait produire et que l'app sait traduire. */
const KNOWN_REASONS = new Set([
  "ContainerNotSupported", "VideoCodecNotSupported", "AudioCodecNotSupported",
  "SubtitleCodecNotSupported", "VideoProfileNotSupported", "VideoLevelNotSupported",
  "VideoResolutionNotSupported", "VideoBitDepthNotSupported", "VideoFramerateNotSupported",
  "VideoRangeTypeNotSupported", "AudioChannelsNotSupported", "AudioProfileNotSupported",
  "AnamorphicVideoNotSupported", "InterlacedVideoNotSupported", "RefFramesNotSupported",
  "ContainerBitrateExceedsLimit", "VideoBitrateNotSupported", "AudioBitrateNotSupported",
  "DirectPlayError",
]);

export function formatBitrate(bitRate: number | null | undefined): string {
  if (!bitRate) return "—";
  return `${(bitRate / 1_000_000).toFixed(1)} Mb/s`;
}

/** Une section sans ligne utile ne vaut pas son titre. */
function section(title: string, rows: { label: string; value: string | null }[]): PanelSection {
  return { title, rows: rows.filter((r) => r.value !== null).map((r) => ({ label: r.label, value: r.value! })) };
}

/**
 * Le lien vers cet appareil (§77) : le débit réellement reçu, ce que le flux demande, et le verdict
 * par le critère même de l'abandon — en direct, ou figé au moment d'un échec. Rien quand il n'y a
 * aucune mesure (Safari lit son HLS lui-même et n'en dit rien).
 */
function linkRows(link: LinkReading | null | undefined, t: Translate): { label: string; value: string | null }[] {
  if (!link || (link.recvBps === null && link.verdict === "unknown" && !link.frozen)) return [];
  const verdict =
    link.verdict === "ok" ? t("player.info.linkOk") : link.verdict === "slow" ? t("player.info.linkSlow") : t("player.info.linkUnknown");
  return [
    { label: t("player.info.linkReceived"), value: link.recvBps !== null ? formatBitrate(Math.max(link.recvBps, 1)) : "—" },
    { label: t("player.info.linkNeeded"), value: link.needBps !== null ? formatBitrate(link.needBps) : null },
    { label: t("player.info.linkVerdict"), value: link.frozen ? `${verdict} · ${t("player.info.linkFrozen")}` : verdict },
    // Le palier de version allégée en cours (§78) — le débit demandé à Jellyfin, pas le reçu.
    {
      label: t("player.info.linkLighter"),
      value: link.lighter ? t("player.info.linkLighterValue", { tier: link.lighter.tier, rate: formatBitrate(link.lighter.targetBps) }) : null,
    },
  ];
}

export interface JellyfinPlayback {
  playMethod: "DirectPlay" | "DirectStream" | "Transcode";
  transcodeReasons: string[];
  container: string | null;
  /** Le fichier d'origine — `MediaStreams` de Jellyfin décrit la source, jamais ce qu'il envoie. */
  video: {
    codec: string | null; profile: string | null; width: number | null; height: number | null;
    bitDepth: number | null; frameRate: number | null; bitRate: number | null;
    /** `VideoRangeType` de la source (SDR, HDR10, DOVIWithHDR10…). */
    rangeType?: string | null;
  } | null;
  audio: { codec: string | null; channels: number | null; bitRate: number | null; language: string | null } | null;
  /**
   * Le débit que Jellyfin vise pour un transcodage (`VideoBitrate` + `AudioBitrate` de son adresse) —
   * le flux réellement envoyé. Absent hors transcodage : une vidéo copiée ignore ce chiffre.
   */
  streamBitrate?: number | null;
}

/**
 * Ce que le lecteur serveur reçoit réellement quand Jellyfin transcode (§78) : codecs et plage tels que
 * la liste maître les annonce (`CODECS`, `VIDEO-RANGE` — hls.js les lit, Safari HLS natif : la route
 * les lit dans le maître qu'elle préchauffe déjà), et la taille que le navigateur décode
 * (`videoWidth × videoHeight`). Toute valeur inconnue reste `null` : sa ligne n'est pas affichée.
 */
export interface ServedStream {
  videoCodec: string | null;
  audioCodec: string | null;
  /** `VIDEO-RANGE` du maître : SDR, PQ, HLG. */
  videoRange: string | null;
  width: number | null;
  height: number | null;
}

/**
 * D'où vient la version allégée en cours : une bascule de cette séance (natif → serveur, ou palier
 * renégocié ; `at` : la position où elle a eu lieu, `null` si on ne la connaît pas), ou la règle des
 * deux minutes (`inherited`).
 */
export type LighterOrigin = { kind: "switch"; at: number | null } | { kind: "inherited" };

/** Un nom lisible pour un codec — `hvc1.2.4.L150.B0` → HEVC, `mp4a.40.2` → AAC ; inconnu : tel quel. */
export function codecName(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const c = value.toLowerCase();
  if (/^(dvh1|dvhe)/.test(c)) return "HEVC (Dolby Vision)";
  if (/^(hvc1|hev1|hevc|h265)/.test(c)) return "HEVC";
  if (/^(avc1|avc3|h264)/.test(c)) return "H.264";
  if (/^(av01|av1)/.test(c)) return "AV1";
  if (/^(vp09|vp9)/.test(c)) return "VP9";
  if (/^mp4a\.(69|6b)|^mp3/.test(c)) return "MP3";
  if (/^mp4a|^aac/.test(c)) return "AAC";
  if (/^(ac-3|ac3)$/.test(c)) return "AC-3";
  if (/^(ec-3|eac3)$/.test(c)) return "E-AC-3";
  if (c === "opus") return "Opus";
  if (c === "flac") return "FLAC";
  if (c === "alac") return "ALAC";
  return value;
}

const VIDEO_CODEC = /^(dvh1|dvhe|hvc1|hev1|hevc|h265|avc1|avc3|h264|av01|av1|vp09|vp9|vp8)/i;

/** L'attribut `CODECS` d'une variante (« hvc1.2.4.L150.B0,mp4a.40.2 ») partagé entre vidéo et son. */
export function splitCodecs(codecs: string | null | undefined): { video: string | null; audio: string | null } {
  const parts = (codecs ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const video = parts.find((p) => VIDEO_CODEC.test(p)) ?? null;
  const audio = parts.find((p) => !VIDEO_CODEC.test(p)) ?? null;
  return { video, audio };
}

/**
 * Ce que la liste maître annonce de sa première variante — codecs et plage dynamique du flux
 * réellement envoyé (`CODECS`, `VIDEO-RANGE`). Lu dans le maître que la route préchauffe déjà pour
 * Safari : aucune requête de plus. Le profil du `CODECS` peut être celui de la source (§78) ; seule la
 * famille du codec est montrée.
 */
export function masterVariantFacts(master: string): { codecs: string | null; videoRange: string | null } | null {
  const line = master.split(/\r?\n/).find((l) => l.startsWith("#EXT-X-STREAM-INF:"));
  if (!line) return null;
  const codecs = /CODECS="([^"]{1,200})"/.exec(line)?.[1] ?? null;
  const videoRange = /VIDEO-RANGE=([A-Z]{2,5})/.exec(line)?.[1] ?? null;
  return codecs || videoRange ? { codecs, videoRange } : null;
}

/** La plage du flux envoyé : celle du maître, sinon seulement ce qui est sûr — sinon rien. */
function servedRange(info: JellyfinPlayback, served: ServedStream | null | undefined, lighter: boolean): string | null {
  const range = served?.videoRange?.toUpperCase();
  if (range === "SDR") return "SDR";
  if (range === "PQ") return "HDR (PQ)";
  if (range === "HLG") return "HLG";
  // La version allégée est toujours convertie en SDR (`buildDeviceProfile`, condition `VideoRangeType`).
  if (lighter) return "SDR";
  // Un transcodage ne fabrique pas de HDR : une source SDR reste SDR. Une source HDR transcodée peut
  // être convertie ou non — inconnu, rien d'affiché.
  if (info.video?.rangeType === "SDR") return "SDR";
  return null;
}

/**
 * Ce que le lecteur stable sait de sa lecture, dans le modèle commun aux deux lecteurs.
 *
 * La couleur suit la part de travail laissée au serveur, pas la réussite : une lecture directe
 * est verte, un transcodage est ambre même quand il se déroule parfaitement.
 *
 * Un transcodage montre ce qui est **envoyé** (« Diffusé ») à côté du fichier d'origine : en version
 * allégée, le panneau ne décrivait que la source (4K HEVC Dolby Vision 30 Mbit/s) pendant que le
 * téléphone recevait du 720p SDR à 1,5 Mbit/s (12/10/2026).
 */
export function describeJellyfinPlayback(
  info: JellyfinPlayback,
  networkBitrate: number | null,
  fallbackReason: string | null | undefined,
  t: Translate,
  link?: LinkReading | null,
  extra?: { served?: ServedStream | null; origin?: LighterOrigin | null }
): Omit<PlaybackPanelData, "report"> {
  const transcoded = info.playMethod === "Transcode";
  // La version allégée n'existe qu'en transcodage : un palier sur une lecture directe ne dirait rien.
  const lighter = transcoded ? link?.lighter ?? null : null;
  const streamBitrate = typeof info.streamBitrate === "number" && info.streamBitrate > 0 ? info.streamBitrate : null;
  const headline =
    info.playMethod === "DirectPlay"
      ? { name: t("player.info.directPlay"), detail: t("player.info.describeDirectPlay"), tone: "good" as const }
      : info.playMethod === "DirectStream"
        ? {
            name: t("player.info.directStream"),
            detail: info.transcodeReasons.some((r) => r.startsWith("Audio"))
              ? t("player.info.describeDirectStreamAudio")
              : t("player.info.describeDirectStreamContainer"),
            tone: "good" as const,
          }
        : lighter
          ? {
              name: t("player.info.lighterName"),
              detail: t("player.info.describeLighter", { rate: formatBitrate(lighter.targetBps) }),
              tone: "warn" as const,
            }
          : { name: t("player.info.transcode"), detail: t("player.info.describeTranscode"), tone: "warn" as const };

  const origin = lighter ? extra?.origin ?? null : null;
  const notes = [
    ...info.transcodeReasons.map((r) => `· ${KNOWN_REASONS.has(r) ? t(`player.info.reasons.${r}`) : r}`),
    // Conservé là où quelqu'un peut le retrouver, puisque personne n'a été consulté sur le moment.
    ...(fallbackReason ? [t("player.info.gaveWay", { reason: fallbackReason })] : []),
    ...(origin?.kind === "switch"
      ? [origin.at !== null ? t("player.info.lighterSwitchedAt", { position: formatTime(origin.at) }) : t("player.info.lighterSwitched")]
      : origin?.kind === "inherited"
        ? [t("player.info.lighterInherited")]
        : []),
  ];

  const served = extra?.served ?? null;
  const servedBitrate = streamBitrate ?? lighter?.targetBps ?? null;
  const servedSection = transcoded
    ? section(t("player.info.sections.served"), [
        { label: t("player.info.video"), value: codecName(served?.videoCodec) },
        {
          label: t("player.info.resolution"),
          value: served?.width && served.height ? `${served.width}×${served.height}` : null,
        },
        { label: t("player.info.bitrate"), value: servedBitrate ? formatBitrate(servedBitrate) : null },
        { label: t("player.info.range"), value: servedRange(info, served, lighter !== null) },
        { label: t("player.info.audio"), value: codecName(served?.audioCodec) },
      ])
    : null;

  return {
    headline,
    notes,
    sections: [
      ...(servedSection && servedSection.rows.length > 0 ? [servedSection] : []),
      section(transcoded ? t("player.info.sections.fileOriginal") : t("player.info.sections.file"), [
        { label: t("player.info.container"), value: info.container ?? "—" },
        {
          label: t("player.info.video"),
          value: info.video
            ? `${info.video.codec ?? "?"}${info.video.profile ? ` (${info.video.profile})` : ""}`
            : null,
        },
        {
          label: t("player.info.resolution"),
          value: info.video?.width && info.video.height ? `${info.video.width}×${info.video.height}` : null,
        },
        { label: t("player.info.depth"), value: info.video?.bitDepth ? `${info.video.bitDepth} bits` : null },
        {
          label: t("player.info.range"),
          value: info.video?.rangeType && info.video.rangeType !== "Unknown" ? info.video.rangeType : null,
        },
        { label: t("player.info.fps"), value: info.video?.frameRate ? info.video.frameRate.toFixed(2) : null },
        { label: t("player.info.bitrate"), value: info.video ? formatBitrate(info.video.bitRate) : null },
      ]),
      section(t("player.info.sections.sound"), [
        { label: t("player.info.codec"), value: info.audio?.codec ?? null },
        { label: t("player.info.channels"), value: info.audio?.channels ? String(info.audio.channels) : null },
        { label: t("player.info.bitrate"), value: info.audio ? formatBitrate(info.audio.bitRate) : null },
        { label: t("player.info.language"), value: info.audio?.language ?? null },
      ]),
      section(t("player.info.sections.stream"), [
        {
          label: t("player.info.serverTranscode"),
          value: transcoded ? t("player.info.serverTranscodeYes") : t("player.info.serverTranscodeNo"),
        },
        { label: t("player.info.estimatedBitrate"), value: networkBitrate ? formatBitrate(networkBitrate) : null },
        ...linkRows(link, t),
      ]),
    ],
  };
}

export interface RemuxPlayback {
  path: "remux" | null;
  pathReason: string | null;
  container: string | null;
  video: { codec: string | null; width: number | null; height: number | null; bitDepth: number | null; rangeType: string | null } | null;
  audioTrackCount: number;
  subtitleTrackCount: number;
  currentAudioCodec: string | null;
  diagnostics: Record<string, string>;
  /** Le lien vers cet appareil — voir `linkRows`. */
  link?: LinkReading | null;
}

/** Les deux lignes de diagnostic qui parlent du son plutôt que du transport. */
export const AUDIO_ROWS = ["Traitement audio", "Décalage de présentation"];

/** Ce que le lecteur natif sait de sa lecture, dans le même modèle. */
export function describeRemuxPlayback(info: RemuxPlayback, t: Translate): Omit<PlaybackPanelData, "report"> {
  const headline =
    info.path === null
      ? { name: t("player.info.paths.pendingName"), detail: t("player.info.paths.pendingDetail"), tone: "neutral" as const }
      : { name: t("player.info.paths.remuxName"), detail: t("player.info.paths.remuxDetail"), tone: "good" as const };

  return {
    headline,
    // Affichée que le chemin ait abouti ou non : un repli dont la raison est invisible équivaut
    // à un repli silencieux.
    notes: info.pathReason ? [info.pathReason] : [],
    sections: [
      section(t("player.info.sections.file"), [
        { label: t("player.info.container"), value: info.container?.toUpperCase() ?? "?" },
        {
          label: t("player.info.video"),
          value: `${info.video?.codec ?? "?"} · ${info.video?.width ?? "?"}×${info.video?.height ?? "?"} · ${info.video?.bitDepth ?? "?"} bits`,
        },
        // Fichier pas encore décrit : aucune plage (« SDR » s'affichait avant même la réponse). Décrit
        // sans `VideoRangeType`, le lecteur le traite en SDR (`isHdr`, route `direct`) — dit tel quel.
        { label: t("player.info.range"), value: info.video ? info.video.rangeType ?? "SDR" : null },
        {
          label: t("player.info.tracks"),
          value: t("player.info.tracksValue", { audio: info.audioTrackCount, subtitles: info.subtitleTrackCount }),
        },
      ]),
      section(t("player.info.sections.sound"), [
        { label: t("player.info.track"), value: info.currentAudioCodec ?? t("player.info.noDecodableTrack") },
        ...AUDIO_ROWS.filter((k) => k in info.diagnostics).map((k) => ({ label: k, value: info.diagnostics[k] })),
      ]),
      section(t("player.info.sections.stream"), [
        { label: t("player.info.serverTranscode"), value: t("player.info.serverTranscodeNo") },
        ...linkRows(info.link, t),
        ...Object.entries(info.diagnostics)
          .filter(([label]) => !AUDIO_ROWS.includes(label))
          .map(([label, value]) => ({ label, value })),
      ]),
    ],
  };
}
