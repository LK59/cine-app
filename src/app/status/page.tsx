"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Clapperboard } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { CapabilitySection } from "@/components/CapabilityStatus";

// Standalone — deliberately outside the (dashboard) route group, so it renders with none of
// the Sidebar/MobileNav chrome that assumes a logged-in session. Reachable without logging in
// (see PUBLIC_PATHS in proxy.ts) so it still works when the rest of the app — or the login flow
// itself — is what's broken.
export default function PublicStatusPage() {
  // `useSearchParams` impose une frontière de suspense en App Router — la même raison, et la même
  // forme, que sur l'écran de connexion.
  return (
    <Suspense fallback={<StatusScreen back="/login" />}>
      <StatusScreenFromRoute />
    </Suspense>
  );
}

function StatusScreenFromRoute() {
  // D'où l'on vient, dit par celui qui nous envoie plutôt que deviné ici.
  //
  // Cette page a deux entrées — l'écran de connexion et le panneau « Compte » — et son bouton
  // « Retour » pointait vers la première dans les deux cas. Quelqu'un de déjà connecté qui venait
  // consulter l'état des services se retrouvait donc devant un écran de connexion, ce qui ressemble
  // à s'être fait déconnecter en regardant si le serveur allait bien.
  //
  // Le paramètre plutôt qu'une vérification de session : la page doit répondre le jour où plus rien
  // ne répond, et une garde qui interroge le serveur pour savoir quoi écrire dans un lien devient
  // une panne de plus sur la page qui sert à diagnoser les pannes.
  const from = useSearchParams().get("from");
  return <StatusScreen back={from === "compte" ? "/#compte=1" : "/login"} />;
}

function StatusScreen({ back }: { back: string }) {
  const t = useT();

  return (
    <main
      className="min-h-screen bg-ink px-4 sm:px-6"
      /* Sous l'encoche, pas dedans.
         
         `py-8` seul plaçait l'en-tête sous l'îlot dynamique et sous le bandeau flouté de l'app
         installée : le titre était là, illisible. Les marges sûres sont ajoutées aux 2rem d'origine
         plutôt que substituées, pour que l'écart au bord reste le même partout. En bas pour la même
         raison, la barre d'accueil recouvrant la fin de la liste des services. */
      style={{
        paddingTop: "calc(2rem + env(safe-area-inset-top, 0px))",
        paddingBottom: "calc(2rem + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-accent-600/20 p-2 text-accent-400">
              <Clapperboard size={22} />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">Cine App</h1>
              <p className="text-xs text-slate-400">{t('health.pageTitle')}</p>
            </div>
          </div>
          <Link href={back} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
            <ArrowLeft size={14} /> {t('common.back')}
          </Link>
        </div>

        <CapabilitySection />
      </div>
    </main>
  );
}
