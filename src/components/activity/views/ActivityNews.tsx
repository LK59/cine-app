"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Clock, Eye, EyeOff, FilePlus2, Languages, MousePointerClick, Newspaper, Plus, RotateCcw, Sparkles, Trash2, Users, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { ConfirmButton, Panel, Tile, ago, secs, type T } from "@/components/activity/parts";
import { LOCALE_LABELS } from "@/lib/i18n";
import { NEWS_ICONS, NEWS_LANGS, isEmptyContent, type NewsContent, type NewsContentByLang, type NewsIcon, type NewsLang, type NewsPageView } from "@/lib/news/content";
import { NEWS_KEY } from "@/lib/news/events";
import type { NewsPageRow } from "@/lib/news/store";
import type { NewsAccountRow, NewsSynthesis } from "@/lib/news/summary";
import { NEWS_ICON_COMPONENTS } from "@/components/news/newsIcons";
import { NewsDialog } from "@/components/news/NewsDialog";

export const NEWS_ADMIN_KEY = "/api/admin/release-notes";

export interface NewsAdminData {
  now: number;
  pages: NewsPageRow[];
  accounts: NewsAccountRow[];
  synthesis: NewsSynthesis;
  translateAvailable: boolean;
}

const pct = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)} %`);

/** Les quatre chiffres de la dernière page — partagés par la vue d'ensemble et la vue dédiée. */
export function NewsTiles({ s }: { s: NewsSynthesis }) {
  const t = useT();
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile icon={Eye} label={t("activity.news.seen")} value={`${s.seen}/${s.accounts}`} hint={s.latest ? t("news.subtitle", { version: s.latest.version }) : undefined} />
      <Tile icon={Clock} label={t("activity.news.median")} value={s.medianShownMs === null ? "—" : secs(s.medianShownMs)} />
      <Tile icon={EyeOff} label={t("activity.news.notRead")} value={pct(s.notReadShare)} tone={s.notReadShare !== null && s.notReadShare > 0.5 ? "warn" : "default"} />
      <Tile icon={MousePointerClick} label={t("activity.news.seeMore")} value={pct(s.seeMoreShare)} hint={t("activity.news.pageViews", { n: s.pageViews })} />
    </div>
  );
}

function closedByLabel(by: string | null, t: T): string {
  if (!by) return "—";
  return t(`activity.news.closed.${by === "voir-plus" ? "seeMore" : by}`);
}

/**
 * Les Nouveautés vues de l'activité (DECISIONS.md §73) : où en est chaque compte, relancer la
 * fenêtre, et écrire la page suivante — en français, traduite ensuite, retouchée langue par langue,
 * enregistrée en brouillon puis publiée.
 */
export function ActivityNews() {
  const t = useT();
  const toast = useToast();
  const { mutate: mutateAny } = useSWRConfig();
  const { data, isLoading, mutate } = useSWR<NewsAdminData>(NEWS_ADMIN_KEY, fetcher, { refreshInterval: 30_000 });
  const [editing, setEditing] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<{ pages: NewsPageView[]; lang: NewsLang } | null>(null);

  if (isLoading && !data) return <LoadingState />;
  if (!data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;

  const refresh = async () => {
    await mutate();
    // Ce que voit le compte de l'administrateur lui-même (fenêtre, page Compte).
    await mutateAny(NEWS_KEY);
  };
  const act = async (url: string, init: RequestInit, done: string) => {
    try {
      await apiAction(url, init);
      await refresh();
      toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    }
  };
  const hasPublished = data.pages.some((p) => p.status === "published");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-400">{t("activity.news.intro")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {hasPublished && (
            <ConfirmButton
              label={t("activity.news.relaunchAll")}
              confirm={t("activity.news.relaunchAllConfirm")}
              onConfirm={() => act("/api/admin/release-notes/relaunch", { method: "POST", body: JSON.stringify({ all: true }) }, t("activity.news.relaunched"))}
            />
          )}
          <button type="button" onClick={() => setEditing(emptyDraft())} className="btn-primary px-3 py-1.5 text-xs">
            <FilePlus2 size={14} />
            {t("activity.news.newPage")}
          </button>
        </div>
      </div>

      <NewsTiles s={data.synthesis} />

      {editing && (
        <NewsEditor
          key={editing.id ?? "nouvelle"}
          initial={editing}
          translateAvailable={data.translateAvailable}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
          onPreview={(pages, lang) => setPreview({ pages, lang })}
        />
      )}

      <Panel title={t("activity.news.pages")} icon={Newspaper}>
        {data.pages.length ? (
          <ul className="divide-y divide-white/5">
            {data.pages.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-white">{t("news.subtitle", { version: p.version })}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${p.status === "published" ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-500/20 text-slate-300"}`}>
                      {p.status === "published" ? t("activity.news.published") : t("activity.news.draft")}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {p.publishedAt ? t("activity.news.publishedAgo", { when: ago(p.publishedAt, data.now, t) }) : t("activity.news.editedAgo", { when: ago(p.updatedAt, data.now, t) })}
                    {" · "}
                    {NEWS_LANGS.filter((l) => l === "fr" || !isEmptyContent(p.content[l] ?? null)).map((l) => l.toUpperCase()).join(" ")}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <button type="button" onClick={() => setPreview({ pages: [viewOf(p)], lang: "fr" })} className="btn-ghost px-2.5 py-1 text-xs">
                    <Eye size={13} />
                    {t("activity.news.preview")}
                  </button>
                  <button type="button" onClick={() => setEditing(draftOf(p))} className="btn-ghost px-2.5 py-1 text-xs">
                    {t("activity.news.edit")}
                  </button>
                  {p.status === "draft" && (
                    <ConfirmButton
                      label={t("activity.news.publish")}
                      confirm={t("activity.news.publishConfirm")}
                      onConfirm={() => act(`/api/admin/release-notes/${p.id}/publish`, { method: "POST" }, t("activity.news.publishedDone"))}
                    />
                  )}
                  <ConfirmButton
                    danger
                    label={t("activity.news.delete")}
                    confirm={t("activity.news.deleteConfirm")}
                    onConfirm={() => act(`/api/admin/release-notes/${p.id}`, { method: "DELETE" }, t("activity.news.deleted"))}
                  />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-slate-500">{t("activity.news.noPage")}</p>
        )}
      </Panel>

      <Panel title={t("activity.news.accounts", { n: data.accounts.length })} icon={Users}>
        <div className="divide-y divide-white/5">
          {data.accounts.map((a) => (
            <div key={a.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,1fr))_auto]">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium text-white">{a.name}</span>
                  {a.pending && <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] text-accent-300">{t("activity.news.pending")}</span>}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {a.unknown ? t("activity.news.never") : a.seenVersion ? t("activity.news.lastSeen", { version: a.seenVersion }) : t("activity.news.noneSeen")}
                </span>
                {/* Sur téléphone, les colonnes sont masquées : l'essentiel en une ligne. */}
                <span className="mt-0.5 block text-[11px] text-slate-500 md:hidden">{accountLine(a, data.now, t)}</span>
              </span>
              <Cell label={t("activity.news.shownAt")} value={a.shownAt ? ago(a.shownAt, data.now, t) : "—"} />
              <Cell label={t("activity.news.shownFor")} value={a.shownMs === null ? "—" : secs(a.shownMs)} warn={a.shownMs !== null && a.shownMs < 2000} />
              <Cell label={t("activity.news.closedBy")} value={`${closedByLabel(a.closedBy, t)}${a.scrolled ? ` · ${t("activity.news.scrolled")}` : ""}`} />
              <Cell
                label={t("activity.news.followUp")}
                value={[a.seeMore ? t("activity.news.closed.seeMore") : null, a.pageAt ? t("activity.news.pageSeen") : null].filter(Boolean).join(" · ") || "—"}
              />
              <span className="justify-self-end">
                {hasPublished && (
                  <button
                    type="button"
                    onClick={() => void act("/api/admin/release-notes/relaunch", { method: "POST", body: JSON.stringify({ user: a.name }) }, t("activity.news.relaunched"))}
                    className="btn-ghost px-2.5 py-1 text-xs"
                    title={t("activity.news.relaunch")}
                    aria-label={`${t("activity.news.relaunch")} — ${a.name}`}
                  >
                    <RotateCcw size={13} />
                    <span className="hidden sm:inline">{t("activity.news.relaunch")}</span>
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </Panel>

      {preview && <NewsDialog pages={preview.pages} auto preview lang={preview.lang} onClose={() => setPreview(null)} />}
    </div>
  );
}

function accountLine(a: NewsAccountRow, now: number, t: T): string {
  if (!a.shownAt) return "—";
  return [ago(a.shownAt, now, t), a.shownMs === null ? null : secs(a.shownMs), a.closedBy ? closedByLabel(a.closedBy, t) : null].filter(Boolean).join(" · ");
}

function Cell({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <span className="hidden text-xs md:block">
      <span className="block text-slate-500">{label}</span>
      <span className={warn ? "text-amber-300" : "text-slate-300"}>{value}</span>
    </span>
  );
}

// ─── L'éditeur ────────────────────────────────────────────────────────────────

interface Draft {
  id: number | null;
  version: string;
  content: Record<NewsLang, NewsContent>;
}

const blank = (): NewsContent => ({ sections: [], fixesSummary: "", fixes: [] });

function emptyDraft(): Draft {
  return {
    id: null,
    version: "",
    content: {
      fr: { sections: [{ title: "Nouveau", entries: [{ icon: "sparkles", title: "", text: "", badge: "" }] }], fixesSummary: "", fixes: [{ title: "", items: [] }] },
      en: blank(),
      es: blank(),
      de: blank(),
    },
  };
}

function draftOf(p: NewsPageRow): Draft {
  return {
    id: p.id,
    version: p.version,
    content: { fr: p.content.fr, en: p.content.en ?? blank(), es: p.content.es ?? blank(), de: p.content.de ?? blank() },
  };
}

function viewOf(p: NewsPageRow): NewsPageView {
  return { id: p.id, seq: p.seq ?? 0, version: p.version, publishedAt: p.publishedAt ?? p.updatedAt, content: p.content };
}

function byLang(content: Record<NewsLang, NewsContent>): NewsContentByLang {
  return { fr: content.fr, en: isEmptyContent(content.en) ? null : content.en, es: isEmptyContent(content.es) ? null : content.es, de: isEmptyContent(content.de) ? null : content.de };
}

function NewsEditor({
  initial,
  translateAvailable,
  onCancel,
  onSaved,
  onPreview,
}: {
  initial: Draft;
  translateAvailable: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onPreview: (pages: NewsPageView[], lang: NewsLang) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(initial);
  const [lang, setLang] = useState<NewsLang>("fr");
  const [busy, setBusy] = useState<"save" | "translate" | null>(null);
  const c = draft.content[lang];
  const setContent = (next: NewsContent) => setDraft((d) => ({ ...d, content: { ...d.content, [lang]: next } }));

  const translate = async () => {
    setBusy("translate");
    try {
      const out = (await apiAction("/api/admin/release-notes/translate", { method: "POST", body: JSON.stringify({ fr: draft.content.fr }) })) as Record<"en" | "es" | "de", NewsContent>;
      setDraft((d) => ({ ...d, content: { ...d.content, en: out.en, es: out.es, de: out.de } }));
      toast.success(t("activity.news.translated"));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      const body = JSON.stringify({ version: draft.version, content: byLang(draft.content) });
      if (draft.id === null) await apiAction("/api/admin/release-notes", { method: "POST", body });
      else await apiAction(`/api/admin/release-notes/${draft.id}`, { method: "PUT", body });
      toast.success(t("activity.news.saved"));
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    } finally {
      setBusy(null);
    }
  };

  const updateSection = (i: number, patch: Partial<NewsContent["sections"][number]>) =>
    setContent({ ...c, sections: c.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const updateEntry = (i: number, k: number, patch: Partial<NewsContent["sections"][number]["entries"][number]>) =>
    updateSection(i, { entries: c.sections[i].entries.map((e, j) => (j === k ? { ...e, ...patch } : e)) });
  const updateGroup = (i: number, patch: Partial<NewsContent["fixes"][number]>) =>
    setContent({ ...c, fixes: c.fixes.map((g, j) => (j === i ? { ...g, ...patch } : g)) });

  const empty = isEmptyContent(c);

  return (
    <Panel
      title={draft.id === null ? t("activity.news.newPage") : t("activity.news.editing", { version: initial.version })}
      icon={Sparkles}
      action={
        <button type="button" onClick={onCancel} className="btn-ghost px-2 py-1 text-xs" aria-label={t("activity.news.cancel")}>
          <X size={14} />
        </button>
      }
    >
      <div className="space-y-5 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-slate-400">{t("activity.news.version")}</span>
            <input className="input w-32" value={draft.version} maxLength={20} placeholder="8.45" onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))} />
          </label>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("activity.news.language")}>
            {NEWS_LANGS.map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={l === lang}
                onClick={() => setLang(l)}
                className={`rounded-lg px-3 py-1.5 text-xs ${l === lang ? "bg-white/15 text-white" : "text-slate-400 hover:text-white"}`}
              >
                {LOCALE_LABELS[l]}
                {l !== "fr" && isEmptyContent(draft.content[l]) && <span className="ml-1 text-slate-500">·</span>}
              </button>
            ))}
          </div>
          <button type="button" disabled={!translateAvailable || busy !== null || isEmptyContent(draft.content.fr)} onClick={() => void translate()} className="btn-ghost px-3 py-1.5 text-xs">
            <Languages size={14} />
            {busy === "translate" ? t("activity.news.translating") : t("activity.news.translate")}
          </button>
        </div>
        {!translateAvailable && <p className="text-xs text-slate-500">{t("activity.news.translateUnavailable")}</p>}
        {lang !== "fr" && empty && <p className="text-xs text-amber-300">{t("activity.news.fallbackFr")}</p>}

        {c.sections.map((section, i) => (
          <fieldset key={i} className="space-y-3 rounded-xl border border-white/10 p-3">
            <div className="flex items-center gap-2">
              <input
                className="input flex-1 text-xs uppercase tracking-wider"
                value={section.title}
                maxLength={40}
                placeholder={t("activity.news.sectionTitle")}
                aria-label={t("activity.news.sectionTitle")}
                onChange={(e) => updateSection(i, { title: e.target.value })}
              />
              <button type="button" onClick={() => setContent({ ...c, sections: c.sections.filter((_, j) => j !== i) })} className="btn-ghost px-2 py-1 text-xs text-rose-300" aria-label={t("activity.news.removeSection")}>
                <Trash2 size={13} />
              </button>
            </div>
            {section.entries.map((entry, k) => (
              <EntryEditor
                key={k}
                entry={entry}
                lang={lang}
                onChange={(patch) => updateEntry(i, k, patch)}
                onRemove={() => updateSection(i, { entries: section.entries.filter((_, j) => j !== k) })}
              />
            ))}
            <button type="button" onClick={() => updateSection(i, { entries: [...section.entries, { icon: "sparkles", title: "", text: "", badge: "" }] })} className="btn-ghost px-2.5 py-1 text-xs">
              <Plus size={13} />
              {t("activity.news.addEntry")}
            </button>
          </fieldset>
        ))}
        <button type="button" onClick={() => setContent({ ...c, sections: [...c.sections, { title: "", entries: [{ icon: "sparkles", title: "", text: "", badge: "" }] }] })} className="btn-ghost px-2.5 py-1 text-xs">
          <Plus size={13} />
          {t("activity.news.addSection")}
        </button>

        <fieldset className="space-y-3 rounded-xl border border-white/10 p-3">
          <legend className="px-1 text-xs text-slate-400">{t("news.fixesTitle")}</legend>
          <input
            className="input w-full"
            value={c.fixesSummary}
            maxLength={160}
            placeholder={t("activity.news.fixesSummary")}
            aria-label={t("activity.news.fixesSummary")}
            onChange={(e) => setContent({ ...c, fixesSummary: e.target.value })}
          />
          {c.fixes.map((group, i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  className="input flex-1"
                  value={group.title}
                  maxLength={40}
                  placeholder={t("activity.news.fixGroup")}
                  aria-label={t("activity.news.fixGroup")}
                  onChange={(e) => updateGroup(i, { title: e.target.value })}
                />
                <button type="button" onClick={() => setContent({ ...c, fixes: c.fixes.filter((_, j) => j !== i) })} className="btn-ghost px-2 py-1 text-xs text-rose-300" aria-label={t("activity.news.remove")}>
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea
                className="input min-h-28 w-full font-normal"
                value={group.items.join("\n")}
                placeholder={t("activity.news.fixItems")}
                aria-label={t("activity.news.fixItems")}
                onChange={(e) => updateGroup(i, { items: e.target.value.split("\n") })}
              />
            </div>
          ))}
          <button type="button" onClick={() => setContent({ ...c, fixes: [...c.fixes, { title: "", items: [] }] })} className="btn-ghost px-2.5 py-1 text-xs">
            <Plus size={13} />
            {t("activity.news.addFixGroup")}
          </button>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy !== null || !draft.version.trim() || isEmptyContent(draft.content.fr)} onClick={() => void save()} className="btn-primary px-3 py-1.5 text-xs">
            {busy === "save" ? t("activity.news.saving") : draft.id === null ? t("activity.news.saveDraft") : t("activity.news.save")}
          </button>
          <button
            type="button"
            onClick={() => onPreview([{ id: draft.id ?? -1, seq: 0, version: draft.version || "—", publishedAt: Date.now(), content: byLang(draft.content) }], lang)}
            className="btn-ghost px-3 py-1.5 text-xs"
          >
            <Eye size={14} />
            {t("activity.news.preview")}
          </button>
          <button type="button" onClick={onCancel} className="btn-ghost px-3 py-1.5 text-xs">
            {t("activity.news.cancel")}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function EntryEditor({
  entry,
  lang,
  onChange,
  onRemove,
}: {
  entry: NewsContent["sections"][number]["entries"][number];
  lang: NewsLang;
  onChange: (patch: Partial<NewsContent["sections"][number]["entries"][number]>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const Icon = NEWS_ICON_COMPONENTS[entry.icon];
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
      <label className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.07] ring-1 ring-inset ring-white/10" title={t("activity.news.icon")}>
        <Icon size={16} aria-hidden />
        {/* La liste native, transparente par-dessus l'icône : choisie au clavier comme au doigt. */}
        <select
          className="absolute inset-0 cursor-pointer opacity-0"
          value={entry.icon}
          aria-label={t("activity.news.icon")}
          // L'icône est la même dans toutes les langues : la changer ailleurs qu'en français
          // créerait des pages qui ne se ressemblent pas d'une langue à l'autre.
          disabled={lang !== "fr"}
          onChange={(e) => onChange({ icon: e.target.value as NewsIcon })}
        >
          {NEWS_ICONS.map((name) => (
            <option key={name} value={name}>
              {t(`activity.news.icons.${name}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_6rem]">
        <input className="input" value={entry.title} maxLength={90} placeholder={t("activity.news.entryTitle")} aria-label={t("activity.news.entryTitle")} onChange={(e) => onChange({ title: e.target.value })} />
        <input className="input" value={entry.text} maxLength={240} placeholder={t("activity.news.entryText")} aria-label={t("activity.news.entryText")} onChange={(e) => onChange({ text: e.target.value })} />
        <input className="input" value={entry.badge} maxLength={16} placeholder={t("activity.news.entryBadge")} aria-label={t("activity.news.entryBadge")} onChange={(e) => onChange({ badge: e.target.value })} />
      </div>
      <button type="button" onClick={onRemove} className="btn-ghost px-2 py-1 text-xs text-rose-300" aria-label={t("activity.news.remove")}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}
