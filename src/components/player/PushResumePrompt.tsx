"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Bell, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { PushToggle } from "@/components/PushToggle";
import { fetcher } from "@/lib/swr";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { forgetPushWasOn, pushWasOn } from "@/lib/pushOnSignOut";

/** Laissé au lancement le temps de s'installer, comme l'invitation à installer l'application. */
const SHOW_DELAY_MS = 3000;

/**
 * « Vous aviez activé les notifications sur cet appareil » — la question reposée après une
 * reconnexion.
 *
 * La déconnexion coupe les notifications de l'appareil (`pushOnSignOut`) ; sans cette question,
 * la personne revenue ne recevait plus rien sans le savoir. Posée une seule fois, jamais pendant
 * l'écran d'accueil — qui a sa propre étape de notifications — et seulement si l'appareil peut
 * encore s'abonner : une permission refusée entre-temps ne se redemande pas d'ici.
 */
export function PushResumePrompt() {
  const t = useT();
  const { data: onboarding } = useSWR<{ pending: boolean }>("/api/onboarding", fetcher, { revalidateOnFocus: false });
  const [account, setAccount] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const who = persistedCacheAccount();
      if (!pushWasOn(who)) return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission === "denied") {
        forgetPushWasOn(who);
        return;
      }
      // Déjà réabonné par un autre chemin (le panneau Compte) : rien à demander.
      const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
      if (await reg?.pushManager?.getSubscription().catch(() => null)) {
        forgetPushWasOn(who);
        return;
      }
      setAccount(who);
    }, SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!account || closed || onboarding?.pending !== false) return null;

  const done = () => {
    forgetPushWasOn(account);
    setClosed(true);
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-60 flex justify-center px-3 pb-3 pointer-events-none"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
    >
      <div
        role="dialog"
        aria-label={t("player.pushResume.title")}
        className="glass-panel pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl px-4 py-3 shadow-glow"
      >
        <Bell size={16} className="mt-0.5 shrink-0 text-accent-400" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">{t("player.pushResume.title")}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">{t("player.pushResume.body")}</p>
          <div className="mt-2">
            <PushToggle onSubscribed={done} />
          </div>
        </div>
        <button onClick={done} aria-label={t("player.pushResume.later")} className="shrink-0 text-subtle hover:text-white">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
