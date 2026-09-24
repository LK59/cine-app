"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, Check, ChevronRight, Film, Lightbulb, Loader2, MessageSquareWarning, Pencil, Save, Search, Send, Trash2, Tv } from "lucide-react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { apiAction } from "@/lib/apiAction";
import { cinemaClose, cinemaNavigate } from "@/lib/cinemaRoute";
import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/swr";
import { cinemaFetcher } from "@/lib/cinemaPayload";
import { searchCinemaLibrary } from "@/lib/cinemaSearch";
import { ISSUE_SETS, OTHER, REPORT_ZONES, issueSetFor, needsTitle, reportPathParts, zoneOf, type ReportNode } from "@/lib/reportTaxonomy";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload } from "@/app/api/cinema/series/route";
import type { ReportDetail } from "@/lib/reports";
import { ImagePicker, MAX_PICKED } from "./ImagePicker";
import { appendImages, reportContext } from "./prepareImage";
import { useRefreshReports } from "./reportCache";
import { reportErrorText } from "./reportErrors";
import { escapeBlurs } from "./escapeBlurs";

type Step = "zone" | "element" | "title" | "issue" | "describe";

interface Draft {
  zone: string;
  element: string | null;
  elementOther: string;
  issue: string | null;
  issueOther: string;
  item: { id: string | null; title: string; kind: "movie" | "series" | null } | null;
  description: string;
}

const EMPTY: Draft = { zone: "", element: null, elementOther: "", issue: null, issueOther: "", item: null, description: "" };

/** Les étapes de ce chemin : chaque niveau n'existe que si la zone le demande. */
function stepsFor(draft: Draft): Step[] {
  const zone = zoneOf(draft.zone);
  const steps: Step[] = ["zone"];
  if (!zone) return steps;
  if (zone.children?.length) steps.push("element");
  if (needsTitle(zone)) steps.push("title");
  if (issueSetFor(zone, draft.element)) steps.push("issue");
  steps.push("describe");
  return steps;
}

/** Une ligne de choix, grande et franche — le doigt et le lecteur d'écran s'y retrouvent. */
function Choice({ label, selected, onClick, icon: Icon }: { label: string; selected: boolean; onClick: () => void; icon?: React.ElementType }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left text-sm transition-colors ${
        selected ? "border-accent-500/60 bg-accent-500/10 text-white" : "border-white/10 bg-white/5 text-white hover:bg-white/10"
      }`}
    >
      {Icon && <Icon size={17} className="shrink-0 text-muted" />}
      <span className="min-w-0 flex-1">{label}</span>
      {selected ? <Check size={16} className="shrink-0 text-accent-300" /> : <ChevronRight size={16} className="shrink-0 text-subtle" />}
    </button>
  );
}

/** « Autre (préciser) » : un choix de plus, et le champ qui dit lequel. */
function OtherChoice({ selected, value, onSelect, onChange, onDone }: { selected: boolean; value: string; onSelect: () => void; onChange: (v: string) => void; onDone: () => void }) {
  const t = useT();
  return (
    <div className="space-y-2">
      <Choice label={t("report.ui.other")} selected={selected} onClick={onSelect} />
      {selected && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onDone();
          }}
        >
          <input
            {...escapeBlurs}
            autoFocus
            value={value}
            maxLength={200}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("report.ui.otherPlaceholder")}
            className="input h-11 flex-1 text-sm"
          />
          <button type="submit" disabled={!value.trim()} className="btn btn-primary h-11 px-4 text-sm">
            {t("report.ui.next")}
          </button>
        </form>
      )}
    </div>
  );
}

/** Le choix du titre, dans la bibliothèque déjà chargée par l'accueil — aucune requête de plus. */
function TitleStep({ value, onPick }: { value: Draft["item"]; onPick: (item: NonNullable<Draft["item"]>) => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [query, setQuery] = useState(value?.title ?? "");
  const [free, setFree] = useState(value !== null && value.id === null);
  const { data: movies } = useSWR<CinemaMoviesPayload>(MOVIES_CATALOGUE_KEY, cinemaFetcher);
  const { data: series } = useSWR<CinemaSeriesPayload>(SERIES_CATALOGUE_KEY, cinemaFetcher);
  const results = useMemo(() => {
    const allMovies = [...(movies?.spotlight ?? []), ...Object.values(movies?.rows ?? {}).flat()];
    const allSeries = [...(series?.spotlight ?? []), ...Object.values(series?.rows ?? {}).flat()];
    const seen = new Set<string>();
    return searchCinemaLibrary(query, allMovies, allSeries, locale)
      .map((r) => ({ id: r.item.jellyfinItemId, title: r.item.title, year: r.item.year, poster: r.item.posterUrl, kind: r.kind }))
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .slice(0, 8);
  }, [query, movies, series, locale]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-subtle" />
        <input
          {...escapeBlurs}
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFree(false);
          }}
          placeholder={t("report.ui.titleSearch")}
          className="input h-11 w-full pl-9 text-sm"
        />
      </div>
      <div className="space-y-2">
        {results.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick({ id: r.id, title: r.title, kind: r.kind })}
            className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
              value?.id === r.id ? "border-accent-500/60 bg-accent-500/10" : "border-white/10 bg-white/5 hover:bg-white/10"
            }`}
          >
            {r.poster ? (
              // eslint-disable-next-line @next/next/no-img-element -- l'affiche déjà servie par le catalogue
              <img src={r.poster} alt="" className="h-12 w-8 shrink-0 rounded object-cover" />
            ) : (
              <span className="flex h-12 w-8 shrink-0 items-center justify-center rounded bg-white/5 text-subtle">
                {r.kind === "series" ? <Tv size={14} /> : <Film size={14} />}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-white">{r.title}</span>
              <span className="text-xs text-subtle">
                {r.year ?? ""} · {r.kind === "series" ? t("report.ui.series") : t("report.ui.movie")}
              </span>
            </span>
            {value?.id === r.id && <Check size={16} className="shrink-0 text-accent-300" />}
          </button>
        ))}
        {/* Le catalogue arrive encore quand on ouvre l'assistant sans être passé par l'accueil : « aucun
            titre » serait faux pendant ces quelques secondes. */}
        {query.trim().length >= 2 && results.length === 0 && (
          <p className="px-1 text-sm text-muted">{movies && series ? t("report.ui.titleNone") : t("report.ui.titleLoading")}</p>
        )}
      </div>
      {/* Le titre n'est pas dans la liste (il a disparu, il n'est pas encore arrivé) : on l'écrit. */}
      {!free ? (
        <button type="button" onClick={() => setFree(true)} className="text-sm text-accent-300 hover:underline">
          {t("report.ui.titleFree")}
        </button>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) onPick({ id: null, title: query.trim().slice(0, 200), kind: null });
          }}
        >
          <input {...escapeBlurs} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("report.ui.titleFreePlaceholder")} className="input h-11 flex-1 text-sm" />
          <button type="submit" disabled={!query.trim()} className="btn btn-primary h-11 px-4 text-sm">
            {t("report.ui.next")}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Où reprendre un brouillon : à la première question sans réponse. Rouvrir sur la description
 * laissait croire le chemin complet, et « Envoyer » restait gris sans dire pourquoi.
 */
