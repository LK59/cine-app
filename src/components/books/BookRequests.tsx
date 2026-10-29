"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { Check, Loader2, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { fetcher } from "@/lib/swr";
import { displayTitle } from "@/lib/books/displayTitle";
import type { BookSummary } from "@/lib/books/types";

/**
 * « Demander un livre » (option, DECISIONS.md §127) : un formulaire court — titre, auteur, une note —
 * et « Mes demandes » avec leur état. L'administrateur y voit en plus toutes les demandes, pour les
 * marquer « ajouté » ou « refusé » avec un mot ; qui a demandé en est prévenu. Aucune base de livres
 * n'est interrogée : l'administrateur ajoute le livre lui-même.
 */

export interface BookRequestView {
  id: number;
  account: string;
  title: string;
  author: string;
  note: string;
  status: "pending" | "added" | "refused";
  reply: string;
  createdAt: number;
}

export const REQUESTS_KEY = "/api/books/requests";

/** Les demandes sont-elles ouvertes sur cette installation, pour ce compte ? Non tant qu'on ne sait pas. */
export function useBookRequestsEnabled(): boolean {
  const { data } = useSWR<{ bookRequests?: boolean }>("/api/config/public", fetcher);
  return data?.bookRequests === true;
}

const STATUS_STYLE: Record<BookRequestView["status"], string> = {
  pending: "bg-white/10 text-muted",
  added: "bg-success/15 text-success",
  refused: "bg-danger/15 text-danger",
};

/**
 * Un livre de la bibliothèque dont le titre ressemble à celui demandé : « peut-être déjà là » — demandé
 * à la recherche des livres (l'index du serveur), pas à une liste gardée sur l'appareil.
 */
function useLikelyMatch(request: BookRequestView): BookSummary | null {
  const wanted = request.title.replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  const { data } = useSWR<{ books: BookSummary[] }>(request.status === "pending" && wanted.length >= 3 ? `/api/books/search?q=${encodeURIComponent(wanted)}` : null, fetcher);
  return data?.books[0] ?? null;
}

export function BookRequestsPanel({ initialTitle = "", onClose }: { initialTitle?: string; onClose: () => void }) {
  const t = useT();
  const { data, mutate } = useSWR<{ mine: BookRequestView[]; all?: BookRequestView[] }>(REQUESTS_KEY, fetcher);
  const [tab, setTab] = useState<"ask" | "mine" | "all">("ask");
  const [title, setTitle] = useState(initialTitle);
  const [author, setAuthor] = useState("");
  const [note, setNote] = useState("");
  // Échap referme la fenêtre, et elle seule : l'écran dessous se tait devant `aria-modal`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error" | "limit">("idle");
  const admin = data?.all !== undefined;
  const pendingAll = data?.all?.filter((r) => r.status === "pending").length ?? 0;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || state === "sending") return;
    setState("sending");
    try {
      const res = await fetch(REQUESTS_KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, author, note }) });
      if (res.status === 429) {
        setState("limit");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setState("sent");
      setTitle("");
      setAuthor("");
      setNote("");
      await mutate();
      setTab("mine");
    } catch {
      setState("error");
    }
  }

  const tabs: { id: "ask" | "mine" | "all"; label: string }[] = [
    { id: "ask", label: t("books.requests.ask") },
    { id: "mine", label: t("books.requests.mine") },
    ...(admin ? [{ id: "all" as const, label: pendingAll > 0 ? `${t("books.requests.all")} · ${pendingAll}` : t("books.requests.all") }] : []),
  ];

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-end justify-center sm:items-center sm:p-8" role="dialog" aria-modal="true" aria-label={t("books.requests.title")}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative flex max-h-[calc(100%-env(safe-area-inset-top)-2.5rem)] w-full flex-col overflow-hidden rounded-t-2xl bg-ink text-white shadow-2xl shadow-black/60 animate-fade-in-up sm:max-h-[86vh] sm:max-w-xl sm:rounded-2xl">
        <div className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-5">
          <h2 className="font-display text-xl font-semibold">{t("books.requests.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("books.close")} className="nav-glass ml-auto flex h-9 w-9 items-center justify-center rounded-full">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="flex shrink-0 gap-2 px-5 pb-3" role="tablist">
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => setTab(x.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${tab === x.id ? "bg-white text-ink" : "bg-white/10 text-muted hover:text-white"}`}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          {tab === "ask" && (
            <form onSubmit={send} className="flex flex-col gap-3 pt-1">
              <p className="text-sm text-muted">{t("books.requests.intro")}</p>
              <Field label={t("books.requests.fieldTitle")} required value={title} onChange={setTitle} max={200} autoFocus />
              <Field label={t("books.requests.fieldAuthor")} value={author} onChange={setAuthor} max={200} />
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-muted">{t("books.requests.fieldNote")}</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder={t("books.requests.notePlaceholder")}
                  className="rounded-xl bg-white/10 px-4 py-3 text-white placeholder:text-subtle focus:bg-white/15 focus:outline-none"
                />
              </label>
              {state === "error" && <p className="text-sm text-danger">{t("books.requests.error")}</p>}
              {state === "limit" && <p className="text-sm text-warning">{t("books.requests.limit")}</p>}
              <button
                type="submit"
                disabled={!title.trim() || state === "sending"}
                className="mt-1 flex h-11 items-center justify-center gap-2 rounded-full bg-white font-semibold text-ink transition-transform active:scale-95 disabled:opacity-50"
              >
                {state === "sending" && <Loader2 size={16} className="animate-spin" aria-hidden />}
                {t("books.requests.send")}
              </button>
            </form>
          )}

          {tab === "mine" && (
            <div className="flex flex-col gap-2 pt-1">
              {state === "sent" && (
                <p className="flex items-center gap-2 rounded-xl bg-success/15 px-4 py-3 text-sm text-success">
                  <Check size={16} aria-hidden /> {t("books.requests.sent")}
                </p>
              )}
              {data && data.mine.length === 0 && <p className="py-8 text-center text-sm text-subtle">{t("books.requests.none")}</p>}
              {data?.mine.map((r) => <RequestRow key={r.id} request={r} />)}
            </div>
          )}

          {tab === "all" && data?.all && <AdminList requests={data.all} onChanged={() => void mutate()} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

function Field({ label, value, onChange, max, required, autoFocus }: { label: string; value: string; onChange: (v: string) => void; max: number; required?: boolean; autoFocus?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted">
        {label}
        {required && " *"}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={max}
        required={required}
        autoFocus={autoFocus}
        className="h-11 rounded-xl bg-white/10 px-4 text-white placeholder:text-subtle focus:bg-white/15 focus:outline-none"
      />
    </label>
  );
}

function RequestRow({ request, children }: { request: BookRequestView; children?: React.ReactNode }) {
  const t = useT();
  return (
    <div className="rounded-xl bg-white/5 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{request.title}</p>
          <p className="mt-0.5 text-sm text-subtle">
            {[request.author, new Date(request.createdAt).toLocaleDateString()].filter(Boolean).join(" · ")}
          </p>
          {request.note && <p className="mt-1.5 whitespace-pre-line text-sm text-muted">{request.note}</p>}
          {request.reply && <p className="mt-1.5 text-sm text-white">« {request.reply} »</p>}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[request.status]}`}>{t(`books.requests.status.${request.status}`)}</span>
      </div>
      {children}
    </div>
  );
}

