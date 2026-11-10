# Immersion en réalité virtuelle — plan (phase 2)

La phase 1 ne contient **aucun code WebXR**. Ce document dit ce qui est visé, ce qui marchera tel
quel, ce qu'il faudra écrire, et ce que la phase 1 a fait pour ne rien fermer.

## Cible

**WebXR** (`immersive-vr`) par `@react-three/xr`, depuis le navigateur du casque : même origine, même
session Laterna, rien à installer.

| Casque | Navigateur | Remarque |
|---|---|---|
| Meta Quest 2 / 3 / 3S / Pro | Navigateur Meta (Chromium) | la cible principale d'un casque autonome |
| Pico 4 | Navigateur Pico (Chromium) | même profil que Quest |
| Apple Vision Pro | Safari, visionOS 2 ou plus | WebXR sans manettes : regard + pincement (`transient-pointer`) |
| Casques PC (SteamVR, Windows Mixed Reality) | Chrome ou Edge + SteamVR | le rendu vient du PC : les préréglages d'ordinateur valent |

## Ce qui marche tel quel

- **La scène** : c'est du three.js ; `@react-three/xr` remplace la caméra par celle du casque et rend
  les deux yeux.
- **La vidéo** : une `VideoTexture` se lit en VR comme ailleurs. Le lecteur ne change pas (négociation
  par la route du lecteur serveur, HLS par hls.js — les navigateurs Chromium des casques l'acceptent).
- **Le son spatialisé** : l'écoute est accrochée à la caméra ; en VR la caméra est la tête, donc le
  suivi de tête est réel sans une ligne de plus.
- **La lumière précalculée** : c'est précisément ce qu'un casque autonome peut afficher.

## Ce qu'il faudra faire

1. **Une interface dessinée en 3D.** Le HTML posé dans la scène (`<Html transform>`) ne s'affiche pas
   en VR : c'est un calque du navigateur, pas un objet du monde. Piste : `@react-three/uikit` (mise en
   page flexbox rendue en WebGL), pilotée au rayon des manettes ou au regard et au pincement. Le
   clavier de recherche devient un clavier virtuel (ou la dictée du système).
2. **Un préréglage « VR »** pour casque autonome : 72 à 90 images par seconde en stéréo, lumière
   précalculée seule (aucune lumière ponctuelle par pixel), pas de post-traitement (ni halo, ni
   occlusion, ni passe de vidéo — la vidéo est alors dessinée directement, sans mappage de tons global),
   textures allégées (1K), neige réduite, rendu fovéal (`foveation`) activé.
3. **Des déplacements de confort** : téléportation au rayon, rotation par crans de 30°, et surtout
   **« s'asseoir dans le canapé »** face à l'écran comme mode principal — on vient regarder un film.
   La marche continue au stick reste une option, avec vignette de confort.
4. **L'écran « disponible sur ordinateur »** doit laisser passer un casque :
   `navigator.xr?.isSessionSupported("immersive-vr")` s'ajoute aux conditions de
   `src/lib/capability.ts` (un casque n'a pas de « pointeur fin »).
5. **Tests** : l'émulateur WebXR (IWER, `@iwer/devui`) pour les scénarios automatiques ; validation
   finale sur un vrai casque — aucun n'est disponible pour l'instant.

## Ce que la phase 1 a préparé

| Besoin de la VR | Où c'est dans la phase 1 |
|---|---|
| Une interface dont le rendu est remplaçable | L'état du panneau, du menu, des réglages et de la lecture vit dans `src/state/store.ts` ; tout ce que l'interface fait passe par `src/state/actions.ts`. Les composants de `src/ui/` ne retiennent rien : ils dessinent l'état et appellent les actions. Un rendu 3D lirait le même état. |
| Des entrées qui ne sont pas des touches | `src/input/intents.ts` : des intentions (« ouvrir », « valider », « s'asseoir », « retour »…), un mouvement et un regard. Le clavier et la souris (`keyboardMouse.ts`) ne sont qu'un périphérique ; des manettes en seraient un autre. |
| Une caméra qui n'est pas le personnage | `src/world/rig.ts` : le personnage est une entrée d'un registre (position, orientation) ; `Player.tsx` pose la caméra d'après lui. En VR, c'est le casque qui pose la caméra, et le personnage qui suit. |
| « Viser » | `aimedScreen()` (`src/world/panel.ts`) croise un rayon avec les écrans : aujourd'hui le rayon du regard, demain celui d'une manette. |
| Des réglages par préréglages | `src/lib/settings.ts` : un profil « VR » est une ligne de plus dans la table. |
| S'asseoir face à l'écran | Déjà une action (`toggleSeat`), déjà un point de vue (`SOFA.seatEye`). |

## Effort et ordre

Estimation à grands traits, pour une personne qui connaît le projet :

1. **Entrer en VR** (2 à 3 jours) : `@react-three/xr`, bouton « Entrer en VR », écran d'aptitude,
   position assise par défaut, vidéo et son vérifiés dans l'émulateur.
2. **Préréglage « VR »** (3 à 4 jours) : couper le post-traitement, dessiner la vidéo sans la passe,
   textures allégées, mesure des images par seconde sur casque.
3. **Interface 3D** (6 à 10 jours) : panneau, fiche, HUD, menu, réglages en `uikit` ; rayon et sélection ;
   clavier virtuel. C'est le gros du travail.
4. **Déplacements** (2 à 3 jours) : téléportation, rotation par crans, périphérique « manettes » dans
   `src/input/`.
5. **Vision Pro** (2 à 3 jours) : entrées par regard et pincement, vérification de Safari.
6. **Validation sur casque réel** : indispensable avant d'annoncer quoi que ce soit — confort, lisibilité
   du texte, chauffe.