function firstMissing(draft: Draft): Step {
  const zone = zoneOf(draft.zone);
  if (!zone) return "zone";
  if (zone.children?.length && (!draft.element || (draft.element === OTHER && !draft.elementOther.trim()))) return "element";
  if (needsTitle(zone) && !draft.item) return "title";
  if (issueSetFor(zone, draft.element) && (!draft.issue || (draft.issue === OTHER && !draft.issueOther.trim()))) return "issue";
  return "describe";
}

function fromDetail(d: ReportDetail): Draft {
  return {
    zone: d.zone,
    element: d.element,
    elementOther: d.elementOther ?? "",
    issue: d.issue,
    issueOther: d.issueOther ?? "",
    item: d.itemTitle ? { id: d.itemId, title: d.itemTitle, kind: d.itemKind === "movie" || d.itemKind === "series" ? d.itemKind : null } : null,
    description: d.description,
  };
}

/**
 * « Signaler un problème » — un assistant, un écran par question : la zone, l'élément, le titre
 * s'il en faut un, le type de souci, puis les mots et les captures. Chaque niveau propose
 * « Autre (préciser) ». On peut revenir sur chaque choix, et garder le tout en brouillon pour plus
 * tard. Les journaux utiles sont joints par le serveur à l'envoi : personne n'a à les chercher.
 */
