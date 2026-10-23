"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Bell, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { PushToggle } from "@/components/PushToggle";
import { fetcher } from "@/lib/swr";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { forgetPushWasOn, pushWasOn } from "@/lib/pushOnSignOut";
import { ABOVE_BOTTOM_BAR, PROMPT_CLOSE_CLASS } from "@/lib/floatingPrompt";
import { canOfferPush, isInstalledApp } from "@/lib/iosInstall";
import { PROMPT_RANK, useFloatingPromptTurn } from "@/lib/floatingPromptTurn";

/** Laissé au lancement le temps de s'installer, comme l'invitation à installer l'application. */
const SHOW_DELAY_MS = 3000;

/**
 * Sur cet appareil, l'invitation de l'application installée a déjà été faite — montrée une fois,
 * quelle que soit la réponse. Par appareil (et par adresse : le navigateur range `localStorage` par
 * adresse, comme les abonnements), pas par compte.
 */
export const INSTALLED_PUSH_OFFERED_KEY = "cine:push-installed-offered";

function installedOfferMade(): boolean {
  try {
    return localStorage.getItem(INSTALLED_PUSH_OFFERED_KEY) !== null;
  } catch {
    // Stockage illisible (navigation privée, données bloquées) : ne rien proposer plutôt que de
    // reposer la question à chaque lancement.
    return true;
  }
}

function noteInstalledOfferMade(): void {
  try {
    localStorage.setItem(INSTALLED_PUSH_OFFERED_KEY, String(Date.now()));
  } catch {
    /* rien à garder : au pire, la question reviendra une fois */
  }
}

/**
 * Pourquoi l'invitation se montre — une seule à la fois, la reprise d'abord :
 *  - `resume` : « Vous les aviez activées sur cet appareil avant de vous déconnecter » ;
 *  - `installed` : l'application tourne installée et cet appareil n'a aucun abonnement.
 */
type PushPromptReason = "resume" | "installed";

/**
 * Les notifications proposées dans une bannière flottante du bas, pour l'une de deux raisons.
 *
 * **Reprise.** La déconnexion coupe les notifications de l'appareil (`pushOnSignOut`) ; sans cette
 * question, la personne revenue ne recevait plus rien sans le savoir.
 *
 * **Application installée** (23/10/2026). Beaucoup de comptes ont réglé leurs notifications depuis un
 * onglet de Safari, puis installé l'application : l'abonnement appartient à l'onglet, l'application
 * installée n'en a aucun — et une nouvelle adresse non plus. Proposée une seule fois par appareil
 * (`INSTALLED_PUSH_OFFERED_KEY`, posée à l'affichage : une fermeture ou un refus ne la reposent pas).
 *
 * Communes aux deux : jamais pendant l'écran d'accueil — qui a sa propre étape de notifications —,
 * seulement là où l'on peut les proposer (`canOfferPush` : le navigateur sait s'abonner, et sur
 * iPhone/iPad c'est l'application installée), jamais quand la permission
 * est refusée (elle ne se redemande pas d'ici), jamais quand un abonnement existe déjà. Une seule
 * bannière, donc jamais les deux questions ensemble.
 */
export function PushResumePrompt() {
  const t = useT();
  const { data: onboarding } = useSWR<{ pending: boolean }>("/api/onboarding", fetcher, { revalidateOnFocus: false });
  const [prompt, setPrompt] = useState<{ reason: PushPromptReason; account: string | null } | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const who = persistedCacheAccount();
      const resume = pushWasOn(who);
      const installed = !resume && isInstalledApp() && !installedOfferMade();
      if (!resume && !installed) return;
      // `canOfferPush` (DECISIONS.md §17) : sur iPhone/iPad hors de l'application installée, jamais —
      // la vue intégrée où « Passer » ouvre la nouvelle adresse expose pourtant `PushManager`.
      if (!canOfferPush() || Notification.permission === "denied") {
        if (resume) forgetPushWasOn(who);
        return;
      }
      // Déjà abonné par un autre chemin (le panneau Compte) : rien à demander.
      const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
      if (await reg?.pushManager?.getSubscription().catch(() => null)) {
        if (resume) forgetPushWasOn(who);
        return;
      }
      setPrompt({ reason: resume ? "resume" : "installed", account: who });
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Une invitation à la fois (`floatingPromptTurn`) : pas par-dessus l'aide d'installation ni les
  // Nouveautés ; l'invitation de retélécharger après un passage attend la sienne.
  const turn = useFloatingPromptTurn("push", PROMPT_RANK.push, prompt !== null && !closed && onboarding?.pending === false);
  const visible = prompt !== null && !closed && onboarding?.pending === false && turn;
  const reason = prompt?.reason ?? null;

  // L'invitation de l'application installée compte comme faite dès qu'elle s'affiche — pas quand elle
  // est seulement décidée : l'écran d'accueil peut encore la retenir.
  useEffect(() => {
    if (visible && reason === "installed") noteInstalledOfferMade();
  }, [visible, reason]);

  if (!visible || !prompt) return null;

  const done = () => {
    if (prompt.reason === "resume") forgetPushWasOn(prompt.account);
    setClosed(true);
  };
  const keys = prompt.reason === "resume" ? "player.pushResume" : "player.pushInstalled";

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-60 flex justify-center px-3 pb-3 pointer-events-none"
      // Au-dessus de la barre du bas, comme « Installer » — voir `ABOVE_BOTTOM_BAR`.
      style={{ paddingBottom: ABOVE_BOTTOM_BAR }}
    >
      <div
        role="dialog"
        aria-label={t(`${keys}.title`)}
        data-push-prompt={prompt.reason}
        className="glass-panel pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl px-4 py-3 shadow-glow"
      >
        <Bell size={16} className="mt-0.5 shrink-0 text-accent-400" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">{t(`${keys}.title`)}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">{t(`${keys}.body`)}</p>
          <div className="mt-2">
            <PushToggle onSubscribed={done} />
          </div>
        </div>
        <button type="button" onClick={done} aria-label={t(`${keys}.later`)} className={`${PROMPT_CLOSE_CLASS} text-subtle hover:text-white`}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
