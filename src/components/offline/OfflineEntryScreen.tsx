"use client";

import { PlayerEmptyState } from "@/components/player/PlayerEmptyState";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowRight, HardDrive } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { adoptSignedOutAccount } from "@/lib/persistentCache";
import { deviceStoreSupported } from "@/lib/offline/deviceStore";
import { initOfflineDownloads, offlineAccount } from "@/lib/offline/downloads";
import { rememberedOfflineAccount } from "@/lib/offline/offlineEntry";
import { BetaBadge } from "./OfflineDownloadControl";
import { OfflineDownloadsView } from "./OfflineDownloadsView";

/**
 * `/hors-ligne` — les téléchargements de l'appareil sans le cinéma (bêta, DECISIONS.md §109).
 *
 * Le même contenu que le panneau du cinéma (`OfflineDownloadsView`), dans un cadre à lui : ni
 * barre, ni rail, ni fiche — rien ici ne peut attendre le serveur. Le compte est celui de la
 * session quand le serveur a rendu la page, sinon celui retenu sur l'appareil ; « Ouvrir Cine App »
 * repart vers l'accueil, qui revient dès que le réseau répond.
 */

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const noSubscribe = () => () => {};

export function OfflineEntryScreen() {
  const t = useT();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine !== false, () => true);
  const supported = useSyncExternalStore(noSubscribe, deviceStoreSupported, () => true);
  // `null` tant que la liste n'est pas lue ; ensuite, le compte dont elle vient (ou aucun).
  const [account, setAccount] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Sans session, la racine n'a nommé aucun compte : celui retenu par le cinéma. Avec une
      // session, `adoptSignedOutAccount` ne fait rien — celui du serveur l'emporte.
      const remembered = rememberedOfflineAccount();
      if (remembered) adoptSignedOutAccount(remembered.account);
      await initOfflineDownloads().catch(() => {});
      if (!cancelled) setAccount(offlineAccount());
    })();
    // Au retour au premier plan, comme le rond du cinéma : la boucle a pu être suspendue.
    const onVisible = () => {
      if (document.visibilityState === "visible") void initOfflineDownloads().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    // La coquille du cinéma (`(player)/layout.tsx`), à l'identique : un cadre à la hauteur de l'écran
    // (`app-viewport`) qui ne défile pas, le défilement à l'intérieur. En `fixed inset-0`, l'iPhone
    // laissait une bande sombre en bas, sous la page comme sous le lecteur (Louis, 19/10/2026).
    <div className="app-viewport overflow-hidden bg-ink">
    <main className="h-full overflow-y-auto overscroll-contain">
      <div
        className="mx-auto w-full max-w-3xl px-5 sm:px-10"
        style={{
          paddingTop: "calc(1.5rem + env(safe-area-inset-top, 0px))",
          paddingBottom: "calc(2.5rem + env(safe-area-inset-bottom, 0px))",
          paddingLeft: "max(1.25rem, env(safe-area-inset-left, 0px))",
          paddingRight: "max(1.25rem, env(safe-area-inset-right, 0px))",
        }}
      >
        <header className="mb-6 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-2xl font-semibold text-white sm:text-3xl">{t("player.downloads.manager")}</h1>
            <p className="mt-1 flex items-center gap-2 text-sm text-muted">
              <BetaBadge />
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${online ? "bg-success" : "bg-warning"}`} aria-hidden />
              <span className="truncate">{online ? t("player.downloads.entryOnline") : t("player.downloads.entryOffline")}</span>
            </p>
          </div>
          {/* Une vraie navigation, pas le routeur : l'accueil est une autre coquille (`(player)`), et
              sans réseau le service worker répond par la page « Pas de connexion ». */}
          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination -- un chargement complet voulu : voir au-dessus. */}
          <button type="button" onClick={() => window.location.assign("/")} className="btn btn-ghost mt-0.5 shrink-0 rounded-full px-3 py-2">
            {t("player.downloads.openApp")}
            <ArrowRight size={15} aria-hidden />
          </button>
        </header>
        {!supported ? (
          <Notice text={t("player.downloads.unsupported")} />
        ) : account === undefined ? (
          <div className="flex justify-center py-16" aria-busy="true">
            <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" aria-hidden />
          </div>
        ) : account === null ? (
          <Notice text={t("player.downloads.entryNoAccount")} />
        ) : (
          <OfflineDownloadsView />
        )}
      </div>
    </main>
    </div>
  );
}

/** L'écran vide de l'app (`PlayerEmptyState`) : un signe, et la phrase qui dit pourquoi. */
function Notice({ text }: { text: string }) {
  return <PlayerEmptyState icon={HardDrive} message={text} />;
}