export function ReportWizard({
  existing,
  fromList = false,
}: {
  existing?: ReportDetail;
  /**
   * Ouvert depuis « Mes signalements » : un brouillon enregistré ou supprimé y *revient* (retour
   * dans l'historique) au lieu d'y aller. Y aller par un remplacement laissait deux fois la liste
   * dans l'historique, et le premier « Retour » semblait ne rien faire (relu le 24/09/2026).
   */
  fromList?: boolean;
}) {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => (existing ? fromDetail(existing) : EMPTY));
  const [step, setStep] = useState<Step>(() => (existing ? firstMissing(fromDetail(existing)) : "zone"));
  const [files, setFiles] = useState<File[]>([]);
  const [kept, setKept] = useState(existing?.images ?? []);
  const [busy, setBusy] = useState(false);
  const refresh = useRefreshReports();

  const steps = stepsFor(draft);
  const index = Math.max(0, steps.indexOf(step));
  const zone = zoneOf(draft.zone);
  const set = zone ? issueSetFor(zone, draft.element) : null;
  const suggestion = zone?.suggestion === true;
  const tr = (key: string) => t(key);

  const advance = (next: Draft) => {
    const after = stepsFor(next);
    setDraft(next);
    setStep(after[after.indexOf(step) + 1] ?? "describe");
  };
  const back = () => setStep(steps[Math.max(0, index - 1)]);

  const payload = () => ({
    zone: draft.zone,
    element: draft.element,
    elementOther: draft.element === OTHER ? draft.elementOther : null,
    issue: draft.issue,
    issueOther: draft.issue === OTHER ? draft.issueOther : null,
    itemId: draft.item?.id ?? null,
    itemTitle: draft.item?.title ?? null,
    itemKind: draft.item?.kind ?? null,
    description: draft.description,
  });

  const submit = async (send: boolean) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("report", JSON.stringify(payload()));
      form.set("context", JSON.stringify(reportContext(locale)));
      await appendImages(form, files);
      let saved: ReportDetail;
      if (existing) {
        if (send) form.set("send", "1");
        saved = (await apiAction(`/api/reports/${existing.id}`, { method: "PUT", body: form })) as ReportDetail;
      } else {
        if (!send) form.set("draft", "1");
        saved = (await apiAction("/api/reports", { method: "POST", body: form })) as ReportDetail;
      }
      const id = saved.id;
      await refresh(saved);
      toast.success(send ? t("report.ui.sent") : t("report.ui.draftSaved"));
      // Remplacé et non empilé : revenir en arrière depuis le ticket ne doit pas rouvrir l'assistant.
      if (send) cinemaNavigate({ report: String(id) }, "replace");
      else toList();
    } catch (error) {
      toast.error(reportErrorText(error, t));
    } finally {
      setBusy(false);
    }
  };

  /** Vers « Mes signalements » : en revenant si l'on en vient, en y allant sinon. */
  const toList = () => {
    if (fromList) cinemaClose({ report: "liste" });
    else cinemaNavigate({ report: "liste" }, "replace");
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteDraft = async () => {
    if (!existing) return;
    setBusy(true);
    try {
      await apiAction(`/api/reports/${existing.id}`, { method: "DELETE" });
      await refresh();
      toast.success(t("report.ui.draftDeleted"));
      toList();
    } catch (error) {
      toast.error(reportErrorText(error, t));
    } finally {
      setBusy(false);
    }
  };

  const removeKept = async (imageId: number) => {
    if (!existing) return;
    try {
      await apiAction(`/api/reports/${existing.id}/images/${imageId}`, { method: "DELETE" });
      setKept((list) => list.filter((i) => i.id !== imageId));
    } catch (error) {
      toast.error(reportErrorText(error, t));
    }
  };

  // Les mêmes règles que la reprise d'un brouillon, et que la route à l'envoi.
  const canSend = firstMissing(draft) === "describe" && draft.description.trim() !== "";

  const question: Record<Step, string> = {
    zone: t("report.ui.qZone"),
    element: suggestion ? t("report.ui.qSuggestion") : t("report.ui.qElement"),
    title: t("report.ui.qTitle"),
    issue: t("report.ui.qIssue"),
    describe: suggestion ? t("report.ui.qDescribeSuggestion") : t("report.ui.qDescribe"),
  };

  return (
    <div className="mx-auto w-full max-w-xl space-y-5 pt-2">
      {/* Où l'on en est : une barre, et le chemin déjà choisi, que l'on peut toucher pour y revenir. */}
      <div className="space-y-3">
        <div className="flex gap-1.5" aria-hidden>
          {steps.map((s, i) => (
            <span key={s} className={`h-1 flex-1 rounded-full ${i <= index ? "bg-accent-500" : "bg-white/10"}`} />
          ))}
        </div>
        {draft.zone && (
          <div className="flex flex-wrap gap-1.5">
            {reportPathParts(
              { zone: draft.zone, element: draft.element, elementOther: draft.elementOther, issue: draft.issue, issueOther: draft.issueOther },
              tr
            ).map((part, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setStep(i === 0 ? "zone" : i === 1 && zone?.children?.length ? "element" : "issue")}
                className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-muted hover:text-white"
              >
                {part}
              </button>
            ))}
            {draft.item && (
              <button type="button" onClick={() => setStep("title")} className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-muted hover:text-white">
                {draft.item.title}
              </button>
            )}
          </div>
        )}
        <h2 className="text-lg font-semibold text-white">{question[step]}</h2>
      </div>

      {step === "zone" && (
        <div className="space-y-2">
          {REPORT_ZONES.map((z: ReportNode) => (
            <Choice
              key={z.id}
              label={t(`report.zones.${z.id}`)}
              icon={z.suggestion ? Lightbulb : z.id === OTHER ? Pencil : MessageSquareWarning}
              selected={draft.zone === z.id}
              onClick={() =>
                advance({ ...draft, zone: z.id, element: null, elementOther: "", issue: null, issueOther: "", item: needsTitle(z) ? draft.item : null })
              }
            />
          ))}
        </div>
      )}

      {step === "element" && zone && (
        <div className="space-y-2">
          {zone.children?.map((c) => (
            <Choice
              key={c.id}
              label={t(`report.nodes.${c.id}`)}
              selected={draft.element === c.id}
              onClick={() => advance({ ...draft, element: c.id, issue: null, issueOther: "" })}
            />
          ))}
          <OtherChoice
            selected={draft.element === OTHER}
            value={draft.elementOther}
            onSelect={() => setDraft({ ...draft, element: OTHER, issue: null, issueOther: "" })}
            onChange={(v) => setDraft({ ...draft, elementOther: v })}
            onDone={() => advance(draft)}
          />
        </div>
      )}

      {step === "title" && <TitleStep value={draft.item} onPick={(item) => advance({ ...draft, item })} />}

      {step === "issue" && set && (
        <div className="space-y-2">
          {ISSUE_SETS[set].map((id) => (
            <Choice key={id} label={t(`report.issues.${set}.${id}`)} selected={draft.issue === id} onClick={() => advance({ ...draft, issue: id })} />
          ))}
          <OtherChoice
            selected={draft.issue === OTHER}
            value={draft.issueOther}
            onSelect={() => setDraft({ ...draft, issue: OTHER })}
            onChange={(v) => setDraft({ ...draft, issueOther: v })}
            onDone={() => advance(draft)}
          />
        </div>
      )}

      {step === "describe" && (
        <div className="space-y-4">
          <textarea
            {...escapeBlurs}
            autoFocus
            value={draft.description}
            maxLength={5000}
            rows={6}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder={suggestion ? t("report.ui.describeSuggestionPlaceholder") : t("report.ui.describePlaceholder")}
            className="input min-h-36 w-full resize-y py-3 text-sm leading-relaxed"
          />
          {kept.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {kept.map((image) => (
                <div key={image.id} className="relative h-20 w-20 overflow-hidden rounded-lg border border-white/10 bg-white/5">
                  {image.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- une capture déjà envoyée, servie par notre route
                    <img src={image.url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full items-center justify-center p-1 text-center text-[10px] text-muted">{image.name}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeKept(image.id)}
                    aria-label={t("report.ui.removeImage")}
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <ImagePicker files={files} onChange={setFiles} max={Math.max(0, MAX_PICKED - kept.length)} />
          {!suggestion && <p className="text-xs text-subtle">{t("report.ui.logsHint")}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
        {index > 0 && (
          <button type="button" onClick={back} className="btn btn-ghost px-3 py-2 text-sm">
            <ArrowLeft size={15} />
            {t("report.ui.back")}
          </button>
        )}
        <span className="flex-1" />
        {existing && (
          // En deux temps : un brouillon supprimé ne revient pas.
          <button
            type="button"
            disabled={busy}
            onClick={() => (confirmDelete ? void deleteDraft() : setConfirmDelete(true))}
            onBlur={() => setConfirmDelete(false)}
            className={`btn btn-ghost px-3 py-2 text-sm ${confirmDelete ? "text-danger" : ""}`}
          >
            <Trash2 size={15} />
            {confirmDelete ? t("report.ui.deleteDraftConfirm") : t("report.ui.deleteDraft")}
          </button>
        )}
        {draft.zone && (
          <button type="button" disabled={busy} onClick={() => submit(false)} className="btn btn-ghost px-3 py-2 text-sm">
            <Save size={15} />
            {t("report.ui.saveDraft")}
          </button>
        )}
        {step === "describe" && (
          <button type="button" disabled={busy || !canSend} onClick={() => submit(true)} className="btn btn-primary px-4 py-2 text-sm">
            {/* Les captures d'un téléphone pèsent plusieurs mégaoctets, et c'est leur envoi qui prend le
                temps (mesuré le 24/09/2026 : 6,7 Mo pour une capture d'écran d'iPhone) : le bouton dit
                que ça part, au lieu de sembler ne rien faire. */}
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            {busy ? t("report.ui.sending") : t("report.ui.send")}
          </button>
        )}
      </div>
    </div>
  );
}
