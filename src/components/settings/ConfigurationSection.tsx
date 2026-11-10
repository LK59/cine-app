"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { ErrorState } from "@/components/StateViews";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { SettingsGroupCard, type Draft } from "@/components/settings/SettingsGroupCard";
import { AiProviderCard, SubtitleJobs, useAiAdmin } from "@/components/settings/SubtitleGenCard";
import { featureStateLine } from "@/components/settings/AiFeaturesBlock";
import { FeatureNeeds } from "@/components/settings/FeatureNeeds";
import { missingNeeds, type ConfigCard } from "@/lib/settings/configLayout";
import { SETTINGS_BY_KEY, type SettingView } from "@/lib/settings/schema";
import type { AiFeatureId } from "@/lib/aiFeatureTable";

/**
 * Les cartes de réglages d'une page de Configuration (DECISIONS.md §48, §81, §142).
 *
 * La page « Réglages serveur » tenait toutes les cartes à la suite ; la Configuration les répartit
 * sur plusieurs pages, dont la disposition est écrite une fois (`CONFIG_LAYOUT`, configLayout.ts).
 * Le brouillon, l'enregistrement par carte, « Revenir à la valeur du .env » et l'avertissement de
 * ce qui manque sont écrits ici une fois, pour toutes.
 *
 * Une carte = un groupe du schéma, éventuellement réduit à quelques clés : l'assistant de premier
 * lancement fait déjà ainsi (`SettingsGroupCard` avec `keys`), et une carte n'enregistre que les
 * champs qu'elle montre. Une carte de fonction dit en plus ce dont elle a besoin et son état.
 */
export type { ConfigCard };

type SettingsPayload = { settings: SettingView[]; missing: string[] };

const cardId = (c: ConfigCard) => `${c.group}:${c.keys?.join(",") ?? "*"}`;

/** L'état d'une fonction en une ligne, lu du serveur (§140) ; rien tant qu'il n'est pas arrivé. */
function FeatureState({ id }: { id: AiFeatureId }) {
  const t = useT();
  const { data } = useAiAdmin();
  const status = data?.features?.find((f) => f.id === id);
  const line = featureStateLine(t, status, id);
  if (!line) return null;
  const warn = !!status?.blocked && status.audience !== "off";
  return (
    <p className={`mb-1 text-xs font-medium ${warn ? "text-warning" : status?.audience === "off" ? "text-subtle" : "text-success"}`} data-feature-state={id}>
      {line}
    </p>
  );
}

export function ConfigurationSection({ cards, showMissing = false }: { cards: readonly ConfigCard[]; showMissing?: boolean }) {
  const t = useT();
  const toast = useToast();
  const { data, error, mutate } = useSWR<SettingsPayload>("/api/settings", fetcher);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const views = useMemo(() => new Map((data?.settings ?? []).map((v) => [v.key, v])), [data]);

  const inCard = (card: ConfigCard, key: string) =>
    SETTINGS_BY_KEY.get(key)?.group === card.group && (!card.keys || card.keys.includes(key));

  async function save(card: ConfigCard) {
    const values = Object.fromEntries(Object.entries(draft).filter(([k]) => inCard(card, k)));
    if (Object.keys(values).length === 0) return;
    setSaving(cardId(card));
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
      const body = (await res.json().catch(() => null)) as { errors?: Record<string, string>; code?: string } | null;
      if (!res.ok) {
        setErrors((e) => ({ ...e, ...(body?.errors ?? {}) }));
        // Une adresse changée sans sa clé : le message dit quoi faire, pas seulement « échec ».
        toast.error(t(body?.code === "settings-secret-required" ? "setup.errors.secret-required" : "setup.errors.save"));
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

  // Une erreur n'est pas un chargement : le cercle tournait pour toujours.
  if (!data && error) return <ErrorState message={t("common.error")} onRetry={() => void mutate()} />;
  if (!data) return <Loader2 className="animate-spin text-subtle" />;

  const onDraft = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <div className="space-y-4">
      {showMissing && data.missing.length > 0 && (
        <p className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
          {t("setup.missing", { list: data.missing.map((m) => t(`setup.fields.${m}`)).join(", ") })}
        </p>
      )}
      {cards.map((card) => {
        const id = cardId(card);
        const dirty = Object.keys(draft).some((k) => inCard(card, k));
        const footer = (
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={() => save(card)} disabled={!dirty || saving !== null} className="btn btn-primary rounded-full">
              {saving === id ? <Loader2 size={15} className="animate-spin" /> : null}
              {saving === id ? t("setup.saving") : t("setup.save")}
            </button>
          </div>
        );
        // Le fournisseur d'IA commun a sa carte : modèle prérempli, dépense, tableau (§69, §140).
        if (card.special === "aiProvider") {
          return (
            <AiProviderCard
              key={id}
              keys={card.keys}
              titleKey={card.titleKey}
              anchor={card.anchor}
              views={views}
              draft={draft}
              errors={errors}
              onDraft={onDraft}
              onReset={reset}
              footer={footer}
            />
          );
        }
        const missing = missingNeeds(card.needs, views);
        return (
          <div key={id} className="space-y-3">
            <SettingsGroupCard
              group={card.group}
              keys={card.keys}
              titleKey={card.titleKey}
              whyKey={card.whyKey}
              anchor={card.anchor}
              status={card.feature ? <FeatureState id={card.feature} /> : undefined}
              needs={card.needs?.length ? <FeatureNeeds needs={card.needs} missing={missing} /> : undefined}
              dimmed={missing.length > 0}
              views={views}
              draft={draft}
              errors={errors}
              onDraft={onDraft}
              onReset={reset}
              footer={footer}
            />
            {card.after === "subtitleJobs" && <SubtitleJobs />}
          </div>
        );
      })}
    </div>
  );
}

/** L'enveloppe commune des pages de Configuration : la même largeur de lecture partout. */
export function ConfigurationPage({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="space-y-6">{children}</div>
    </div>
  );
}
