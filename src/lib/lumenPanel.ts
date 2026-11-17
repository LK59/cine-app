// Le panneau technique de Lumen serveur (« Infos de lecture », étape 4b, DECISIONS.md §189) : ce que ce lecteur sait de
// sa lecture, dans le modèle commun aux autres (`PlaybackPanelData`). Un fichier à part de `playbackPanel.ts` : les
// panneaux des deux autres lecteurs n'en sont pas touchés d'une ligne.
//
// Ce qu'il dit, et d'où il le tient :
// - **le chemin** : « Remux serveur (HLS) » — le serveur remultiplexe, Safari lit en HLS natif ;
// - **le fichier** (description Jellyfin) et **la découpe** (le verdict : format, règle `cra`, segments, cible) ;
// - **le son** : la piste, et ce que le serveur en livre — copiée telle quelle (réparée, §159) ou convertie (§161) ;
// - **ce que l'appareil a reçu** (Resource Timing : Safari expose à la page les requêtes HLS d'AVFoundation,
//   étape 3f) : segments vidéo et son reçus, débit de réception ;
// - **le relevé du serveur** pour cette lecture (`srv.*`, `/api/lumen/{id}/chrono?stats=1`) : construction, cache du
//   son converti, file ;
// - **les incidents** : replis tentés, réouvertures, changements de piste par réouverture, diffusion AirPlay.
import type { PlaybackPanelData, PanelSection } from "@/components/PlaybackInfoPanel";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface LumenPanelInput {
  video: { codec: string | null; width: number | null; height: number | null; rangeType: string | null } | null;
  container: string | null;
  /** La piste son en cours : son étiquette, son codec dans le fichier, ce que le serveur en livre. */
  audio: { label: string; codec: string; processing: string; repairs: string[] } | null;
  /** Le verdict : version de l'adresse, découpe, segments, cible. */
  version: string;
  cut: string | null;
  segments: number;
  targetS: number;
  resumeBy: string;
  lumenSession: string;
  /** Ce que la page a vu arriver (Resource Timing). */
  received: { video: number; audio: number; mbps: number | null } | null;
  /** Le relevé du serveur (`srv.*`), s'il a répondu. */
  server: Record<string, number | string> | null;
  /** Les incidents de la séance, dans l'ordre, déjà en mots. */
  events: string[];
  airplay: boolean;
}

function section(title: string, rows: { label: string; value: string | null | undefined }[]): PanelSection {
  return { title, rows: rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== "").map((r) => ({ label: r.label, value: r.value! })) };
}

/** Le format de l'adresse (`5-0123456789ab` → `5`, `5i1-…` → `5i1`). */
export function formatOfVersion(version: string): string {
  const dash = version.indexOf("-");
  return dash < 0 ? version : version.slice(0, dash);
}

/** Ce que la page a reçu de cette lecture : segments vidéo et son, débit pendant les réceptions. */
export function receivedOf(lumenSession: string): LumenPanelInput["received"] {
  try {
    const marker = `/${lumenSession}/`;
    let video = 0;
    let audio = 0;
    let bytes = 0;
    let ms = 0;
    for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      if (!e.name.includes("/api/lumen/") || !e.name.includes(marker)) continue;
      const name = e.name.slice(e.name.indexOf(marker) + marker.length).replace(/^tv\.[^/]+\//, "");
      if (!name.endsWith(".m4s")) continue;
      if (name.startsWith("v/") || name.startsWith("vm")) video += 1;
      else audio += 1;
      if (e.transferSize > 0 && e.responseEnd > e.responseStart) {
        bytes += e.transferSize;
        ms += e.responseEnd - e.requestStart;
      }
    }
    return { video, audio, mbps: ms > 0 ? Math.round(((bytes * 8) / (ms * 1000)) * 10) / 10 : null };
  } catch {
    return null;
  }
}

