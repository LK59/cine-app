"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { collectPassageInput, formatPassageCode } from "@/lib/passage/client";
import { isAppleTouchDevice, isInstalledApp } from "@/lib/iosInstall";
import { touchHintHeaders } from "@/lib/deviceLabel";

interface Prepared {
  url: string;
  code: string;
  codeExpiresAt: number;
}

type State = { kind: "loading" } | { kind: "ready"; passage: Prepared } | { kind: "error"; which: "relogin" | "rateLimited" | "error" };

/**
 * La fenêtre du passage, sur l'ancienne adresse (DECISIONS.md §119).
 *
 * Elle demande le passage dès qu'elle s'ouvre — un jeton et un code — puis montre le code et **un**
 * bouton : « Copier le code et ouvrir … ». Deux gestes en un, et dans le geste lui-même : le
 * presse-papiers et l'ouverture d'une autre adresse ne sont permis qu'à l'intérieur d'un appui, pas
 * après une attente réseau (un `window.open` différé est bloqué, une copie différée refusée par Safari).
 *
 * L'adresse ouverte vient du serveur, construite depuis le réglage du déploiement : jamais d'ici.
 *
 * Depuis l'application installée, l'autre adresse s'ouvre dans le navigateur. Sur iPhone et iPad, ce
 * navigateur intégré n'a ni le stockage ni les cookies de Safari, et l'application qu'on installera
 * ensuite non plus : le code est le chemin, et la fenêtre le dit.
 */
export function PassageDialog({ target, onClose }: { target: string; onClose: () => void }) {
  const t = useT();
  const host = new URL(target).host;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [installedIos] = useState(() => isInstalledApp() && isAppleTouchDevice());
  // Des téléchargements de ce compte sur l'appareil : une phrase dit qu'ils seront proposés de nouveau.
  const [carried, setCarried] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const input = await collectPassageInput();
        if (!cancelled) setCarried(input.downloads.length > 0);
        const res = await fetch("/api/passage", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...touchHintHeaders() },
          body: JSON.stringify(input),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<Prepared> & { code?: string; error?: string };
        if (cancelled) return;
        if (!res.ok || typeof data.url !== "string" || typeof data.code !== "string") {
          const which = data.code === "passage-relogin" ? "relogin" : res.status === 429 ? "rateLimited" : "error";
          setState({ kind: "error", which });
          return;
        }
        setState({ kind: "ready", passage: { url: data.url, code: data.code, codeExpiresAt: data.codeExpiresAt ?? 0 } });
      } catch {
        if (!cancelled) setState({ kind: "error", which: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function go(passage: Prepared) {
    const shown = formatPassageCode(passage.code);
    // Dans l'appui : la copie d'abord (sans l'attendre), l'ouverture ensuite.
    void navigator.clipboard?.writeText(shown).then(
      () => setCopied(true),
      () => setCopied(false)
    );
    if (isInstalledApp()) window.open(passage.url, "_blank", "noopener");
    else window.location.assign(passage.url);
  }

  // Au-dessus de la fenêtre des Nouveautés (70), d'où le lien l'ouvre.
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("passage.dialog.title", { host })}
        data-passage-dialog=""
        className="glass-panel relative w-full max-w-sm rounded-2xl p-5 shadow-glow"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} aria-label={t("passage.dialog.close")} className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center text-subtle hover:text-white">
          <X size={15} />
        </button>
        <h2 className="pr-8 text-base font-semibold text-white">{t("passage.dialog.title", { host })}</h2>
        <p className="mt-1.5 text-[13px] leading-snug text-muted">{t("passage.dialog.body")}</p>
        {carried && (
          <p data-passage-downloads-note="" className="mt-1.5 text-[13px] leading-snug text-muted">
            {t("passage.downloads.again")}
          </p>
        )}

        {state.kind === "loading" && <p className="mt-5 text-sm text-subtle">{t("passage.dialog.preparing")}</p>}
        {state.kind === "error" && (
          <p role="alert" className="mt-5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {t(`passage.dialog.${state.which}`)}
          </p>
        )}
        {state.kind === "ready" && (
          <>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle">{t("passage.dialog.codeLabel")}</p>
            <p data-passage-code="" className="mt-1 select-all font-mono text-2xl font-semibold tracking-[0.18em] text-white">
              {formatPassageCode(state.passage.code)}
            </p>
            <p className="mt-1 text-[12px] leading-snug text-subtle">{t("passage.dialog.codeHint", { host })}</p>
            {installedIos && <p className="mt-3 rounded-lg bg-white/[0.05] px-3 py-2 text-[12px] leading-snug text-white/80">{t("passage.dialog.installedIos", { host })}</p>}
            <button
              type="button"
              onClick={() => go(state.passage)}
              data-passage-go=""
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-white py-3 text-sm font-semibold text-black transition-opacity hover:bg-white/90"
            >
              {t("passage.dialog.open", { host })}
              <ArrowRight size={15} />
            </button>
            {copied && (
              <p role="status" className="mt-2 text-center text-[12px] text-subtle">
                {t("passage.dialog.copied")}
              </p>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
