import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { PlayerShell } from "@/components/player/PlayerShell";
import { earlyFetchScript } from "@/lib/earlyFetch";
import { ipadSimulatorScript } from "@/lib/ipadSimulator";
import { IpadSimulatorBadge } from "@/components/player/IpadSimulatorBadge";

/**
 * Le lecteur a sa propre coquille, et c'est tout l'intérêt du groupe de routes : pas de barre
 * latérale de gestion, pas de PageTransition (dont le `transform` permanent cassait le
 * `position: fixed` des écrans cinéma), pas de MainScroll. Une page noire, une navigation, et le
 * contenu.
 */
export default async function PlayerLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session) redirect("/login");

  return (
    <div className="app-viewport overflow-hidden bg-ink">
      {/*
        Le catalogue part avec le HTML, et non quand l'écran est prêt à le demander.

        L'accueil est en `ssr: false` : le document ne contient rien, et la chaîne est strictement
        en file — HTML, puis le JS de la coquille, puis le morceau de l'écran cinéma, puis
        seulement `/api/cinema/movies`. Le plus gros envoi du démarrage était donc le dernier à
        partir, alors que rien de ce qui le précède n'en dépend.

        Mesuré le 20/09/2026, paquet réel rejoué dans Chrome : entre le HTML reçu et le code de
        l'application évalué il s'écoule 84 ms sur un PC, 297 ms à quatre fois moins de processeur
        (une tablette), 470 ms à six. C'est la fenêtre que cette ligne recouvre, et le gain vaut
        `min(fenêtre, temps du catalogue)` — donc quelques dizaines de millisecondes sur le réseau
        local, et le temps complet de la requête en 4G ou au premier lancement après un
        déploiement, où le JS n'est plus en cache (les noms de fichiers sont hachés par contenu).

        **`crossOrigin="anonymous"` n'est pas décoratif.** Le navigateur ne réutilise une amorce
        que si le mode et le régime d'identification correspondent exactement à la requête qui
        suivra. `fetch(url)` nu, c'est mode `cors` et identifiants `same-origin` ; une amorce sans
        cet attribut est en `no-cors`, ne correspond à rien, et le catalogue partirait **deux
        fois**. Le cookie de session voyage bien — « same-origin » veut dire « joins-les pour ma
        propre origine ».

        Les films et pas les séries : l'onglet vit dans le fragment d'adresse, que le serveur ne
        reçoit jamais. Mais l'écran demande le catalogue des films quel que soit l'onglet (voir
        `CinemaClient`), donc cette amorce-là ne se trompe jamais de fichier.

        **Pas pour WebKit** (08/10/2026). Safari — et tout navigateur d'iPhone ou d'iPad — ne
        reprend pas toujours l'amorce : mesuré au journal du proxy, 64 lancements d'iPhone sur 135
        et 6 de Safari sur Mac sur 13 ont téléchargé le catalogue deux fois à deux secondes
        d'intervalle (Chrome : 2 sur 24), soit 300 Ko de plus par lancement. Le premier affichage y
        vient du catalogue gardé sur l'appareil (`persistentCache.ts`) : l'amorce n'y gagnait que
        quelques dizaines de millisecondes, et coûtait un second téléchargement une fois sur deux.

        **Remplacée le 15/10/2026 par un `fetch` lancé ici même** (`earlyFetch.ts`) : sans amorce,
        l'iPhone envoyait la requête une seconde après le démarrage du code (journal d'ouverture,
        `routes` : code prêt à 0,78 s, catalogue parti à 1,76 s, revenu en 0,28 s). C'est notre
        récupérateur qui reprend la réponse rangée, pas le navigateur qui l'apparie : une requête
        par adresse sur tous les moteurs, et « Reprendre » et « À suivre » partent avec le catalogue.
        La même raison qui faisait `crossOrigin="anonymous"` vaut ici : le `fetch` du script est
        identique à celui des récupérateurs — mêmes mode et identifiants, donc même réponse.
      */}
      <script dangerouslySetInnerHTML={{ __html: earlyFetchScript() }} />
      {/* Le simulateur d'iPad de l'administrateur, avant le premier dessin (`ipadSimulator.ts`). */}
      <script dangerouslySetInnerHTML={{ __html: ipadSimulatorScript() }} />
      {children}
      <PlayerShell />
      <IpadSimulatorBadge />
    </div>
  );
}
