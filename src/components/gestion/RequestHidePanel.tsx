"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Check, EyeOff, Eye, Film, Loader2, Search, Tv } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useT, useLocale } from "@/components/TranslationProvider";
import { getDateLocale } from "@/lib/i18n";
import { useToast } from "@/components/Toast";
import { useErrorText } from "@/lib/useErrorText";
import { Toggle } from "@/components/Toggle";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/StateViews";
import { Poster } from "@/components/activity/parts";
import type { RequestHideView } from "@/lib/requestHide/run";
import type { ViewItem, ViewStatus } from "@/lib/requestHide/rules";

/**
 * Le masquage des demandes pour un compte (`requestHide/`) : les titres que d'autres comptes que les
 * comptes gardés ont demandés, à cacher au compte visé — par lot pour le passé, un à un au besoin,
 * et en continu pour ce qui sera demandé ensuite.
 */

export const REQUEST_HIDE_KEY = "/api/admin/request-hide";
const PAGE = 120;

// Chaque titre de la bibliothèque est dans un onglet, et « Tout » est leur somme : « Gardés » (demandés
// par un compte gardé) et « Non demandés » (ajoutés directement) en ont un pour que l'écart se lise, et
// qu'un titre jamais demandé se trouve et se masque comme les autres.
type Filter = "candidate" | "hidden" | "shown" | "kept" | "free" | "all";
const FILTERS: Filter[] = ["candidate", "hidden", "shown", "kept", "free", "all"];

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const BADGE: Record<ViewStatus, string> = {
  candidate: "bg-warning/10 text-warning",
  hidden: "bg-danger/10 text-danger",
  shown: "bg-white/8 text-white",
  kept: "bg-success/10 text-success",
  free: "bg-white/5 text-subtle",
};

export function RequestHidePanel() {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const errorText = useErrorText();
  const [filter, setFilter] = useState<Filter>("candidate");
  const [query, setQuery] = useState("");
  const [who, setWho] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<RequestHideView>(REQUEST_HIDE_KEY, fetcher, {
    // Tant que Jellyfin n'a pas rattrapé la liste, l'écran se relit pour montrer l'avancée.
    refreshInterval: (latest) => (latest && (latest.syncing || latest.items.some((i) => !i.applied)) ? 4000 : 0),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { candidate: 0, hidden: 0, shown: 0, kept: 0, free: 0, all: 0 };
    for (const i of items) {
      c[i.status]++;
      c.all++;
    }
    return c;
  }, [items]);
  const requesters = useMemo(() => [...new Set(items.flatMap((i) => i.requesters))].sort((a, b) => a.localeCompare(b)), [items]);
  const pending = items.filter((i) => !i.applied).length;

  const visible = useMemo(() => {
    const q = fold(query.trim());
    return items
      .filter((i) => filter === "all" || i.status === filter)
      .filter((i) => !q || fold(i.name).includes(q))
      .filter((i) => !who || i.requesters.includes(who))
      .sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0) || a.name.localeCompare(b.name));
  }, [items, filter, query, who]);

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={errorText(error)} onRetry={() => void mutate()} />;

  const allSelected = visible.length > 0 && visible.every((i) => selected.has(i.key));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((i) => i.key)));
  const toggleOne = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function apply(keys: string[], state: "hidden" | "shown") {
    if (keys.length === 0 || busy) return;
    setBusy(true);
    const titles = Object.fromEntries(items.filter((i) => keys.includes(i.key)).map((i) => [i.key, i.name]));
    try {
      await apiAction(REQUEST_HIDE_KEY, { method: "POST", body: JSON.stringify({ keys, state, titles }) });
      // L'état change tout de suite à l'écran ; « en cours » tant que Jellyfin n'a pas suivi.
      const set = new Set(keys);
      await mutate(
        (cur) => cur && { ...cur, syncing: true, items: cur.items.map((i) => (set.has(i.key) ? { ...i, status: state, source: "manual" as const, applied: false } : i)) },
        { revalidate: false },
      );
      setSelected(new Set());
      toast.success(t(state === "hidden" ? "requestHide.doneHidden" : "requestHide.doneShown", { n: keys.length, account: data!.account }));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function setAuto(on: boolean) {
    try {
      await apiAction(REQUEST_HIDE_KEY, { method: "POST", body: JSON.stringify({ auto: on }) });
      await mutate();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const dateFmt = new Intl.DateTimeFormat(getDateLocale(locale), { dateStyle: "medium", timeStyle: "short" });
  const selectedKeys = [...selected];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("requestHide.title", { account: data.account })} subtitle={t("requestHide.subtitle", { keep: data.keep.join(", ") || "—" })} />

      <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-white">{t("requestHide.auto")}</p>
            <p className="mt-0.5 text-xs text-subtle">
              {data.autoSince ? t("requestHide.autoSince", { date: dateFmt.format(new Date(data.autoSince)), account: data.account }) : t("requestHide.autoOff", { account: data.account })}
            </p>
          </div>
          <Toggle checked={data.autoSince !== null} onChange={(v) => void setAuto(v)} ariaLabel={t("requestHide.auto")} />
        </div>
        <p className="flex items-center gap-1.5 text-xs text-subtle" aria-live="polite">
          {data.last?.error ? (
            <span className="text-danger">{t("requestHide.syncError", { error: data.last.error })}</span>
          ) : pending > 0 || data.syncing ? (
            <>
              <Loader2 size={12} className="animate-spin" /> {t("requestHide.syncing", { n: pending })}
            </>
          ) : (
            <>
              <Check size={12} /> {t("requestHide.synced")}
            </>
          )}
        </p>
      </section>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              setFilter(f);
              setSelected(new Set());
              setShown(PAGE);
            }}
            className={`rounded-full px-3 py-1.5 text-sm transition-colors ${filter === f ? "bg-white text-black" : "bg-white/5 text-muted hover:bg-white/10"}`}
          >
            {t(`requestHide.filters.${f}`)} <span className="opacity-60">{counts[f]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-48 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            className="input w-full pl-8"
            placeholder={t("requestHide.search")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
          />
        </label>
        <select className="select" value={who} onChange={(e) => setWho(e.target.value)} aria-label={t("requestHide.requester")}>
          <option value="">{t("requestHide.everyone")}</option>
          {requesters.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-ink/90 px-3 py-2 backdrop-blur">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={visible.length === 0} />
          {t("requestHide.selectAll", { n: visible.length })}
        </label>
        <span className="flex-1" />
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy || selectedKeys.length === 0} onClick={() => void apply(selectedKeys, "shown")}>
          <Eye size={14} /> {t("requestHide.show", { n: selectedKeys.length })}
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || selectedKeys.length === 0} onClick={() => void apply(selectedKeys, "hidden")}>
          <EyeOff size={14} /> {t("requestHide.hide", { n: selectedKeys.length })}
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-subtle">{t("requestHide.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-white/5 rounded-xl border border-white/10 bg-white/5">
          {visible.slice(0, shown).map((item) => (
            <Row key={item.key} item={item} checked={selected.has(item.key)} onCheck={() => toggleOne(item.key)} onAct={(state) => void apply([item.key], state)} busy={busy} />
          ))}
        </ul>
      )}
      {visible.length > shown && (
        <button type="button" className="btn btn-ghost self-center" onClick={() => setShown((n) => n + PAGE)}>
          {t("requestHide.more", { n: visible.length - shown })}
        </button>
      )}
    </div>
  );
}

