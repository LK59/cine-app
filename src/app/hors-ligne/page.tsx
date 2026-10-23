import type { Metadata } from "next";
import { OfflineEntryScreen } from "@/components/offline/OfflineEntryScreen";
import { APP_NAME } from "@/lib/appBuild";

/**
 * L'entrée hors ligne des téléchargements (bêta, DECISIONS.md §109).
 *
 * Publique (`PUBLIC_PATHS`) : le service worker la demande **sans cookie** pour la garder avec le
 * code de son build, et la sert quand le serveur ne répond pas — la page « Pas de connexion » et
 * l'écran de chargement y mènent. Rendue sans session, elle ne porte rien d'un compte : le compte
 * dont elle montre le dossier est celui retenu sur l'appareil (`offlineEntry.ts`). Avec du réseau
 * et une session, le serveur la rend comme n'importe quelle page, et elle marche de la même façon.
 *
 * Hors du groupe `(player)`, dont la coquille exige une session et lance le catalogue avec le HTML :
 * ici il n'y a que la racine — les traductions, `PlaybackProvider` et le lecteur, ce qu'il faut pour
 * lire un fichier de l'appareil, et rien qui attende le serveur.
 */
export const metadata: Metadata = { title: APP_NAME };

export default function OfflineEntryPage() {
  return <OfflineEntryScreen />;
}
