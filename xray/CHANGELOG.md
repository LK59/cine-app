# Journal des versions de laterna-xray

Une version X.Y.Z par déploiement : majeure pour une refonte, mineure pour une fonction ou un lot de
changements de comportement, correctif sinon. La version est servie par `GET /health` (`version`), écrite dans
chaque rapport de décision (`service.version`) et dans la ligne de démarrage du journal ; le commit l'accompagne.
Les versions des résultats (`RESULT_VERSION`, `VOICE_VERSION`, `ASD_VERSION`) suivent leur propre règle
(`app/config.py`) : elles ne bougent que quand un résultat ancien devient incomparable.

## 1.5.0

- **Débuts de scène** (« Revenir au début de la scène » côté Laterna) : par frontière de scène, le point d'entrée
  (`entry`, reculé jusqu'au début d'une phrase commencée juste avant) et le verdict (`cut: {ok, why}` — chapitre
  d'auteur, ou couleurs **et** personnes qui changent ; refus au milieu d'un dialogue, même lieu, montage, îlot),
  la part de parole et les chapitres du fichier, en ajout compatible de `/items/{id}/scenes`. Mesuré à
  l'assemblage depuis ce qui est en base, chapitres lus une fois par ffprobe ; les résultats d'avant sont repris en
  tâche de fond sans décoder. Version propre (`CUTS_VERSION` 1) : `RESULT_VERSION`, les scènes et leurs personnes
  ne changent pas. Voir `docs/PIPELINE.md` §12.

## 1.4.0

- **Synchro des sous-titres** : mesure, à la demande, du décalage et de la dérive de chaque piste de sous-titres
  texte (intégrée ou à côté du fichier) contre la parole détectée — `POST /subsync/jobs`, `GET /subsync/results`.
  Aucun fichier n'est modifié ; l'application de la correction revient au client. Voir `docs/PIPELINE.md` §11.

## 1.3.0

- **Lecture des lèvres** (détection du locuteur actif) pour nommer les voix que les visages ne tranchent pas.
- **Journal** JSON tournant dans le volume de données, secrets masqués ; **rapport de décision** par élément
  (`GET /items/{id}/report`).
- **Voies d'analyse** (`XRAY_LANES`) : une voie iGPU, et une voie processeur quand la machine le permet.
- Voix identiques d'un calcul à l'autre (la mémoire de série ne relit plus la contribution de l'élément lui-même).
- Base en pages de 16 Kio (−27 % de place, contenu identique), réécrite une fois au démarrage.

## 1.2.0

- **Qui parle** : détection de la parole, empreintes de voix, noms par les visages et mémoire de série ;
  renommage sans relecture du fichier ; statistiques de qualité.

## 1.1.0

- Inférence sur l'iGPU (OpenVINO) avec retour au processeur quand Jellyfin transcode, détecteur INT8 produit sur
  place, décodage VA-API sans images non référencées, assemblage incrémental.

## 1.0.0

- Reconnaissance des visages de la distribution scène par scène, scènes et présences par élément, mémoire des
  visages par série.
