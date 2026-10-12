"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2, Pause, Play, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { SettingsGroupCard, type Draft } from "@/components/settings/SettingsGroupCard";
import { DEFAULT_MODELS, PROVIDERS, type ProviderName } from "@/lib/subtitleGen/pricing";
import type { SettingView } from "@/lib/settings/schema";

/**
 * Les sous-titres générés dans « Réglages serveur » (DECISIONS.md §69) : la carte de réglages
 * commune (fournisseur, clé masquée, modèle, budget, prix), puis la dépense du mois et les tâches,
 * avec reprendre et annuler.
 *
 * Deux choses que la carte commune ne sait pas faire : le champ modèle arrive **prérempli** avec
 * celui du fournisseur, et changer de fournisseur y met le modèle par défaut du nouveau — sauf si
 * l'administrateur en avait saisi un autre à la main.
 */

interface AdminJob {
  jobId: string;
  target: string;
  status: string;
  reason?: string;
  done: number;
  total: number;
  title: string | null;
  model: string;
  cost: number;
  createdBy: string;
  presentState: string | null;
  presentReason: string | null;
  viewers: number;
}

interface AdminPayload {
  available: boolean;
  hasKey: boolean;
  provider: ProviderName;
  model: string;
  price: { input: number; output: number } | null;
  budgetUsd: number;
  month: { cost: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; requests: number };
  jobs: AdminJob[];
}

const usd = (n: number) => (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));

export function SubtitleGenCard({
  views,
  draft,
  errors,
  onDraft,
  onReset,
  footer,
}: {
  views: Map<string, SettingView>;
  draft: Draft;
  errors: Record<string, string>;
  onDraft: (key: string, value: string) => void;
  onReset: (key: string) => void;
  footer: React.ReactNode;
}) {
  const t = useT();
  const toast = useToast();
  const { data, mutate } = useSWR<AdminPayload>("/api/subtitle-gen/admin", fetcher, { refreshInterval: 10_000 });
  const [acting, setActing] = useState<string | null>(null);

  const provider = (draft.SUBTITLE_GEN_PROVIDER ?? views.get("SUBTITLE_GEN_PROVIDER")?.value ?? "anthropic") as ProviderName;
  // Le modèle prérempli : la valeur réglée, sinon le défaut du fournisseur choisi.
  const shownViews = useMemo(() => {
    const model = views.get("SUBTITLE_GEN_MODEL");
    if (!model || model.value) return views;
    const next = new Map(views);
    next.set("SUBTITLE_GEN_MODEL", { ...model, value: DEFAULT_MODELS[(PROVIDERS as readonly string[]).includes(provider) ? provider : "anthropic"] });
    return next;
  }, [views, provider]);

  const draftWithProvider = (key: string, value: string) => {
    if (key === "SUBTITLE_GEN_PROVIDER" && (PROVIDERS as readonly string[]).includes(value)) {
      const current = draft.SUBTITLE_GEN_MODEL ?? shownViews.get("SUBTITLE_GEN_MODEL")?.value ?? "";
      // Un modèle saisi à la main reste ; le défaut de l'ancien fournisseur suit le nouveau.
      if (current === "" || (Object.values(DEFAULT_MODELS) as string[]).includes(current)) onDraft("SUBTITLE_GEN_MODEL", DEFAULT_MODELS[value as ProviderName]);
    }
    onDraft(key, value);
  };

  async function act(jobId: string, action: "resume" | "cancel") {
    setActing(jobId);
    const url = action === "resume" ? `/api/subtitle-gen/jobs/${jobId}/resume` : `/api/subtitle-gen/admin/jobs/${jobId}/cancel`;
    const res = await fetch(url, { method: "POST" }).catch(() => null);
    setActing(null);
    if (!res?.ok) toast.error(t("subtitleGen.admin.actionFailed"));
    await mutate();
  }

  const m = data?.month;
  const readRate = m ? Math.round((m.cacheReadTokens / Math.max(1, m.inputTokens + m.cacheWriteTokens + m.cacheReadTokens)) * 100) : 0;

  return (
    <div className="space-y-3">
      <SettingsGroupCard group="subtitles" views={shownViews} draft={draft} errors={errors} onDraft={draftWithProvider} onReset={onReset} footer={footer} />
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
        {!data ? (
          <Loader2 className="animate-spin text-subtle" />
        ) : (
          <div className="space-y-4">
            {!data.hasKey ? (
              <p className="text-sm text-muted">{t("subtitleGen.admin.noKey")}</p>
            ) : !data.price ? (
              <p className="text-sm text-warning">{t("subtitleGen.admin.noPrice")}</p>
            ) : (
              <p className="text-xs text-subtle">{t("subtitleGen.admin.price", { model: data.model, input: data.price.input, output: data.price.output })}</p>
            )}
            <div>
              <h4 className="text-sm font-semibold text-white">{t("subtitleGen.admin.spendTitle")}</h4>
              <p className="mt-1 text-sm text-muted">{t("subtitleGen.admin.spend", { spent: usd(data.month.cost), budget: usd(data.budgetUsd) })}</p>
              <p className="text-xs text-subtle">{t("subtitleGen.admin.usage", { requests: data.month.requests, rate: readRate })}</p>
            </div>
            <div>
              <h4 className="mb-2 text-sm font-semibold text-white">{t("subtitleGen.admin.jobsTitle")}</h4>
              {data.jobs.length === 0 ? (
                <p className="text-sm text-subtle">{t("subtitleGen.admin.noJobs")}</p>
              ) : (
                <ul className="divide-y divide-white/5">
                  {data.jobs.map((job) => (
                    <li key={job.jobId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-white">
                          {job.title ?? job.jobId} · {job.target.toUpperCase()}
                        </p>
                        <p className="text-xs text-subtle">
                          {t(`subtitleGen.admin.status.${job.status}`)}
                          {job.reason ? ` — ${t(`subtitleGen.admin.reasons.${job.reason}`)}` : ""}
                          {" · "}
                          {t("subtitleGen.admin.progress", { done: job.done, total: job.total })}
                          {" · "}
                          {usd(job.cost)} $ · {job.createdBy}
                          {job.viewers > 0 ? ` · ${t("subtitleGen.admin.viewers", { n: job.viewers })}` : ""}
                          {job.status === "done" && job.presentState ? ` · ${t(`subtitleGen.admin.present.${job.presentState}`)}` : ""}
                        </p>
                      </div>
                      <div className="flex gap-1.5">
                        {job.status === "paused" && (
                          <button type="button" className="btn btn-sm" disabled={acting !== null} onClick={() => act(job.jobId, "resume")}>
                            <Play size={13} />
                            {t("subtitleGen.admin.resume")}
                          </button>
                        )}
                        {(job.status === "running" || job.status === "preparing" || job.status === "paused") && (
                          <button type="button" className="btn btn-sm" disabled={acting !== null} onClick={() => act(job.jobId, "cancel")}>
                            {job.status === "paused" ? <X size={13} /> : <Pause size={13} />}
                            {t("subtitleGen.admin.cancel")}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
