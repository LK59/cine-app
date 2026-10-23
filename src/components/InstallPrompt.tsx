"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Share, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { ABOVE_BOTTOM_BAR, PROMPT_CLOSE_CLASS } from "@/lib/floatingPrompt";
import { isInstalledApp, isIosSafariBrowserTab } from "@/lib/iosInstall";
import { passageFlags } from "@/lib/passage/client";
import { installPlatform, PassageInstallSteps } from "@/components/passage/PassageInstallHelp";
import { useOldAddress } from "@/lib/passage/useOldAddress";
import { PROMPT_RANK, useFloatingPromptTurn } from "@/lib/floatingPromptTurn";

const DISMISS_KEY = "cine-install-prompt-dismissed-until";
const SNOOZE_DAYS = 21;
const SHOW_DELAY_MS = 4000;

// Discreet nudge for iOS: Safari has no beforeinstallprompt event, so the only
// way to "install" is Share -> Add to Home Screen, which we can't trigger
// programmatically — we just have to explain it once in a dismissible way.
// This matters because iOS only allows Web Push for home-screen-installed PWAs.
//
// Juste après un passage d'adresse (DECISIONS.md §119, `cine:passage-install-help` dans l'onglet) :
// montrée **aussitôt** et en grand, même mise de côté plus tôt, sur iPhone/iPad comme sur Android — la
// nouvelle adresse est une application à installer de nouveau — avec les trois gestes numérotés
// (`PassageInstallSteps`). Elle passait après 0,8 s, en petit ; sur l'iPhone du propriétaire (10.0.0)
// elle n'est jamais venue, et l'invitation aux notifications a pris sa place (voir `isInstalledApp`).
export function InstallPrompt() {
  const t = useT();
  const [show, setShow] = useState<"ios" | "passage" | null>(null);
  const pathname = usePathname();
  // Sur l'ancienne adresse d'une installation qui en annonce une nouvelle (§119), jamais : elle
  // pousserait à installer l'adresse qu'on quitte. Tant qu'on ne sait pas, on attend.
  const { old } = useOldAddress();

  useEffect(() => {
    if (passageFlags.installHelpWanted() && !isInstalledApp() && installPlatform() !== "other") {
      // Le premier tour après le montage (l'hydratation passée), pas plus tard.
      const timer = setTimeout(() => setShow("passage"), 0);
      return () => clearTimeout(timer);
    }
    if (!isIosSafariBrowserTab()) return;
    try {
      const dismissedUntil = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      if (Date.now() < dismissedUntil) return;
    } catch {}

    const timer = setTimeout(() => setShow("ios"), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  function dismiss() {
    if (show === "passage") passageFlags.installHelpShown();
    setShow(null);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + SNOOZE_DAYS * 86400000));
    } catch {}
  }

  // Pas pendant l'assistant de premier lancement (05/10/2026) : sur un iPhone, la bannière couvrait
  // ses boutons, et l'installation n'a de sens qu'une fois l'application prête.
  const shown = !!show && old === false && !pathname?.startsWith("/setup");
  // Une invitation à la fois (`floatingPromptTurn`) : l'aide d'installation est une étape, elle
  // s'annonce et les invitations (notifications, retélécharger après un passage) l'attendent.
  useFloatingPromptTurn("install", PROMPT_RANK.step, shown);
  if (!show || !shown) return null;

  // Une cible de 44 px (la croix en faisait 13) et un nom : c'était la seule sortie de la bannière.
  const close = (
    <button type="button" onClick={dismiss} aria-label={t("common.close")} className={`${PROMPT_CLOSE_CLASS} text-slate-500 hover:text-slate-200`}>
      <X size={13} />
    </button>
  );

  if (show === "passage") {
    return (
      <div
        className="fixed inset-x-0 bottom-0 z-60 flex justify-center px-3 pb-3 pointer-events-none"
        // Au-dessus de la barre du bas du cinéma, pas dessus — voir `ABOVE_BOTTOM_BAR`.
        style={{ paddingBottom: ABOVE_BOTTOM_BAR }}
      >
        <div
          role="dialog"
          aria-label={t("passage.install.title")}
          data-install-prompt="passage"
          className="glass-panel pointer-events-auto relative w-full max-w-md rounded-2xl border border-accent-400/30 px-4 py-4 pr-12 shadow-glow"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-white">
            <Share size={16} className="shrink-0 text-accent-400" />
            {t("passage.install.title")}
          </p>
          <PassageInstallSteps platform={installPlatform()} size="banner" downloads={passageFlags.carriedDownloads()} />
          <div className="absolute right-1 top-1">{close}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-60 flex justify-center px-3 pb-3 pointer-events-none"
      // Au-dessus de la barre du bas du cinéma, pas dessus — voir `ABOVE_BOTTOM_BAR`.
      style={{ paddingBottom: ABOVE_BOTTOM_BAR }}
    >
      <div data-install-prompt={show} className="glass-panel pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl px-4 py-3 shadow-glow">
        <Share size={16} className="mt-0.5 shrink-0 text-accent-400" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">{t("common.installPrompt.title")}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{t("common.installPrompt.body")}</p>
          <p className="mt-1 text-[11px] leading-snug text-slate-500">{t("common.installPrompt.steps")}</p>
        </div>
        {close}
      </div>
    </div>
  );
}
