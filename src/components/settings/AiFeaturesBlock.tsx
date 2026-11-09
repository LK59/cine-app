"use client";

import { useT } from "@/components/TranslationProvider";
import { AI_FEATURES, type AiFeatureId } from "@/lib/aiFeatureTable";
import { PROVIDERS, type ProviderName } from "@/lib/subtitleGen/pricing";
import type { Audience } from "@/lib/featureAudience";

/**
 * « Ce que chaque fonction fait selon le fournisseur » (DECISIONS.md §140) — sous la carte des
 * réglages d'IA : pour chaque fonction, ce qu'elle fait, si elle coûte (appel payant) ou non (service
 * local), ce qu'elle demande, à qui elle est ouverte, ce qui l'en empêche, et ses différences chez
 * chacun des trois fournisseurs. Une seule liste (`AI_FEATURES`) ; l'état vient du serveur.
 */

export interface FeatureStatusView {
  id: AiFeatureId;
  audience: Audience;
  blocked: "provider" | "price" | "xray" | "budget" | null;
}

/** La phrase sous le réglage d'une fonction : coût, prérequis, et ce qui la bloque. */
export function featureNote(t: (key: string, vars?: Record<string, string | number>) => string, status: FeatureStatusView | undefined, id: AiFeatureId): string {
  const row = AI_FEATURES.find((f) => f.id === id);
  if (!row) return "";
  const parts = [t(row.paid ? "aiFeatures.paid" : "aiFeatures.free"), t("aiFeatures.needsLabel", { needs: row.needs.map((n) => t(`aiFeatures.needs.${n}`)).join(", ") })];
  if (status?.blocked && status.audience !== "off") parts.push(t(`aiFeatures.blocked.${status.blocked}`));
  return parts.join(" · ");
}

export const FEATURE_SETTING: Record<string, AiFeatureId> = Object.fromEntries(AI_FEATURES.map((f) => [f.setting, f.id]));

export function AiFeaturesBlock({ provider, statuses }: { provider: ProviderName; statuses: readonly FeatureStatusView[] }) {
  const t = useT();
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return (
    <div data-ai-features="">
      <h4 className="text-sm font-semibold text-white">{t("aiFeatures.title")}</h4>
      <p className="mt-1 text-xs leading-5 text-subtle">{t("aiFeatures.intro")}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-xs">
          <thead>
            <tr className="text-subtle">
              <th className="py-1.5 pr-3 font-medium">{t("aiFeatures.feature")}</th>
              {PROVIDERS.map((p) => (
                <th key={p} className={`py-1.5 pr-3 font-medium ${p === provider ? "text-white" : ""}`}>
                  {t(`aiFeatures.providers.${p}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {AI_FEATURES.map((f) => {
              const status = byId.get(f.id);
              return (
                <tr key={f.id} data-ai-feature={f.id} className="align-top">
                  <td className="py-2 pr-3">
                    <p className="font-medium text-white">{t(`aiFeatures.names.${f.id}`)}</p>
                    <p className="text-subtle">{t(`aiFeatures.what.${f.id}`)}</p>
                    <p className="text-subtle">
                      {status ? t(`setup.audience.${status.audience}`) : ""}
                      {status?.blocked && status.audience !== "off" ? <span className="text-warning"> · {t(`aiFeatures.blocked.${status.blocked}`)}</span> : null}
                    </p>
                  </td>
                  {PROVIDERS.map((p) => {
                    const notes = f.providers[p];
                    return (
                      <td key={p} className={`py-2 pr-3 ${p === provider ? "text-white" : "text-muted"}`}>
                        {!f.paid ? t("aiFeatures.noProvider") : notes ? notes.map((n) => t(`aiFeatures.notes.${n}`)).join(" · ") : t("aiFeatures.unsupported")}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-5 text-subtle">{t("aiFeatures.quality")}</p>
    </div>
  );
}
