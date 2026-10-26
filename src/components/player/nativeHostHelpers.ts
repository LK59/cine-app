// Les fonctions pures du lecteur natif (`ExperimentalPlayerHost.tsx`), sorties telles quelles de son
// module le 22/10/2026 : elles ne lisent rien du composant, et 4 000 lignes autour d'elles les
// cachaient. Aucune n'a changé — ni ses champs, ni leur ordre.
import { warmNextEpisode } from "@/lib/nextEpisodeWarmup";
import { prefetchPlaybackState } from "@/lib/playbackPrefetch";
import { takeAacDecodeRoute } from "@/lib/webcodecs/softwareAudio";
import type { SeekTiming } from "@/lib/hostSeek";
import { seekElapsed } from "@/components/player/session/seekElapsed";
import { traceRecent } from "@/lib/webcodecs/trace";
import { normaliseLanguage, toJellyfinLanguage, trackLanguage } from "@/lib/trackPreferences";
import type { CastSubtitle } from "@/lib/castSubtitle";
import { languageName } from "@/lib/trackLabel";
import type { SessionTally } from "@/lib/playerSessionTally";
import type { PlayerTrack } from "@/lib/webcodecs/playerTrack";
import type { RecoveryFacts } from "@/lib/webcodecs/mseSource";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import type { ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import type { GenerationNotice, GenerationSnapshot } from "@/lib/subtitleGen/generation";
import type { SubtitleGenErrorCode } from "@/lib/subtitleGen/client";

/** À combien de la fin l'épisode suivant est préparé : de quoi finir bien avant le décompte. */
const NEXT_EPISODE_WARMUP_SECONDS = 60;

/**
 * L'épisode suivant, préparé une fois qu'on approche de la fin — voir `nextEpisodeWarmup.ts`.
 *
 * « La fin », c'est le générique quand on le connaît : c'est lui qui déclenche l'enchaînement, dix
 * secondes après. Comptée depuis la fin du fichier, la préparation arrivait après le passage pour
 * un générique de plus de 70 s. Et l'état du spectateur est redemandé tant qu'on attend (la
 * demande se limite elle-même à une toutes les 30 s) : préparé une minute avant, il était jugé
 * périmé au moment d'ouvrir, et redemandé (relu le 24/09/2026).
 */
export function warmNextNear(nextId: string | null, position: number, duration: number, creditsStart: number | null): void {
  if (!nextId || !(duration > 0)) return;
  const endsAt = creditsStart !== null && creditsStart > 0 && creditsStart < duration ? creditsStart : duration;
  if (endsAt - position > NEXT_EPISODE_WARMUP_SECONDS) return;
  void warmNextEpisode(nextId);
  prefetchPlaybackState(nextId);
}

/** Le décodeur d'un AAC à PCE décodé, pour la ligne `start` (DECISIONS.md §62) ; rien sinon. */
export function aacRouteFacts(): Record<string, unknown> {
  const route = takeAacDecodeRoute();
  return route ? { aacRoute: route } : {};
}

/**
 * L'avance que l'élément voit sous sa tête — la plage qui la contient, jusqu'à sa fin. Au début
 * d'une attente, c'est ce qui dit si le média manquait ou s'il était là (voir playbackDiagnosis.ts).
 */
export function leadAt(element: HTMLVideoElement): number | null {
  try {
    const at = element.currentTime;
    const ranges = element.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= at + 0.1 && ranges.end(i) > at) return Math.round((ranges.end(i) - at) * 100) / 100;
    }
    return 0;
  } catch {
    return null;
  }
}

/**
 * Ce qu'on sait, en fin de séance, de l'accord entre le son et l'image.
 *
 * Un spectateur sur Chrome Android voyait le son se décaler peu à peu, et un saut le recaler
 * (22/09/2026) — sans que rien, nulle part, n'en garde la trace. Deux faits pour trancher : les
 * horloges du son ré-encodé (`audioSync`, voir `AudioTimingStats` ; absent quand le son est copié),
 * et les images que le navigateur a sautées (`frames`) — un appareil qui n'arrive plus à suivre
 * décale aussi l'image du son. Mesuré sans rien montrer, et sans jamais faire échouer la ligne
 * qui le porte.
 */
