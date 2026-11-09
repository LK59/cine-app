"use client";

import { useState } from "react";
import useSWR from "swr";
import { Loader2, RotateCcw } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import type { XrayQualityPayload, XrayQualityRow } from "@/app/api/admin/xray/quality/route";
import type { XrayQualityGroup } from "@/lib/clients/xray";

/**
 * Configuration → Acteurs à l'écran : la qualité des noms (10.30, DECISIONS.md §138, « Qui parle ») — pour toute
 * la bibliothèque puis série par série, les moins bien nommées d'abord : parole nommée, visages nommés, voix
 * indécises, désaccords. Chaque série a « Réinitialiser la mémoire » (confirmé d'abord) : le service oublie ce que
 * la série a appris et la renomme dans l'ordre des épisodes, sans relire les fichiers.
 */

export const pct = (v: number | null | undefined): string => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)} %` : "—");

function Stats({ g, t }: { g: XrayQualityGroup; t: ReturnType<typeof useT> }) {
  return (
    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-4">
      <div>
        <dt className="inline">{t("xrayQuality.speech")} </dt>
        <dd className="inline font-semibold text-white">{pct(g.speechNamed)}</dd>
      </div>
      <div>
        <dt className="inline">{t("xrayQuality.faces")} </dt>
        <dd className="inline font-semibold text-white">{pct(g.facesNamed)}</dd>
      </div>
      <div>
        <dt className="inline">{t("xrayQuality.undecided")} </dt>
        <dd className="inline font-semibold text-white">{g.voicesUndecided}</dd>
      </div>
      <div>
        <dt className="inline">{t("xrayQuality.conflicts")} </dt>
        <dd className="inline font-semibold text-white">{g.voicesConflict}</dd>
      </div>
    </dl>
  );
}

export function XrayQualityCard() {
  const t = useT();
  const toast = useToast();
  const { data, mutate } = useSWR<XrayQualityPayload>("/api/admin/xray/quality", fetcher, { refreshInterval: 60_000 });
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!data) return <Loader2 className="animate-spin text-subtle" />;
  if (!data.configured) return null;

  async function reset(row: XrayQualityRow) {
    if (!row.seriesId) return;
    setBusy(row.seriesId);
    const res = await fetch("/api/admin/xray/quality", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset", seriesId: row.seriesId }),
    }).catch(() => null);
    setBusy(null);
    setConfirm(null);
    if (res?.ok) toast.success(t("xrayQuality.resetDone"));
    else toast.error(t("xrayScan.actionFailed"));
    await mutate();
  }

  return (
    <section className="rounded-2xl bg-white/[0.04] p-4" data-testid="xray-quality">
      <h2 className="text-base font-semibold">{t("xrayQuality.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("xrayQuality.hint")}</p>
      {data.unavailable && <p className="mt-3 text-sm text-warning">{t("xrayQuality.unavailable")}</p>}
      {data.overall && (
        <div className="mt-3">
          <p className="text-sm font-medium">{t("xrayQuality.overall", { n: data.overall.items, v: data.overall.withVoices })}</p>
          <Stats g={data.overall} t={t} />
        </div>
      )}
      {data.movies && (
        <div className="mt-3">
          <p className="text-sm font-medium">{t("xrayQuality.movies", { n: data.movies.items })}</p>
          <Stats g={data.movies} t={t} />
        </div>
      )}
      {!!data.series?.length && (
        <ul className="mt-4 divide-y divide-white/10">
          {data.series.map((row) => (
            <li key={row.seriesId ?? "?"} className="py-2" data-testid="xray-quality-series">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-medium">
                  {row.name ?? row.seriesId} <span className="text-muted">· {t("xrayQuality.episodes", { n: row.items })}</span>
                </p>
                {confirm === row.seriesId ? (
                  <span className="flex shrink-0 gap-2">
                    <button type="button" className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black" disabled={busy === row.seriesId} onClick={() => void reset(row)}>
                      {busy === row.seriesId ? <Loader2 className="h-3 w-3 animate-spin" /> : t("xrayQuality.resetConfirm")}
                    </button>
                    <button type="button" className="rounded-full bg-white/10 px-3 py-1 text-xs" onClick={() => setConfirm(null)}>
                      {t("common.cancel")}
                    </button>
                  </span>
                ) : (
                  <button type="button" className="flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs" onClick={() => setConfirm(row.seriesId)}>
                    <RotateCcw className="h-3 w-3" aria-hidden />
                    {t("xrayQuality.reset")}
                  </button>
                )}
              </div>
              <Stats g={row} t={t} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
