import type { PlaybackPanelData, PanelSection } from "@/components/PlaybackInfoPanel";

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

export interface JellyfinPlayback {
  playMethod: "DirectPlay" | "DirectStream" | "Transcode";
  transcodeReasons: string[];
  container: string | null;
  video: {
    codec: string | null; profile: string | null; width: number | null; height: number | null;
    bitDepth: number | null; frameRate: number | null; bitRate: number | null;
  } | null;
  audio: { codec: string | null; channels: number | null; bitRate: number | null; language: string | null } | null;
}

/**
 * Ce que le lecteur stable sait de sa lecture, dans le modèle commun aux deux lecteurs.
 *
 * La couleur suit la part de travail laissée au serveur, pas la réussite : une lecture directe
 * est verte, un transcodage est ambre même quand il se déroule parfaitement.
 */
export function describeJellyfinPlayback(
  info: JellyfinPlayback,
  networkBitrate: number | null,
  fallbackReason: string | null | undefined,
  t: Translate
): Omit<PlaybackPanelData, "report"> {
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
        : { name: t("player.info.transcode"), detail: t("player.info.describeTranscode"), tone: "warn" as const };

  const notes = [
    ...info.transcodeReasons.map((r) => `· ${KNOWN_REASONS.has(r) ? t(`player.info.reasons.${r}`) : r}`),
    // Conservé là où quelqu'un peut le retrouver, puisque personne n'a été consulté sur le moment.
    ...(fallbackReason ? [t("player.info.gaveWay", { reason: fallbackReason })] : []),
  ];

  return {
    headline,
    notes,
    sections: [
      section(t("player.info.sections.file"), [
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
          value: info.playMethod === "Transcode" ? t("player.info.serverTranscodeYes") : t("player.info.serverTranscodeNo"),
        },
        { label: t("player.info.estimatedBitrate"), value: networkBitrate ? formatBitrate(networkBitrate) : null },
      ]),
    ],
  };
}

export interface RemuxPlayback {
  path: "remux" | "webcodecs" | "direct" | null;
  pathReason: string | null;
  container: string | null;
  video: { codec: string | null; width: number | null; height: number | null; bitDepth: number | null; rangeType: string | null } | null;
  audioTrackCount: number;
  subtitleTrackCount: number;
  currentAudioCodec: string | null;
  diagnostics: Record<string, string>;
}

/** Les deux lignes de diagnostic qui parlent du son plutôt que du transport. */
export const AUDIO_ROWS = ["Traitement audio", "Décalage de présentation"];

/** Ce que le lecteur natif sait de sa lecture, dans le même modèle. */
export function describeRemuxPlayback(info: RemuxPlayback, t: Translate): Omit<PlaybackPanelData, "report"> {
  const known = {
    direct: { name: t("player.info.paths.directName"), detail: t("player.info.paths.directDetail"), tone: "good" as const },
    remux: { name: t("player.info.paths.remuxName"), detail: t("player.info.paths.remuxDetail"), tone: "good" as const },
    webcodecs: { name: t("player.info.paths.webcodecsName"), detail: t("player.info.paths.webcodecsDetail"), tone: "warn" as const },
  };
  const headline =
    info.path === null
      ? { name: t("player.info.paths.pendingName"), detail: t("player.info.paths.pendingDetail"), tone: "neutral" as const }
      : known[info.path];

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
        { label: t("player.info.range"), value: info.video?.rangeType ?? "SDR" },
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
        ...Object.entries(info.diagnostics)
          .filter(([label]) => !AUDIO_ROWS.includes(label))
          .map(([label, value]) => ({ label, value })),
      ]),
    ],
  };
}