function Row({ item, checked, onCheck, onAct, busy }: { item: ViewItem; checked: boolean; onCheck: () => void; onAct: (state: "hidden" | "shown") => void; busy: boolean }) {
  const t = useT();
  const hidden = item.status === "hidden";
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <input type="checkbox" checked={checked} onChange={onCheck} aria-label={item.name} />
      <Poster itemId={item.jfId} tag={item.imageTag} className="h-14 w-10" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm text-white">
          {item.kind === "series" ? <Tv size={13} className="shrink-0 text-subtle" /> : <Film size={13} className="shrink-0 text-subtle" />}
          <span className="truncate">{item.name}</span>
          {item.year ? <span className="shrink-0 text-subtle">({item.year})</span> : null}
        </p>
        <p className="mt-0.5 truncate text-xs text-subtle">
          {item.requesters.length > 0 ? t("requestHide.requestedBy", { who: item.requesters.join(", ") }) : t("requestHide.notRequested")}
        </p>
      </div>
      <span className={`hidden shrink-0 rounded-full px-2 py-0.5 text-xs sm:inline ${BADGE[item.status]}`}>
        {t(`requestHide.status.${item.status}`)}
        {item.source === "auto" ? ` · ${t("requestHide.auto_short")}` : ""}
        {!item.applied ? " …" : ""}
      </span>
      {item.otherBlock && item.status !== "hidden" ? (
        <span className="hidden shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-xs text-subtle sm:inline">{t("requestHide.otherBlock", { tag: item.otherBlock })}</span>
      ) : null}
      <button type="button" className="btn btn-ghost btn-sm shrink-0" disabled={busy} onClick={() => onAct(hidden ? "shown" : "hidden")} aria-label={t(hidden ? "requestHide.showOne" : "requestHide.hideOne")}>
        {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
        <span className="hidden sm:inline">{t(hidden ? "requestHide.showOne" : "requestHide.hideOne")}</span>
      </button>
    </li>
  );
}
