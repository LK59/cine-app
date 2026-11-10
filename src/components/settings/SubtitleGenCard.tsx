"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2, Pause, Play, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { SettingsGroupCard, type Draft } from "@/components/settings/SettingsGroupCard";
import { DEFAULT_MODELS, PROVIDERS, modelChoices, type ProviderName } from "@/lib/subtitleGen/pricing";
import { AiFeaturesBlock, type FeatureStatusView } from "@/components/settings/AiFeaturesBlock";
import type { SettingView } from "@/lib/settings/schema";

/**
 * Le fournisseur d'IA commun, dans Fonctions intelligentes → Intelligence artificielle (DECISIONS.md
 * §69, §140, §142) : la carte de réglages commune (fournisseur, clé masquée, modèle, plafond, prix),
 * puis la dépense du mois et le tableau « ce que chaque fonction fait selon le fournisseur ». Les
 * fonctions qui s'en servent ont chacune leur carte en dessous ; les tâches des sous-titres générés
 * suivent la leur (`SubtitleJobs`).
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

export interface AiAdminPayload {
  available: boolean;
  hasKey: boolean;
  provider: ProviderName;
  model: string;
  price: { input: number; output: number } | null;
  budgetUsd: number;
  month: { cost: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; requests: number };
  /** Depuis §140 : le plafond commun, le modèle rapide des autres fonctions, l'état de chacune. */
  budgetReached?: boolean;
  fast?: { model: string; price: { input: number; output: number } | null };
  features?: FeatureStatusView[];
  pricesVerifiedOn?: string;
  priceSource?: string;
  jobs: AdminJob[];
}

/**
 * L'état des fonctions d'IA et du fournisseur, tel que le serveur le voit (`/api/subtitle-gen/admin`,
 * réservé à l'administrateur). Une seule clé SWR pour toutes les cartes qui le lisent : la page IA,
 * les acteurs à l'écran. Rafraîchi toutes les 10 s, comme l'était la carte des sous-titres.
 */
export function useAiAdmin() {
  return useSWR<AiAdminPayload>("/api/subtitle-gen/admin", fetcher, { refreshInterval: 10_000 });
}

const usd = (n: number) => (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));

export function AiProviderCard({
  views,
  draft,
  errors,
  keys,
  titleKey,
  anchor,
  onDraft,
  onReset,
  footer,
}: {
  views: Map<string, SettingView>;
  draft: Draft;
  errors: Record<string, string>;
  keys?: readonly string[];
  titleKey?: string;
  anchor?: string;
  onDraft: (key: string, value: string) => void;
  onReset: (key: string) => void;
  footer: React.ReactNode;
}) {
  const t = useT();
  const { data } = useAiAdmin();

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

  const readRate = data ? cacheReadRate(data.month) : null;
  const knownProvider: ProviderName = (PROVIDERS as readonly string[]).includes(provider) ? provider : "anthropic";

  return (
    <div className="space-y-3">
      <SettingsGroupCard
        group="subtitles"
        keys={keys}
        titleKey={titleKey}
        anchor={anchor}
        views={shownViews}
        draft={draft}
        errors={errors}
        onDraft={draftWithProvider}
        onReset={onReset}
        footer={footer}
        choices={{ SUBTITLE_GEN_MODEL: modelChoices(knownProvider) }}
      />
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
            {data.fast && (
              <p className="text-xs text-subtle">
                {data.fast.price
                  ? t("aiFeatures.fastModel", { model: data.fast.model, input: data.fast.price.input, output: data.fast.price.output })
                  : t("aiFeatures.fastModelNoPrice", { model: data.fast.model })}
              </p>
            )}
            {data.pricesVerifiedOn && data.priceSource && (
              <p className="text-xs text-subtle">
                <a href={data.priceSource} target="_blank" rel="noopener noreferrer" className="text-accent-400 hover:underline">
                  {t("aiFeatures.pricesVerified", { date: data.pricesVerifiedOn })}
                </a>
              </p>
            )}
            <div>
              <h4 className="text-sm font-semibold text-white">{t("subtitleGen.admin.spendTitle")}</h4>
              <p className="mt-1 text-sm text-muted">{t("subtitleGen.admin.spend", { spent: usd(data.month.cost), budget: usd(data.budgetUsd) })}</p>
              <p className="text-xs text-subtle">{t("aiFeatures.spendAll")}</p>
              {data.budgetReached && (
                <p data-ai-budget-reached="" className="mt-1 text-sm text-warning">
                  {t("aiFeatures.budgetReached")}
                </p>
              )}
              <p className="text-xs text-subtle">
                {readRate === null
                  ? t("subtitleGen.admin.usageRequests", { requests: data.month.requests || 0 })
                  : t("subtitleGen.admin.usage", { requests: data.month.requests, rate: readRate })}
              </p>
            </div>
            {data.features && <AiFeaturesBlock provider={data.provider} statuses={data.features} />}
          </div>
        )}
      </section>
    </div>
  );
}

/** Les tâches des sous-titres générés, sous la carte de la fonction : reprendre, annuler. */
export function SubtitleJobs() {
  const t = useT();
  const toast = useToast();
  const { data, mutate } = useAiAdmin();
  const [acting, setActing] = useState<string | null>(null);

  async function act(jobId: string, action: "resume" | "cancel") {
    setActing(jobId);
    const url = action === "resume" ? `/api/subtitle-gen/jobs/${jobId}/resume` : `/api/subtitle-gen/admin/jobs/${jobId}/cancel`;
    const res = await fetch(url, { method: "POST" }).catch(() => null);
    setActing(null);
    if (!res?.ok) toast.error(t("subtitleGen.admin.actionFailed"));
    await mutate();
  }

  if (!data) return null;
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-subtitle-jobs="">
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
    </section>
  );
}

/**
 * La part de l'entrée relue du cache, en pour cent — `null` sans requête ce mois-ci. Un mois vide
 * renvoie des sommes nulles (`SUM` sur aucune ligne), et la page disait « NaN % de l'entrée relue
 * du cache » (installation neuve, 13/10/2026).
 */
export function cacheReadRate(month: { inputTokens: number | null; cacheWriteTokens: number | null; cacheReadTokens: number | null; requests: number | null } | null | undefined): number | null {
  if (!month || !month.requests) return null;
  const read = month.cacheReadTokens ?? 0;
  const total = (month.inputTokens ?? 0) + (month.cacheWriteTokens ?? 0) + read;
  const rate = Math.round((read / Math.max(1, total)) * 100);
  return Number.isFinite(rate) ? rate : null;
}
