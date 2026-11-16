"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";

/**
 * L'état de la conversion du son de Lumen serveur (DECISIONS.md §161), sous sa carte de la Configuration → Lecture :
 * ffmpeg détecté (version, encodeurs) ou pourquoi la conversion est indisponible — le son est alors converti par
 * l'appareil, comme sans l'option —, les lectures qui convertissent, l'occupation du cache, et les 24 dernières
 * heures. Lu de `/api/admin/lumen-audio` (administrateur seul), relu toutes les 30 s tant que la page est ouverte.
 */
interface Status {
  audience: "off" | "admins" | "tous";
  ffmpeg: { available: true; version: string; encoders: string[] } | { available: false; reason: string };
  queue: { running: number; demandQueued: number; leadQueued: number; preempted: number };
  sessions: number;
  memory: { bytes: number; capBytes: number };
  disk: { bytes: number; capBytes: number; files: number };
  totals: { refusedAdmissions: number; busy: number; failures: number };
  day: { segments: number; demandMedianMs: number | null; demandMaxMs: number | null };
}

const ENCODER_NAMES: Record<string, string> = { eac3: "E-AC-3", ac3: "AC-3", aac: "AAC", flac: "FLAC" };

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} Go` : `${Math.round(bytes / 1024 ** 2)} Mo`;
}

export function LumenAudioStatus() {
  const t = useT();
  const { data } = useSWR<Status>("/api/admin/lumen-audio", fetcher, { refreshInterval: 30_000 });
  if (!data) return null;
  const ok = data.ffmpeg.available;
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-lumen-audio-status="">
      <p className={`text-sm font-medium ${ok ? "text-success" : "text-warning"}`}>
        {data.ffmpeg.available
          ? t("config.lumenAudio.detected", { version: data.ffmpeg.version, encoders: data.ffmpeg.encoders.map((e) => ENCODER_NAMES[e] ?? e).join(", ") })
          : t("config.lumenAudio.unavailable", { reason: data.ffmpeg.reason })}
      </p>
      {ok && (
        <ul className="mt-2 space-y-1 text-xs text-subtle">
          <li>{t("config.lumenAudio.now", { sessions: data.sessions, running: data.queue.running, queued: data.queue.demandQueued + data.queue.leadQueued })}</li>
          <li>{t("config.lumenAudio.cache", { memory: size(data.memory.bytes), memoryCap: size(data.memory.capBytes), disk: size(data.disk.bytes), diskCap: size(data.disk.capBytes) })}</li>
          <li>
            {t("config.lumenAudio.day", {
              segments: data.day.segments,
              median: data.day.demandMedianMs ?? "–",
              max: data.day.demandMaxMs ?? "–",
              fallbacks: data.totals.refusedAdmissions + data.totals.busy,
            })}
          </li>
        </ul>
      )}
    </section>
  );
}
