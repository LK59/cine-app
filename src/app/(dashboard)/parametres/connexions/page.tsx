"use client";

import { useMemo, useState } from "react";
import { ErrorState } from "@/components/StateViews";
import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { AdminPasswordCard } from "@/components/settings/AdminPasswordCard";
import { DeploymentGuide, SettingsGroupCard, type Draft } from "@/components/settings/SettingsGroupCard";
import { SETTINGS_BY_KEY, SETTING_GROUPS, type SettingGroup, type SettingView } from "@/lib/settings/schema";

/**
 * « Réglages serveur » (« Connexions » jusqu'au 07/10/2026, l'adresse est restée) — les adresses et
 * les clés des services, et les réglages par défaut des comptes, réglables à tout moment
 * (DECISIONS.md §48, §52). Les mêmes cartes que l'assistant de premier lancement ; une valeur réglée ici
 * remplace celle du .env, et « Revenir à la valeur du .env » rend la main au fichier.
 */
type SettingsPayload = { settings: SettingView[]; missing: string[] };

export default function ConnexionsPage() {
  const t = useT();
  const toast = useToast();
  const { data, error, mutate } = useSWR<SettingsPayload>("/api/settings", fetcher);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<SettingGroup | null>(null);
  const views = useMemo(() => new Map((data?.settings ?? []).map((v) => [v.key, v])), [data]);

  async function save(group: SettingGroup) {
    const values = Object.fromEntries(Object.entries(draft).filter(([k]) => SETTINGS_BY_KEY.get(k)?.group === group));
    if (Object.keys(values).length === 0) return;
    setSaving(group);
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
      const body = (await res.json().catch(() => null)) as { errors?: Record<string, string> } | null;
      if (!res.ok) {
        setErrors((e) => ({ ...e, ...(body?.errors ?? {}) }));
        toast.error(t("setup.errors.save"));
        return;
      }
      setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !(k in values))));
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !(k in values))));
      await mutate();
      toast.success(t("setup.saved"));
    } catch {
      // Le réseau, et non un refus : sans ce `catch`, une rejection non gérée et aucun message.
      toast.error(t("setup.errors.save"));
    } finally {
      setSaving(null);
    }
  }

  async function reset(key: string) {
    // Un refus ou une coupure se disent : la remise à zéro échouait sans un mot (08/10/2026).
    const res = await fetch(`/api/settings?key=${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      toast.error(t("setup.errors.save"));
      return;
    }
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
    await mutate();
  }

  return (
    <div>
      <PageHeader title={t("setup.settings.title")} subtitle={t("setup.settings.subtitle")} />
      {!data && error ? (
        // Une erreur n'est pas un chargement : le cercle tournait pour toujours.
        <ErrorState message={t("common.error")} onRetry={() => void mutate()} />
      ) : !data ? (
        <Loader2 className="animate-spin text-subtle" />
      ) : (
        <div className="max-w-3xl space-y-4">
          {data.missing.length > 0 && (
            <p className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
              {t("setup.missing", { list: data.missing.map((m) => (m.includes("|") ? t("setup.need.library") : t(`setup.fields.${m}`))).join(", ") })}
            </p>
          )}
          {SETTING_GROUPS.filter((g) => g !== "deployment").map((group) => {
            const dirty = Object.keys(draft).some((k) => SETTINGS_BY_KEY.get(k)?.group === group);
            return (
              <SettingsGroupCard
                key={group}
                group={group}
                views={views}
                draft={draft}
                errors={errors}
                onDraft={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
                onReset={reset}
                footer={
                  <div className="mt-4 flex justify-end">
                    <button type="button" onClick={() => save(group)} disabled={!dirty || saving !== null} className="btn btn-primary">
                      {saving === group ? <Loader2 size={15} className="animate-spin" /> : null}
                      {saving === group ? t("setup.saving") : t("setup.save")}
                    </button>
                  </div>
                }
              />
            );
          })}
          <DeploymentGuide />
          <AdminPasswordCard />
        </div>
      )}
    </div>
  );
}
