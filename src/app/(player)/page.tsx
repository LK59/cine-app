"use client";

import dynamic from "next/dynamic";
import { useIsMobile } from "@/lib/useIsMobile";
import { catalogueCacheReady } from "@/lib/persistentCache";
import { useResumeCache } from "@/lib/resumeCache/useResumeCache";

// L'écran d'attente est un simple bloc `fixed`, et non plus un portage dans `document.body`.
//
// Le portage n'avait de raison d'être que sous l'ancienne coquille, où l'animation de
// PageTransition posait un `transform` permanent qui faisait d'elle le bloc conteneur de tout
// descendant `fixed`. Le lecteur n'a plus cette coquille — et surtout, ce composant de repli est
// rendu côté serveur (c'est ce que `ssr: false` fait du `loading`), où `document` n'existe pas :
// la page répondait 500 avant d'avoir affiché quoi que ce soit.
function LoadingScreen() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-ink" style={{ zIndex: 200 }}>
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  );
}

/**
 * Le morceau de l'écran et le catalogue gardé sur l'appareil, attendus ensemble.
 *
 * Le cinéma ne se monte qu'une fois le cache relu (`catalogueCacheReady`, 150 ms au plus, en
 * parallèle du téléchargement du morceau) : monté avant, il afficherait l'écran de chargement et
 * demanderait tout au réseau, exactement ce que le cache doit éviter — et une donnée posée ensuite
 * sous une requête en cours ferait jeter sa réponse à SWR. Un rendu purement client (`ssr: false`),
 * donc rien à accorder avec le serveur.
 */
function withCatalogueCache<T>(load: Promise<T>): Promise<T> {
  return Promise.all([load, catalogueCacheReady()]).then(([component]) => component);
}

// ssr:false — see CinemaClient's own doc comment for why (unrecoverable hydration mismatch on a
// page that's 100% client-fetched anyway, same pattern as PlayerHostLazy/GlobalSearchLazy).
const CinemaClient = dynamic(() => withCatalogueCache(import("@/components/cinema/CinemaClient").then((m) => m.CinemaClient)), {
  ssr: false,
  loading: LoadingScreen,
});

const CinemaMobileClient = dynamic(
  () => withCatalogueCache(import("@/components/cinema/mobile/CinemaMobileClient").then((m) => m.CinemaMobileClient)),
  { ssr: false, loading: LoadingScreen }
);

// Two genuinely different screens rather than one responsive layout — see CinemaMobileClient's
// own doc comment. Splitting at the route means a phone never downloads the desktop screen's
// bundle (YouTube IFrame API, TV grid navigation, the split-pane hero) or vice versa.
export default function PlayerPage() {
  const isMobile = useIsMobile();
  // « Reprendre » et « À suivre » qui démarrent instantanément : leurs octets d'ouverture gardés sur
  // l'appareil, en arrière-plan — une fois ici, pour les deux écrans. Voir `src/lib/resumeCache/`.
  useResumeCache();
  return isMobile ? <CinemaMobileClient /> : <CinemaClient />;
}
