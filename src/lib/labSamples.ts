import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";

/**
 * Les extraits du test de qualité du téléchargement hors ligne (19/10/2026, Louis) — « Tests divers »,
 * lot « Qualité hors ligne ».
 *
 * Le même passage de *Seven* — 8:00 à 9:00 (nuit, pluie, appartement sombre, grain fort) puis 1:08:40
 * à 1:09:40 (la poursuite) — en quatre versions, lues par le vrai lecteur pour en juger à l'œil
 * sur l'iPhone, l'iPad et le PC avant de fixer le format des téléchargements. Fabriqués à la main
 * hors de l'application (`data/lab/offline-samples/`, docs/telechargement-hors-ligne.md « Mesures ») :
 * rien ici ne les produit, et sans eux le lot le dit.
 *
 * Deux encodeurs, parce que la mesure a tranché autre chose que le débit : en dessous d'environ
 * 4 Mb/s, Jellyfin choisit lui-même le 720p, quoi qu'on demande (`MaxWidth`, `Width` et `Height`
 * essayés), et il encode en `veryfast` à débit quasi constant. Le 1080p à 2 ou 3 Mb/s n'existe donc
 * qu'en appelant le même encodeur matériel (QSV) directement, réglé `slow`, débit variable,
 * anticipation de 40 images.
 */
export interface LabSample {
  file: string;
  label: string;
  note: string;
  width: number;
  height: number;
}

/** *Seven* (1995), 4K Dolby Vision, très sombre et granuleux : le cas difficile, exprès. */
export const LAB_SAMPLE_SOURCE = { itemId: "436d8b070e24e6c70a6e7b5be03af50b", title: "Seven" } as const;

export const LAB_SAMPLES: readonly LabSample[] = [
  { file: "a-1080-2.mp4", label: "A · 1080p · 2 Mb/s", note: "Encodeur dédié (QSV slow, débit variable). ~0,9 Go/h.", width: 1920, height: 800 },
  { file: "b-1080-3.mp4", label: "B · 1080p · 3 Mb/s", note: "Encodeur dédié (QSV slow, débit variable). ~1,4 Go/h.", width: 1920, height: 800 },
  { file: "c-720-2.mp4", label: "C · 720p · 2 Mb/s", note: "Jellyfin tel quel (veryfast, débit constant). ~0,9 Go/h.", width: 1280, height: 532 },
  { file: "d-1080-4.mp4", label: "D · 1080p · 4 Mb/s", note: "Jellyfin tel quel : le plus bas débit où il garde le 1080p. ~1,8 Go/h.", width: 1920, height: 800 },
];

export function labSampleByFile(file: string): LabSample | null {
  return LAB_SAMPLES.find((s) => s.file === file) ?? null;
}

export const labSampleUrl = (file: string) => `/api/lab/offline-samples/${encodeURIComponent(file)}`;

/**
 * La description qu'un extrait donne au lecteur, à la place de celle du fichier Jellyfin : un MP4
 * HEVC 8 bits SDR, une piste AAC stéréo française, rien d'autre. Sans `fileVersion`, rien n'est
 * gardé sur l'appareil pour lui (`openDiskChunks`).
 */
export function labSampleInfo(sample: LabSample, sizeBytes: number | null): DirectPlayInfo {
  return {
    streamUrl: labSampleUrl(sample.file),
    container: "mp4",
    sizeBytes,
    fileVersion: null,
    runtimeSeconds: 120,
    video: { codec: "hevc", width: sample.width, height: sample.height, bitDepth: 8, rangeType: "SDR", isHdr: false },
    audio: [{ index: 1, codec: "aac", language: "fre", displayTitle: null, channels: 2, isDefault: true, profile: null }],
    embeddedSubtitleIndexes: [],
    lighterAllowed: false,
    originalLanguage: null,
    refusedReason: null,
    externalSubtitles: [],
    title: `${LAB_SAMPLE_SOURCE.title} — ${sample.label}`,
    logoUrl: null,
    introSkip: null,
    recapSkip: null,
    creditsStart: null,
  };
}