export function syncFacts(
  remux: {
    audioTiming(): { sourceMs: number; encoderMs: number } | null;
    recoveryFacts?(): RecoveryFacts | null;
  } | null,
  element: HTMLVideoElement | null
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  try {
    const timing = remux?.audioTiming();
    if (timing) facts.audioSync = timing;
  } catch {
    // Un pipeline déjà détruit : rien à dire.
  }
  try {
    // Combien de fois la source a dû se reprendre sur la séance. Une séance à douze reprises et
    // une séance à zéro se lisaient pareil ; les barreaux gravis ne sont écrits que s'il y en a eu.
    const recovery = remux?.recoveryFacts?.();
    if (recovery) {
      facts.recoveries = recovery.recoveries;
      facts.frozenNudges = recovery.frozenNudges;
      if (recovery.escalations > 0) facts.escalations = recovery.escalations;
      // Ce que Safari a retiré de lui-même (24/09/2026) : écrit seulement s'il y en a eu, comme
      // les barreaux.
      if (recovery.evictions > 0) {
        facts.evictions = recovery.evictions;
        facts.evictionsAhead = recovery.evictionsAhead;
      }
    }
  } catch {
    // Idem.
  }
  try {
    const quality = element?.getVideoPlaybackQuality?.();
    if (quality && quality.totalVideoFrames > 0) {
      facts.frames = { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
    }
  } catch {
    // Non pris en charge ici.
  }
  return facts;
}

/**
 * Jellyfin's stream index for one of the file's audio tracks, or undefined if it cannot be
 * named with confidence.
 *
 * The two lists describe the same file from two sides: the player reads Matroska track *numbers*
 * out of the container, Jellyfin reports ffmpeg stream *indices*. Neither converts into the
 * other — Matroska only requires a track number to be unique and positive, so the tempting
 * `index = number - 1` holds for files mkvmerge wrote and is arithmetic elsewhere. What is
 * reliable is the order: both lists enumerate the file's audio streams in the order the file
 * stores them, so the nth audio track here is the nth audio stream there.
 *
 * Returns undefined rather than a guess when the two disagree on how many audio streams exist.
 * The stable player then picks its own default — a film that opens in the wrong language is a
 * better failure than one that opens on a track chosen by a rule that did not hold.
 */
export function jellyfinAudioIndex(
  fileTracks: PlayerTrack[],
  jellyfinTracks: DirectPlayInfo["audio"] | undefined,
  trackNumber: number
): number | undefined {
  if (!jellyfinTracks || jellyfinTracks.length !== fileTracks.length) return undefined;
  const ordinal = fileTracks.findIndex((t) => t.number === trackNumber);
  if (ordinal < 0) return undefined;
  return jellyfinTracks[ordinal]?.index;
}

/**
 * Le sous-titre choisi, en index Jellyfin — pour que la version allégée le rallume (§78). Un fichier à
 * côté porte son index dans son adresse (`&index=`) ; une piste du conteneur, par son rang parmi
 * celles que Jellyfin liste dans le même ordre (comme `jellyfinAudioIndex`). `null` : aucun sous-titre,
 * ou un qu'on ne sait pas nommer — mieux vaut pas de sous-titre qu'un sous-titre dans une autre langue.
 */
export function jellyfinSubtitleIndex(
  current: number | null,
  fileTracks: PlayerTrack[],
  embedded: number[] | undefined,
  externals: { id: number; url: string }[]
): number | null {
  if (current === null) return null;
  const external = externals.find((e) => e.id === current);
  if (external) {
    const match = /[?&]index=(\d+)/.exec(external.url);
    return match ? Number(match[1]) : null;
  }
  if (!embedded || embedded.length !== fileTracks.length) return null;
  const ordinal = fileTracks.findIndex((t) => t.number === current);
  return ordinal >= 0 ? embedded[ordinal] ?? null : null;
}

/**
 * Le sous-titre que le téléphone montre, à incruster dans l'image du téléviseur (`castSubtitle.ts`).
 *
 * `undefined` sans sous-titre, pour une piste en cours de génération (Jellyfin ne la connaît pas
 * encore), ou quand l'index Jellyfin ne se retrouve pas : la diffusion part alors comme avant.
 */
export function castSubtitleOf(
  current: number | null,
  fileTracks: PlayerTrack[],
  embedded: number[] | undefined,
  externals: { id: number; url: string; language: string | null }[],
  generating: boolean
): CastSubtitle | undefined {
  if (current === null || generating) return undefined;
  const index = jellyfinSubtitleIndex(current, fileTracks, embedded, externals);
  if (index === null) return undefined;
  const external = externals.find((e) => e.id === current);
  const track = external ? null : fileTracks.find((t) => t.number === current);
  return {
    index,
    language: toJellyfinLanguage(external ? external.language : track ? trackLanguage(track) : null),
    forced: track?.isForced === true,
  };
}

/** Les raisons de pause que le serveur nomme ; toute autre se dit « en attente ». */
const PAUSE_REASONS = new Set(["budget", "quota", "network", "config"]);

/** Un message d'état de génération, en mots — voir `SubtitleGeneration.noticeAt`. */
export function noticeText(notice: GenerationNotice, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (notice.kind === "preparing") return t("player.subtitleGen.preparing");
  if (notice.kind === "resuming") return t("player.subtitleGen.resuming");
  const reason = notice.reason && PAUSE_REASONS.has(notice.reason) ? notice.reason : "other";
  return t("player.subtitleGen.paused", { reason: t(`player.subtitleGen.reasons.${reason}`) });
}

/** Un échec de génération, dit au spectateur — jamais une erreur de lecture. */
export function generationErrorText(
  code: SubtitleGenErrorCode | "job-failed",
  quotaLimit: number | null,
  t: (key: string, vars?: Record<string, string | number>) => string
): string {
  if (code === "quota") return quotaLimit ? t("player.subtitleGen.errors.quota", { n: quotaLimit }) : t("player.subtitleGen.errors.quotaToday");
  if (code === "budget") return t("player.subtitleGen.errors.budget");
  if (code === "no-source") return t("player.subtitleGen.errors.noSource");
  if (code === "network") return t("player.subtitleGen.errors.network");
  return t("player.subtitleGen.errors.failed");
}

/**
 * Ce que le menu montre d'une génération de sous-titres : les entrées temporaires (avec leur
 * avancement discret), les langues qu'on peut encore demander, les générations à reprendre.
 *
 * Une langue ne se propose pas deux fois : ni si elle a déjà des sous-titres (`existing`), ni si une
 * génération la porte, ni si une piste générée est déjà dans la liste des externes. Une entrée
 * temporaire disparaît dès que sa piste finale y est — c'est la bascule (§70).
 */
export function generationMenu(
  state: GenerationSnapshot,
  externals: readonly ExternalSubtitleSource[],
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string
): {
  entries: { track: PlayerTrack; detail: string | undefined }[];
  targets: { code: string; label: string }[];
  resumable: { code: string; label: string }[];
} {
  const generatedLanguages = new Set(externals.filter((s) => s.generated === true).map((s) => normaliseLanguage(s.language)));
  const live = state.jobs.filter((job) => job.status !== "failed" && !job.finalized && !generatedLanguages.has(normaliseLanguage(job.target)));
  const name = (code: string) => languageName(code, locale) ?? code.toUpperCase();
  const entries = live.map((job) => ({
    track: { number: job.id, codecId: "S_TEXT/UTF8", language: job.target, name: null, isDefault: false, isForced: false },
    // Finie mais pas encore présentée par Jellyfin : « finalisation… » plutôt qu'un 100 % qui dure.
    detail:
      job.status === "done"
        ? t("player.subtitleGen.finalizing")
        : job.total > 0
          ? t("player.subtitleGen.percent", { n: Math.min(99, Math.floor((job.done / job.total) * 100)) })
          : undefined,
  }));
  const taken = new Set([
    ...(state.options?.existing ?? []).map(normaliseLanguage),
    ...state.jobs.filter((job) => job.status !== "failed").map((job) => normaliseLanguage(job.target)),
    ...generatedLanguages,
  ]);
  const targets = state.options?.enabled
    ? state.options.targets.filter((code) => !taken.has(normaliseLanguage(code))).map((code) => ({ code, label: name(code) }))
    : [];
  const resumable = live
    .filter((job) => job.status === "paused" || job.status === "stale")
    .map((job) => ({ code: job.target, label: name(job.target) }));
  return { entries, targets, resumable };
}

// La durée d'un saut : commune aux deux lecteurs depuis le 23/10/2026 (`player/session/seekElapsed.ts`).
export { seekElapsed };

/**
 * Les champs d'une ligne `seek`, après la description du fichier — écrits une seule fois pour ses
 * deux émetteurs : le saut arrivé (`seeked`) et le saut remplacé ou posé ailleurs
 * (`reportUnarrivedSeek`). `between` : ce que le second ajoute (verdict, `superseded`,
 * `landedAt`), à la place qu'il occupait déjà dans la ligne — l'ordre des clés n'a pas bougé.
 *
 * `steps` : ce que la source a fait entre la demande et l'arrivée — et une demi-seconde avant,
 * pour le geste qui l'a lancée. Un saut arrière suivi d'un blocage (22/09/2026) ne laissait au
 * journal que « de 176 à 166 en 900 ms », sans rien de ce qui l'avait servi.
 */
export function seekLineFields(tally: SessionTally, timing: SeekTiming, between: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "remux",
    from: Math.round(timing.from),
    to: Math.round(timing.to),
    buffered: timing.buffered,
    ranges: timing.ranges,
    ...between,
    tookMs: seekElapsed(tally, timing),
    steps: traceRecent(Date.now() - timing.startedAt + 500).join(" | "),
  };
}

/**
 * Les champs d'une ligne `rebuild` — écrits une seule fois pour ses quatre émetteurs : dialogues
 * améliorés impossibles, AAC à PCE refusé, source perdue (`onError`) et source fermée en
 * arrière-plan (`useNativeRecovery`). Le préfixe est le même partout et dans le même ordre : la
 * description du fichier, `path`, `reason`, `at` ; puis ce que chacun ajoute (`extra`), à la place
 * qu'il occupait déjà dans la ligne — l'ordre des clés n'a pas bougé (23/10/2026).
 *
 * `path: "remux"` : la reconstruction d'arrière-plan l'a toujours écrit ; la source perdue, non —
 * sans lui, une ligne sur deux n'avait pas de chemin, et tout regroupement par chemin la perdait.
 */
export function rebuildLine(
  file: Record<string, unknown>,
  reason: string,
  at: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...file, path: "remux", reason, at, ...extra };
}