function AdminList({ requests, onChanged }: { requests: BookRequestView[]; onChanged: () => void }) {
  const t = useT();
  if (requests.length === 0) return <p className="py-8 text-center text-sm text-subtle">{t("books.requests.noneAll")}</p>;
  return (
    <div className="flex flex-col gap-2 pt-1">
      {requests.map((r) => (
        <RequestRow key={r.id} request={r}>
          <p className="mt-1 text-xs text-subtle">{t("books.requests.by", { user: r.account })}</p>
          <AdminActions request={r} onChanged={onChanged} />
        </RequestRow>
      ))}
    </div>
  );
}

function AdminActions({ request, onChanged }: { request: BookRequestView; onChanged: () => void }) {
  const t = useT();
  const [reply, setReply] = useState(request.reply);
  const [busy, setBusy] = useState(false);
  const match = useLikelyMatch(request);

  async function answer(status: "added" | "refused" | "pending") {
    setBusy(true);
    try {
      const res = await fetch(`${REQUESTS_KEY}/${request.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, reply }) });
      if (res.ok) onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {match && (
        <p className="rounded-lg bg-white/5 px-3 py-2 text-xs text-muted">{t("books.requests.maybeHere", { title: displayTitle(match) })}</p>
      )}
      <input
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        maxLength={500}
        placeholder={t("books.requests.replyPlaceholder")}
        className="h-10 rounded-lg bg-white/10 px-3 text-sm text-white placeholder:text-subtle focus:bg-white/15 focus:outline-none"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void answer("added")} className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-ink disabled:opacity-50">
          {t("books.requests.markAdded")}
        </button>
        <button type="button" disabled={busy} onClick={() => void answer("refused")} className="rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {t("books.requests.markRefused")}
        </button>
        {request.status !== "pending" && (
          <button type="button" disabled={busy} onClick={() => void answer("pending")} className="rounded-full px-3 py-1.5 text-sm text-subtle hover:text-white disabled:opacity-50">
            {t("books.requests.reopen")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Le bouton « Demander un livre », rendu seulement quand les demandes sont ouvertes. */
export function BookRequestButton({ label, initialTitle, className }: { label?: string; initialTitle?: string; className?: string }) {
  const t = useT();
  const enabled = useBookRequestsEnabled();
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? "inline-flex h-10 items-center rounded-full bg-white/10 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/15"}>
        {label ?? t("books.requests.button")}
      </button>
      {open && <BookRequestsPanel initialTitle={initialTitle} onClose={() => setOpen(false)} />}
    </>
  );
}
