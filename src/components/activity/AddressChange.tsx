"use client";

import useSWR from "swr";
import { ArrowLeftRight } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { Avatar, Panel, ago, uiLocale } from "@/components/activity/parts";
import type { AddressChangeOverview, AddressChangeStatus } from "@/lib/activity/addressChange";

export const ADDRESS_CHANGE_KEY = "/api/admin/activity/address";

const STATUS_TONE: Record<AddressChangeStatus, string> = {
  movedInstalled: "text-success",
  moved: "text-accent-400",
  old: "text-warning",
  unknown: "text-muted",
  never: "text-subtle",
};

/**
 * Le changement d'adresse, compte par compte (DECISIONS.md §119) : qui ouvre déjà la nouvelle, en
 * application installée ou non, et qui passe encore par l'ancienne — ceux-là en tête. Rien tant
 * qu'aucune nouvelle adresse n'est annoncée (`newHost: null`) : la plupart des installations n'en
 * changent jamais.
 */
export function AddressChangePanel() {
  const t = useT();
  const { data } = useSWR<AddressChangeOverview>(ADDRESS_CHANGE_KEY, fetcher, { refreshInterval: 60_000 });
  if (!data?.newHost) return null;
  const { now, rows } = data;
  const moved = rows.filter((r) => r.status === "moved" || r.status === "movedInstalled").length;
  const installed = rows.filter((r) => r.status === "movedInstalled").length;
  const date = new Date(data.since).toLocaleDateString(uiLocale(), { day: "numeric", month: "long", year: "numeric" });
  return (
    <Panel
      title={t("activity.addressChange.title")}
      icon={ArrowLeftRight}
      action={<span className="text-xs tabular-nums text-muted">{t("activity.addressChange.summary", { moved, total: rows.length, installed })}</span>}
    >
      <p className="border-b border-white/5 px-4 py-2.5 text-xs leading-relaxed text-subtle">{t("activity.addressChange.intro", { host: data.newHost, date })}</p>
      {rows.length ? (
        <ul className="divide-y divide-white/5" data-testid="address-change-rows">
          {rows.map((r) => (
            <li key={r.user} className="grid grid-cols-[auto_1fr] items-center gap-3 px-4 py-2.5 md:grid-cols-[auto_minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
              <Avatar name={r.user} size={32} />
              <span className="min-w-0">
                <span className="block truncate font-medium text-white">{r.user}</span>
                <span className={`block text-xs ${STATUS_TONE[r.status]}`}>{t(`activity.addressChange.status.${r.status}`)}</span>
                {/* Sur téléphone, les colonnes ci-dessous sont masquées : les deux dates en une ligne. */}
                <span className="mt-0.5 block truncate text-[11px] text-subtle md:hidden">
                  {t("activity.addressChange.lastOld")} {ago(r.lastOld, now, t)} · {t("activity.addressChange.lastNew")} {ago(r.lastNew, now, t)}
                </span>
              </span>
              <span className="hidden text-xs md:block">
                <span className="block text-subtle">{t("activity.addressChange.lastOld")}</span>
                <span className="text-muted">{ago(r.lastOld, now, t)}</span>
              </span>
              <span className="hidden text-xs md:block">
                <span className="block text-subtle">{t("activity.addressChange.lastNew")}</span>
                <span className="text-muted">{ago(r.lastNew, now, t)}</span>
              </span>
              <span className="hidden text-xs md:block">
                <span className="block text-subtle">{t("activity.addressChange.passage")}</span>
                <span className="text-muted">
                  {r.passageReceived
                    ? t("activity.addressChange.received", { when: ago(r.passageReceived, now, t) })
                    : r.passageRequested
                      ? t("activity.addressChange.requested", { when: ago(r.passageRequested, now, t) })
                      : "—"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-6 text-sm text-subtle">{t("activity.addressChange.none")}</p>
      )}
    </Panel>
  );
}
