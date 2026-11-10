"use client";

import Link from "next/link";
import useSWR from "swr";
import { useMemo } from "react";
import { CircleAlert } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { NEED_HREF, missingNeeds, type ConfigNeed } from "@/lib/settings/configLayout";
import type { SettingView } from "@/lib/settings/schema";

/**
 * Ce dont une fonction a besoin, dit de la même façon sur chaque carte (DECISIONS.md §142).
 *
 * Toujours écrit — « Nécessite : une clé d'IA, le service X-Ray » —, pour qu'on sache avant d'allumer
 * ce qui fera marcher la fonction. Quand l'un manque (d'après les réglages *enregistrés*), il passe en
 * avertissement avec un lien vers l'endroit où il se règle, et la carte s'estompe (`dimmed`).
 */
export function FeatureNeeds({ needs, missing }: { needs: readonly ConfigNeed[]; missing: readonly ConfigNeed[] }) {
  const t = useT();
  if (needs.length === 0) return null;
  const ok = needs.filter((n) => !missing.includes(n));
  return (
    <div className="space-y-1 text-xs" data-feature-needs="">
      {missing.map((need) => (
        <p key={need} className="flex flex-wrap items-center gap-x-1.5 text-warning" data-need-missing={need}>
          <CircleAlert size={13} aria-hidden />
          {t("config.needs.missing", { need: t(`config.needs.${need}`) })}
          <Link href={NEED_HREF[need]} className="font-medium text-accent-400 hover:underline">
            {t(`config.needs.fix.${need}`)}
          </Link>
        </p>
      ))}
      {ok.length > 0 && (
        <p className="text-subtle" data-need-ok="">
          {t("config.needs.ready", { list: ok.map((n) => t(`config.needs.${n}`)).join(", ") })}
        </p>
      )}
    </div>
  );
}

/**
 * La même phrase pour une page dont la carte est propre (la synchro des sous-titres) : elle lit
 * elle-même les réglages enregistrés. Rien tant qu'ils ne sont pas arrivés.
 */
export function FeatureNeedsNotice({ needs }: { needs: readonly ConfigNeed[] }) {
  const { data } = useSWR<{ settings: SettingView[] }>("/api/settings", fetcher);
  const views = useMemo(() => new Map((data?.settings ?? []).map((v) => [v.key, v])), [data]);
  if (!data) return null;
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <FeatureNeeds needs={needs} missing={missingNeeds(needs, views)} />
    </div>
  );
}
