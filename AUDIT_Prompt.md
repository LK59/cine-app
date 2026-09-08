# Mission : audit complet du projet

Tu réalises un audit exhaustif de ce projet. Tu NE MODIFIES AUCUN FICHIER
de code source. Ton seul livrable est un rapport écrit.

## Contexte projet

App web/PWA qui sert des médias depuis un serveur Jellyfin, avec pour
objectif de maximiser le DirectPlay et d'éviter le transcodage serveur
(cible : serveurs Jellyfin sans GPU). Catalogue ~95% HEVC.
Navigateurs cibles : Chrome/Firefox Windows, Safari + Chrome iOS,
Chrome + Samsung Internet Android, en navigateur et en PWA.

## Méthode imposée

1. **Reconnaissance.** Parcours l'arborescence, identifie les modules
   fonctionnels (négociation de lecture, DeviceProfile/capacités, lecteur,
   couche API Jellyfin, auth, UI, build/config). Écris cet inventaire en
   tête de `AUDIT.md` avant toute analyse.
2. **Audit module par module.** Traite un module à la fois, complètement,
   et écris ses findings dans `AUDIT.md` avant de passer au suivant.
   N'accumule pas tout en mémoire pour tout écrire à la fin.
3. **Synthèse finale.** Une section de fin listant les findings par
   sévérité décroissante, et les 5 chantiers prioritaires.

## Format de chaque finding

- **ID** : incrémental (`F-001`)
- **Localisation** : `chemin/fichier.ext:ligne`
- **Catégorie** : correctness | sécurité | performance | robustesse | dette
- **Sévérité** : critique | important | mineur
- **Constat** : ce que fait le code aujourd'hui
- **Conséquence** : ce qui casse concrètement, et dans quelles conditions
- **Preuve** : les lignes exactes qui l'établissent. Si tu ne peux pas
  citer de ligne, c'est une hypothèse : marque-la `[HYPOTHÈSE]`.
- **Correction proposée** : le diff ou l'approche
- **Risque de la correction** : ce qui peut régresser si on l'applique

## Ce que tu cherches

**Correctness.** Erreurs de logique, conditions de course, états
impossibles non gérés, gestion d'erreur absente ou avalée, promesses non
attendues, cleanup d'effets manquant, incohérences entre deux chemins de
code censés faire la même chose (notamment : deux négociations
`PlaybackInfo` distinctes qui ne produiraient pas le même verdict que la
session de lecture réelle côté Jellyfin).

**Sécurité.** Secrets ou clés API Jellyfin exposés côté client, stockage
et durée de vie des tokens, XSS via les métadonnées Jellyfin injectées
dans le DOM (titres, descriptions, noms de fichiers), CORS et CSP,
SSRF/path traversal sur toute route de proxy ou de stream, absence de
validation des entrées, dépendances avec CVE connue.

**Performance.** Requêtes réseau redondantes ou séquentielles qui
pourraient être parallèles, re-renders inutiles, listeners et blob URLs
non libérés sur l'élément `<video>` (fuites mémoire sur navigation
répétée), chargement d'images/posters non différé, poids du bundle,
polling évitable.

**Robustesse.** Comportement en réseau dégradé, serveur Jellyfin
injoignable, media qui échoue en cours de lecture, reprise après veille
sur mobile, cycle de vie PWA.

**Dette.** Duplication réelle, abstractions qui fuient, code mort avéré
(vérifie qu'il n'est pas atteint dynamiquement avant de l'affirmer).

## Contraintes strictes

- **Ne modifie aucun fichier hors `AUDIT.md`.** Pas de fix, pas de
  refactor, pas de formatage, même « pendant que tu y es ».
- **Ne propose pas de factoriser les branches spécifiques à un
  navigateur** dans la détection de capacités et la construction du
  DeviceProfile. Elles encodent des comportements vérifiés empiriquement
  (exemple : Firefox force le transcode complet sur du HEVC 4K HDR10+/DV
  mais fait du DirectStream sur du HEVC Full HD SDR ; Chrome fait du
  DirectStream sur les deux). Ces différences ne sont pas déductibles du
  code. Si tu penses qu'une de ces branches est un vrai bug, remonte-la
  comme finding argumenté, jamais comme cleanup.
- **Pas de bruit.** Aucun finding sur le style, le formatage, le nommage,
  ou l'absence de tests en général. Aucun bump de dépendance sans CVE.
  Si un point n'a pas de conséquence observable, ne le remonte pas.
- **Pas d'invention.** Si un comportement dépend d'un fichier ou d'une
  config que tu n'as pas lue, lis-la. Ne déduis rien d'un nom de
  variable ou de fonction.
- Si un module dépasse ce que tu peux analyser sérieusement d'un bloc,
  découpe-le et dis-le dans le rapport plutôt que de survoler.
