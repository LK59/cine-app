"use client";

import { APP_AUTHOR, APP_NAME, APP_REPOSITORY_URL, APP_VERSION, displayVersion } from "@/lib/appBuild";
import { useT } from "@/components/TranslationProvider";

/**
 * « CineApp 8.1 by LK59 · GitHub » — la signature, en une ligne discrète.
 *
 * Un seul composant pour ses trois emplacements (DECISIONS.md §41) : le bas du panneau Compte du
 * cinéma, la page de connexion, le bas du menu de la gestion (barre latérale au bureau, feuille
 * « Plus » sur téléphone). Écrite à la main à trois endroits, elle aurait fini par annoncer trois
 * versions différentes — c'est exactement ainsi que Jellyfin a affiché « 1.0.0 » pendant des mois.
 *
 * Seul « by » se traduit (« par », « por », « von » — `signature.by`) ; le nom, l'auteur et
 * « GitHub » sont des noms propres et restent tels quels. La version suit chaque build (`APP_VERSION`, lue dans `package.json`) et vaut « dev » hors build. Rien ici
 * n'est secret : la page de connexion est publique, et la version se lit déjà dans `/sw.js?v=`.
 *
 * La couleur est la plus pâle de l'interface : cette ligne ne doit jamais attirer l'œil avant ce
 * qui l'entoure. Le lien s'éclaircit au survol et prend le contour de focus des boutons au clavier.
 */
export function AppSignature({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <p className={`text-[11px] leading-5 text-white/30 ${className}`} data-app-signature>
      {APP_NAME} {displayVersion(APP_VERSION)} {t("signature.by")} {APP_AUTHOR}{" "}
      <span aria-hidden>·</span>{" "}
      <a
        href={APP_REPOSITORY_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("signature.sourceLink")}
        className="rounded-sm transition-colors hover:text-white/60 focus-visible:text-white/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
      >
        GitHub
      </a>
    </p>
  );
}
