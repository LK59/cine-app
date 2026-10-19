"use client";

import useSWR from "swr";
import { Play } from "lucide-react";
import { usePlayback } from "@/components/PlaybackProvider";
import { fetcher } from "@/lib/swr";
import { formatFileSize } from "@/lib/format";
import { LAB_SAMPLE_SOURCE, LAB_SAMPLES } from "@/lib/labSamples";

/**
 * Lot Q — la qualité des téléchargements hors ligne (19/10/2026). Le même passage de *Seven* en
 * quatre versions, lues par le vrai lecteur : on choisit à l'œil, sur l'appareil qu'on tient, avant
 * de fixer le format (`labSamples.ts`, docs/telechargement-hors-ligne.md).
 */
export function OfflineQualityLot() {
  const playback = usePlayback();
  const { data, error } = useSWR<{ samples: { file: string; sizeBytes: number }[] }>("/api/lab/offline-samples", fetcher, {
    revalidateOnFocus: false,
  });
  const sizes = new Map((data?.samples ?? []).map((s) => [s.file, s.sizeBytes]));
  return (
    <section className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
      <p className="text-sm text-muted">
        Deux minutes de <em>Seven</em>, film 4K très sombre et granuleux — le cas difficile exprès : 8:00 (nuit, pluie, appartement
        sombre) puis 1:08:40 (la poursuite). HDR converti en SDR, son AAC stéréo 128 kb/s. Comparez sur le téléphone, l&apos;iPad et le
        PC ; le film d&apos;origine aux mêmes instants sert de référence.
      </p>
      {error && <p className="text-sm text-warning">Liste des extraits indisponible.</p>}
      <ul className="space-y-2">
        {LAB_SAMPLES.map((sample) => {
          const size = sizes.get(sample.file);
          const present = size !== undefined;
          return (
            <li key={sample.file} className="flex items-center justify-between gap-4 rounded-xl border border-white/8 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm text-white">{sample.label}</p>
                <p className="mt-0.5 text-xs text-subtle">
                  {sample.note}
                  {present ? ` Extrait : ${formatFileSize(size, "fr")}.` : data ? " Absent du serveur." : ""}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm shrink-0"
                disabled={!present}
                onClick={() =>
                  playback.play({
                    itemId: LAB_SAMPLE_SOURCE.itemId,
                    title: `${LAB_SAMPLE_SOURCE.title} — ${sample.label}`,
                    resumeAt: 0,
                    bench: "lab-qualite",
                    labSample: { file: sample.file, sizeBytes: size ?? null },
                  })
                }
              >
                <Play size={14} />
                Lire
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