export function describeLumenServerPlayback(input: LumenPanelInput, t: Translate): Omit<PlaybackPanelData, "report"> {
  const srv = input.server ?? {};
  const num = (key: string) => (typeof srv[key] === "number" ? (srv[key] as number) : null);
  const segV = num("srv.segV");
  const built = segV !== null ? segV + (num("srv.segA") ?? 0) - (num("srv.reused") ?? 0) : null;
  const avgBuild = built && built > 0 && num("srv.buildMs") !== null ? Math.round(num("srv.buildMs")! / built) : null;
  const conv = num("srv.convSeg");
  return {
    headline: { name: t("player.info.lumen.name"), detail: t("player.info.lumen.detail"), tone: "good" },
    notes: [t("player.info.lumen.note"), ...input.events],
    sections: [
      section(t("player.info.sections.file"), [
        { label: t("player.info.container"), value: input.container?.toUpperCase() ?? null },
        { label: t("player.info.video"), value: input.video ? `${input.video.codec ?? "?"} · ${input.video.width ?? "?"}×${input.video.height ?? "?"}` : null },
        { label: t("player.info.range"), value: input.video ? (input.video.rangeType ?? "SDR") : null },
      ]),
      section(t("player.info.sections.sound"), [
        { label: t("player.info.track"), value: input.audio?.label ?? null },
        { label: t("player.info.codec"), value: input.audio?.codec ?? null },
        { label: t("player.info.lumen.delivery"), value: input.audio ? input.audio.processing : null },
        { label: t("player.info.lumen.repairs"), value: input.audio?.repairs.length ? input.audio.repairs.join(", ") : null },
      ]),
      section(t("player.info.lumen.sectionRemux"), [
        { label: t("player.info.lumen.path"), value: t("player.info.lumen.name") },
        { label: t("player.info.lumen.format"), value: formatOfVersion(input.version) },
        { label: t("player.info.lumen.cut"), value: input.cut },
        { label: t("player.info.lumen.segments"), value: t("player.info.lumen.segmentsValue", { n: input.segments, s: input.targetS }) },
        { label: t("player.info.lumen.resume"), value: input.resumeBy },
        { label: t("player.info.lumen.airplay"), value: input.airplay ? t("player.info.lumen.airplayOn") : t("player.info.lumen.airplayOff") },
        { label: t("player.info.lumen.session"), value: input.lumenSession },
      ]),
      section(t("player.info.lumen.sectionReceived"), [
        { label: t("player.info.lumen.received"), value: input.received ? t("player.info.lumen.receivedValue", { v: input.received.video, a: input.received.audio }) : null },
        { label: t("player.info.lumen.recvRate"), value: input.received?.mbps != null ? `${input.received.mbps} Mbit/s` : null },
      ]),
      section(t("player.info.lumen.sectionServer"), [
        { label: t("player.info.lumen.served"), value: segV !== null ? t("player.info.lumen.receivedValue", { v: segV, a: num("srv.segA") ?? 0 }) : null },
        { label: t("player.info.lumen.volume"), value: num("srv.MB") !== null ? t("player.info.lumen.volumeValue", { n: num("srv.MB")! }) : null },
        { label: t("player.info.lumen.build"), value: avgBuild !== null ? t("player.info.lumen.buildValue", { avg: avgBuild, max: num("srv.buildMaxMs") ?? 0 }) : null },
        { label: t("player.info.lumen.queue"), value: num("srv.waitMaxMs") !== null ? `≤ ${num("srv.waitMaxMs")} ms` : null },
        {
          label: t("player.info.lumen.audioCache"),
          value:
            conv !== null
              ? t("player.info.lumen.audioCacheValue", { n: conv, built: num("srv.convBuilt") ?? 0, ram: num("srv.convRam") ?? 0, disk: num("srv.convDisk") ?? 0 })
              : null,
        },
        { label: t("player.info.lumen.incidents"), value: [num("srv.busy") ? `503 ×${num("srv.busy")}` : null, num("srv.stale") ? `410 ×${num("srv.stale")}` : null, num("srv.errors") ? `500 ×${num("srv.errors")}` : null].filter(Boolean).join(" · ") || null },
      ]),
    ].filter((s) => s.rows.length > 0),
  };
}
