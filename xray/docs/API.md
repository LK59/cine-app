# X-Ray — référence de l'API (contrat v1)

Le contrat entre Laterna et `laterna-xray`, tenu des deux côtés : côté service par `app/main.py` et
`app/jobs.py` (et `tests/test_api.py`), côté Laterna par `src/lib/clients/xray.ts` (et
`xray-client.test.ts`). Il évolue **seulement par ajouts compatibles** : un champ nouveau est
facultatif dans une requête et ignorable dans une réponse ; chaque ajout est daté ci-dessous.

Pour ce que les résultats veulent dire : [PIPELINE.md](PIPELINE.md). Pour qui appelle quoi et quand :
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Sommaire

- [Généralités](#généralités)
- [`GET /health`](#get-health)
- [`POST /jobs`](#post-jobs)
- [`GET /items/{itemId}`](#get-itemsitemid)
- [`GET /items/{itemId}/scenes`](#get-itemsitemidscenes)
- [`GET /items/{itemId}/voices`](#get-itemsitemidvoices)
- [`GET /items/{itemId}/report`](#get-itemsitemidreport)
- [Renommer sans relire](#renommer-sans-relire)
- [Mémoire des séries](#mémoire-des-séries)
- [`GET /quality`](#get-quality)
- [`DELETE /items/{itemId}`](#delete-itemsitemid)
- [Versions des résultats](#versions-des-résultats)
- [Historique du contrat](#historique-du-contrat)

---

## Généralités

- **Adresse** : `http://laterna-xray:8000`, sur le réseau Docker partagé avec Laterna. Le service ne
  publie aucun port sur l'hôte.
- **Clé** : toute requête — `/health` compris — porte `Authorization: Bearer <XRAY_API_KEY>`. Sans clé
  valide : `401 {"error": "clé d'accès invalide"}`. Comparaison en temps constant ; une clé vide côté
  service refuse tout plutôt que de tout ouvrir.
- **Format** : JSON UTF-8 partout ; temps en secondes (nombres à trois décimales). Une erreur répond
  `{"error": "…"}`.
- **Identifiants** : `itemId` et `seriesId` sont les identifiants Jellyfin, 32 caractères hexadécimaux
  (insensibles à la casse) ; tout autre identifiant répond `404`. `personId` est l'identifiant TMDB de la
  personne.
- **Pas de documentation interactive** : `/docs`, `/redoc` et `/openapi.json` sont coupés.

---

## `GET /health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "model": { "name": "buffalo_l", "ready": true, "license": "non-commercial", "error": null },
  "decode": { "vaapi": true, "device": "/dev/dri/renderD128" },
  "inference": { "engine": "openvino", "device": "CPU", "gpu": false, "gpuActive": false, "gpuError": null,
                 "detector": "int8", "int8": { "state": "ready", "error": null } },
  "voice": { "enabled": true, "name": "wespeaker_r34", "label": "…", "ready": true, "license": "cc-by-4.0",
             "error": null, "vad": { "name": "silero_vad", "version": "6.2", "license": "mit" },
             "asd": { "enabled": true, "ready": true, "license": "mit", "error": null } },
  "queue": { "pending": 0, "running": null }
}
```

| Champ | Sens |
|---|---|
| `model.name` | `buffalo_l` ou `auraface` (`XRAY_MODEL`) |
| `model.ready` | `false` tant que les poids se téléchargent, et au premier démarrage pendant la quantification INT8 du détecteur ; `ok` reste `true` |
| `model.license` | `non-commercial` (`buffalo_l`) ou `apache-2.0` (`auraface`) |
| `model.error` | pourquoi les poids ne sont pas prêts (réseau, empreinte SHA-256 qui ne correspond pas) |
| `decode.vaapi` | le décodage matériel fonctionne |
| `inference` | *(informatif, 11/2026)* `engine` (`openvino`, `onnxruntime`, `null` avant le chargement), `device` (réglage `XRAY_OV_DEVICE`), `gpu` (réseaux chargés sur l'iGPU), `gpuActive` (servis par l'iGPU en ce moment — `false` pendant une transcodification de Jellyfin), `gpuError`, `detector` (`int8` ou `fp32` sur le processeur ; sur l'iGPU, toujours le réseau d'origine), `int8.state` (`off`, `building`, `ready`, `failed`) et `int8.error` |
| `voice` | *(10/11/2026)* modèle d'empreinte de voix, licence, prêt, erreur, détection de parole ; `voice.asd` : lecture des lèvres |
| `queue.pending` | ordres en attente |
| `queue.running` | l'`itemId` en cours d'analyse, sinon `null` |

Laterna lit `/health` pour le bouton « Tester la connexion » (modèle, prêt, décodage matériel) et, côté
planificateur, pour savoir si la file du service ne contient que ses propres commandes.

---

## `POST /jobs`

Commande l'analyse d'un élément.

```json
{
  "itemId": "0123456789abcdef0123456789abcdef",
  "path": "/media/tv/Série/Saison 1/Série - S01E06.mkv",
  "etag": "…",
  "priority": "high",
  "startAt": 1500,
  "seriesId": "fedcba9876543210fedcba9876543210",
  "originalLanguage": "en",
  "cast": [
    { "personId": 12345, "name": "…", "character": "…", "order": 0,
      "photos": ["https://image.tmdb.org/t/p/w185/….jpg"] }
  ],
  "skip": [ { "start": 0.0, "end": 62.4 } ],
  "rebindIfSameDuration": true,
  "durationS": 1871.4
}
```

| Champ | Obligatoire | Sens |
|---|---|---|
| `itemId` | oui | identifiant Jellyfin de l'épisode ou du film |
| `path` | oui | chemin **tel que Jellyfin le voit** ; doit désigner un fichier vidéo **dans** la médiathèque montée (`XRAY_MEDIA_ROOT`, liens symboliques résolus) |
| `etag` | oui | version du fichier (Laterna envoie l'`ETag` de la source Jellyfin, sinon `size:<octets>`) ; un résultat d'un autre `etag` est périmé |
| `priority` | oui | `high` (quelqu'un regarde), `normal`, `low` |
| `cast` | oui | la distribution de **cet** épisode ou film, invités compris : `personId`, `name`, `character`, `order`, et 12 photos au plus par personne, **adresses `https://image.tmdb.org/` uniquement** |
| `startAt` | non | position à analyser en premier (puis la fin, puis le début) |
| `seriesId` | non | pour la mémoire de la série (visages et voix) |
| `skip` | non *(11/2026)* | 32 plages au plus, `0 ≤ start < end`, en secondes — génériques, rappel, bande-annonce. Aucun visage n'y est cherché, les scènes ne les couvrent pas. Absent ou `null` : le service demande ses segments à Jellyfin (Intro, Outro, Recap, Preview) s'il y a accès ; `[]` : rien n'est sauté et Jellyfin n'est pas consulté |
| `rebindIfSameDuration`, `durationS` | non *(09/11/2026)* | fichier remplacé (réencodage) de même durée : avec `true` et la durée du nouveau fichier (> 0, obligatoire alors), un résultat **complet** sous un autre `etag` dont le fichier durait à ±1 s pareil passe au nouvel `etag` (et au nouveau chemin) sans analyse. La durée comparée est celle que ffprobe a lue sur l'ancien fichier, à défaut la fin du résultat complet ; sinon, comportement habituel |
| `originalLanguage` | non *(10/11/2026)* | code ISO 639 de la langue d'origine du titre : la piste son de la version originale pour « qui parle » |

**Réponses**

| Code | Corps | Cas |
|---|---|---|
| `202` | `{"itemId", "status": "queued" \| "running", "position"}` | mis en file ; `position` : 0 pour l'ordre en cours *ou qui commence tout de suite*, 1 pour le prochain, etc. |
| `200` | `{"itemId", "status": "done", "position": 0}` | déjà fait pour ce même `etag` — rien n'est relancé ; ou rattaché par `rebindIfSameDuration` |
| `400` | `{"error"}` | champ invalide, chemin hors de la médiathèque, photo hors de `image.tmdb.org`, JSON invalide |

- Un ordre **en double** (même `etag`, en attente ou en cours) ne fait que **remonter la priorité**.
- Un **autre `etag`** oublie l'ancien résultat et repart de zéro — sauf rattachement d'un fichier
  remplacé de même durée.
- Un **ordre en échec** est relancé.
- Entre deux tronçons, un ordre **cède la place** à un ordre plus prioritaire, et reprend ensuite là où
  il en était. À priorité égale, les ordres sont servis dans l'ordre d'arrivée.

---

## `GET /items/{itemId}`

L'état d'un ordre.

```json
{ "itemId": "…", "etag": "…", "status": "running", "progress": 0.094, "analyzedUntil": 840.0, "error": null,
  "durationS": 2551.36,
  "stats": { "seconds": 61.2, "realtime": 13.7, "skippedSeconds": 0, "decodeSeconds": 4.2,
             "stages": { "decode_wait": 1.1, "shots": 2.0, "convert": 0.3, "detect": 30.5, "grade": 1.2,
                         "embed": 18.4, "track": 0.4, "write": 0.1, "build": 1.0, "photos": 5.9, "other": 0.3 },
             "counts": { "decoded": 3360, "images": 420, "faces": 610, "embedded": 240, "early_exit": 31 } },
  "voices": { "complete": false, "voicesNamed": 12, "voicesUndecided": 4, "voicesConflict": 0,
              "voicesSmall": 30, "speechNamed": 0.71, "voicesAsd": 0, "asd": null },
  "faces": { "facesNamed": 0.83, "faceSeconds": 1520.4 } }
```

| Champ | Sens |
|---|---|
| `status` | `queued`, `running`, `done`, `failed` |
| `progress` | part du fichier analysée (1 une fois fini) |
| `analyzedUntil` | fin de la plage analysée **d'un seul tenant** à partir du tronçon de `startAt` (0 tant que ce tronçon n'est pas fait ; la durée du fichier une fois terminé) |
| `error` | la raison d'un échec |
| `durationS` | *(09/11/2026)* durée lue par ffprobe ; `null` avant le début de l'analyse |
| `stats` | *(11/2026, informatif)* temps de calcul des tronçons faits : `seconds`, `realtime` (× temps réel), `stages` (`decode_wait` : l'analyse attend ffmpeg ; `shots` : coupes ; `convert` ; `detect` ; `grade` : tri des visages ; `embed` ; `track` : pistes ; `write` ; `build` : regroupement, noms, scènes ; `photos` : distribution ; `other`), `counts`, `skippedSeconds`, `decodeSeconds`. `null` tant que rien n'est fait |
| `voices` | *(10/11/2026)* où en sont les voix ; `voicesAsd` et `asd` (`voicesTried`, `voicesResolved`, `voicesUndecided`, `undecidedBefore`, `votes`, `cpuSeconds`, `capped`, `status`) pour la lecture des lèvres |
| `faces` | *(10/11/2026)* `facesNamed` (part du temps de visage nommée), `faceSeconds` |

`404` si l'élément est inconnu. Laterna lit `durationS` et `stats.seconds` (vitesse affichée par le
planificateur, rattachement à durée égale).

---

## `GET /items/{itemId}/scenes`

Ce que Laterna montre dans la rangée « À l'écran ».

```json
{
  "itemId": "…", "etag": "…", "model": "buffalo_l", "version": 5,
  "complete": false, "analyzedUntil": 840.0,
  "scenes": [
    { "start": 750.0, "end": 850.4,
      "people": [ { "personId": 12345, "screenTime": 41.2, "confidence": 0.82 } ] }
  ]
}
```

- Les scènes couvrent toutes les plages déjà analysées (y compris, pendant l'analyse, des plages
  disjointes) : un résultat partiel est lisible à tout moment (`complete: false`).
- `people` est trié par temps de présence (`screenTime`, secondes) et ne contient **que des visages
  nommés**. `confidence` : 0,5 au seuil de rejet, vers 1 quand la ressemblance le dépasse nettement.
- `version` : la version de l'algorithme qui a produit *ce* résultat (voir
  [Versions des résultats](#versions-des-résultats)).
- `404` tant que rien n'est analysé.

---

## `GET /items/{itemId}/voices`

*(10/11/2026)* « Qui parle ».

```json
{
  "itemId": "…", "etag": "…", "model": "wespeaker_r34", "version": 2,
  "complete": true, "analyzedUntil": 1783.0,
  "track": { "index": 3, "language": "eng", "title": "English", "channels": 6, "reason": "original" },
  "stats": { "voicesNamed": 23, "voicesUndecided": 11, "voicesConflict": 1, "voicesSmall": 94, "speechNamed": 0.85 },
  "segments": [
    { "start": 12.32, "end": 14.1, "voiceId": 7, "personId": 12345, "confidence": 1.0 },
    { "start": 15.0, "end": 16.2, "voiceId": 9, "personId": null, "confidence": 0.0, "conflict": true },
    { "start": 18.4, "end": 20.0, "voiceId": 11, "personId": 67890, "confidence": 0.67, "via": "asd" }
  ]
}
```

| Champ | Sens |
|---|---|
| `segments[]` | les segments de parole, dans l'ordre : `voiceId` (une voix de cet élément), `personId` (la distribution de l'ordre) quand la voix est nommée, sinon `null`, `confidence` (0..1) |
| `conflict` | la mémoire de la série et les visages de l'épisode se contredisent : la voix reste sans nom |
| `via` | `"asd"` : nommée par la lecture des lèvres |
| `track` | la piste écoutée ; `reason` : `original` (langue d'origine), `vo` (titre ou marque), `default`, `first` ; `null` sans piste son utilisable |
| `complete` | `false` pendant l'analyse — **Laterna ne se sert alors d'aucun nom** |
| `version` | version de l'assemblage des voix : 1 (consensus de trois seuils, contraste, mémoire), 2 (petites voix à 0,75, lecture des lèvres) |

L'alignement des répliques de sous-titres sur ces segments, et la règle des répliques à deux voix ou
trop courtes, sont l'affaire de Laterna ([PIPELINE.md](PIPELINE.md#8d-côté-laterna--quand-une-réplique-reçoit-un-nom)).
`404` tant qu'il n'y a rien.

---

## `GET /items/{itemId}/report`

*(10/11/2026)* Le **rapport de décision** de l'élément : ce qui a été fait, avec quoi, et pourquoi.
Refait et gardé en base (table `reports`) à chaque fin de passage qui change le résultat — analyse
complète (`trigger: "analyse"`), voix par le son seul (`"voix"`), lecture des lèvres (`"lèvres"`),
renommage (`"renommage"`) —, refait à la demande (`"lecture"`) s'il manque ou date d'un autre fichier.
Tout vient de la base et des constantes du code : le refaire donne le même rapport. Il ne fait jamais
échouer ce qui l'appelle. `404` si l'élément est inconnu ; pour un élément pas encore fini, le rapport de
ce qui est fait (non gardé).

| Partie | Contenu |
|---|---|
| `service` | version, `commit` (posé à la construction, `--build-arg XRAY_COMMIT=…` ; `null` sinon), versions des résultats, des voix, de la lecture des lèvres, du rapport ; `analysedWith` : version, commit et nombre de passages de l'analyse de l'image |
| `results` | version et état des scènes, des voix, de la lecture des lèvres |
| `models` | visages (détecteur avec `precision` `int8`/`fp32` et les fichiers de l'IR INT8, empreinte, moteur), voix (VAD, empreinte), lèvres : fichier, version publiée, SHA-256, licence |
| `devices` | inférence : réglage, part des tronçons sur l'iGPU / le processeur / les deux (`chunks`, `gpuShare`) ; décodage : tronçons VA-API / processeur / sautés, images non référencées sautées (`noref`) ; voix (processeur) ; lèvres (décodeurs, appels iGPU/processeur) |
| `audio` | piste retenue (rang, langue, codec, canaux, disposition), `reason`, `originalLanguage`, ce qui est écouté (`channelUse` : `centre`, `centre_c2`, `downmix`) et le filtre |
| `thresholds` | visages (regroupement, rejet, bandes sûre / à confirmer, écart, présence), voix (paramètres complets), `smallVoice` (6 morceaux, 0,75), lèvres (règles de vote et choix des instants, plafond), scènes (durées, ressemblances, règle des rafales) |
| `skipped` | plages sautées, leur source (`ordre`, `jellyfin`, `aucune`), secondes |
| `counts` | tronçons, plans, scènes, pistes et groupes de visages, groupes nommés, voix nommées / indécises / en désaccord / petites / par les lèvres, part de parole nommée, voix tentées et résolues par les lèvres |
| `cpu` | calcul de l'image par étape, × temps réel, assemblage des voix, lèvres (processeur, durée, plafond) |
| `voices` | **par voix** (`voiceId` de `/voices`) : `pieces`, `seconds`, `personId`, `via` (`faces`, `memory`, `asd`, `profile`), `confidence` ; sans nom, `reason` (et `reasons` si plusieurs) ; le meilleur `candidate` des visages (`score` de contraste, `margin`, `present`) et les votes des lèvres (`asd` : `votes`, `top`, `share`) |
| `voiceReasons`, `voiceVia` | les mêmes, comptés |
| `faceClusters` | par groupe de visages (nommés, puis anonymes de 2 s au moins ; `omitted` pour le reste) : `seconds`, `tracks`, `personId`, `score`, `margin` (sur le deuxième acteur, plancher 0), `band` (`sure`, `confirm`, `doubt`) ; anonyme : `candidate` et `reason` (`doubt_band`, `runner_up_close`, `too_short`, `person_taken`, `no_reference`) |

### Raisons d'une voix sans nom

De la plus décisive à la moins (`reason` est la première) :

| Code | Sens |
|---|---|
| `conflict_memory` | visages et mémoire de la série nomment deux personnes différentes |
| `too_few_lines` | moins de 3 morceaux |
| `small_voice_low_conf` | petite voix (moins de 6 morceaux) nommée sous 0,75 de confiance |
| `second_big_voice` | une personne, une voix : une autre voix plus fournie et nettement différente a déjà ce nom (téléphone, narration) |
| `no_consensus` | nommée au seuil du milieu, mais pas par deux des trois seuils |
| `asd_memory_conflict` | les lèvres désignent quelqu'un que la mémoire de la série contredit |
| `asd_anonymous_face` | les lèvres désignent un visage sans nom |
| `asd_too_few_votes` | moins de 3 votes pour le mieux placé |
| `asd_split_votes` | votes partagés (moins de 70 % pour le mieux placé) |
| `off_screen_no_candidate` | personne d'assez présent à l'image pendant elle |
| `low_contrast` | des visages, mais pas plus présents pendant cette voix que pendant les autres (contraste ou marge trop faibles) |
| `undecided` | rien de ce qui précède |

### Exemple (abrégé)

```json
{
  "reportVersion": 1, "itemId": "…", "etag": "…", "status": "done", "trigger": "lèvres",
  "service": { "version": "1.0.0", "commit": "8c7bbb2", "resultVersion": 5, "voiceVersion": 2, "asdVersion": 1 },
  "models": { "faces": { "name": "buffalo_l", "detector": { "file": "det_10g.onnx", "sha256": "5838f7fe…", "precision": "int8" } } },
  "devices": { "inference": { "setting": "GPU", "chunks": { "gpu": 11, "mixed": 2, "cpu": 2 }, "gpuShare": 0.867 },
               "decode": { "chunks": { "vaapi": 14, "skip": 1 }, "vaapiShare": 1.0, "noref": { "cpu": true, "vaapi": true } } },
  "audio": { "reason": "original", "originalLanguage": "en",
             "track": { "index": 1, "language": "eng", "codec": "eac3", "channels": 6, "channelUse": "centre" } },
  "skipped": { "source": "jellyfin", "ranges": [[0.0, 62.4]], "seconds": 62.4 },
  "counts": { "scenes": 41, "faceClusters": 63, "facesNamed": 12, "voicesNamed": 23, "voicesUndecided": 9,
              "voicesConflict": 1, "voicesSmall": 94, "asdTried": 5, "asdResolved": 2 },
  "voiceReasons": { "too_few_lines": 94, "low_contrast": 6, "off_screen_no_candidate": 2, "conflict_memory": 1, "asd_split_votes": 1 },
  "voices": [
    { "voiceId": 7, "pieces": 212, "seconds": 391.5, "personId": 12345, "via": "faces", "confidence": 0.98 },
    { "voiceId": 9, "pieces": 41, "seconds": 70.2, "personId": 67890, "via": "asd", "confidence": 0.67,
      "asd": { "votes": 9, "top": 67890, "share": 0.889 } },
    { "voiceId": 12, "pieces": 33, "seconds": 61.0, "personId": null, "reason": "second_big_voice",
      "candidate": { "personId": 12345, "score": 0.18, "margin": 0.56, "present": 0.9 } }
  ],
  "faceClusters": { "clusters": 63, "named": 12, "reasons": { "doubt_band": 40, "too_short": 6 },
                    "listed": [ { "cluster": 0, "seconds": 512.3, "tracks": 140, "personId": 12345, "score": 0.61,
                                  "margin": 0.42, "band": "sure", "confidence": 0.98 } ], "omitted": 30 }
}
```

---

## Renommer sans relire

*(10/11/2026)* Refaire regroupement et noms (visages puis voix) avec les seuils du code et la mémoire de
la série du moment, **sans décoder** ([PIPELINE.md](PIPELINE.md#10-renommer-sans-relire)). Les éléments
sont mis en file et servis par lots de 20 s au plus, jamais devant un ordre `normal` ou `high`.

| Route | Corps | Réponse |
|---|---|---|
| `POST /items/{itemId}/relabel` | — | `202 {"queued", "pending"}` ; `404` inconnu ; `409` analyse pas finie |
| `POST /series/{seriesId}/relabel` | facultatif `{"itemIds": [...]}` : l'ordre des épisodes (2 000 au plus) ; sans lui, l'ordre des chemins | `202 {"queued", "items", "pending"}` |
| `POST /relabel` | — | toute la bibliothèque (série par série) en file : `202 {"queued", "pending"}` |
| `GET /relabel` | — | `{"pending"}` |

---

## Mémoire des séries

*(10/11/2026)*

| Route | Réponse |
|---|---|
| `GET /series/{seriesId}/memory` | `{"seriesId", "entries": [{"kind": "face" \| "voice", "model", "personId", "itemId", "weight", "score", "updated"}]}` — une contribution par épisode et par personne ; `itemId: "legacy"` pour l'ancienne mémoire reprise une fois |
| `POST /series/{seriesId}/memory/reset` | corps facultatif `{"itemIds": [...]}` (ordre des épisodes) → efface la mémoire (visages et voix) puis renomme la série : `{"removed", "queued"}` |

---

## `GET /quality`

*(10/11/2026)* La qualité des noms, pour toute la bibliothèque.

```json
{
  "overall": { "items": 120, "withVoices": 118, "speechNamed": 0.66, "facesNamed": 0.81, "…": "…" },
  "movies": { "…": "…" },
  "series": [ { "seriesId": "…", "items": 10, "withVoices": 10, "speechNamed": 0.52, "facesNamed": 0.78,
                "voicesNamed": 120, "voicesUndecided": 40, "voicesConflict": 2, "itemsWithConflict": 1 } ],
  "items": [ { "itemId": "…", "seriesId": "…", "speechNamed": 0.41, "facesNamed": 0.7,
               "reportUrl": "/items/…/report" } ]
}
```

`series` : les moins bien nommées d'abord ; `speechNamed` : part du temps de parole nommée ; `facesNamed` :
part du temps de visage nommée. `items` : chaque élément fini, les moins bien nommés d'abord, avec le lien
de son rapport. `voicesAsd` et `asd` (`items`, `tried`, `resolved`, `cpuSeconds`) par groupe pour la
lecture des lèvres. Laterna l'affiche dans Configuration → Acteurs à l'écran, carte « Qualité des noms »
(les nombres de cet exemple sont illustratifs).

---

## `DELETE /items/{itemId}`

Oublie l'ordre et le résultat (fichier remplacé, résultat à refaire avec les règles du jour), et arrête
l'analyse s'il était en cours. Toujours `204`.

---

## Versions des résultats

Chaque résultat garde la version qui l'a produit (`version` de `/scenes` et de `/voices`). **Un résultat
d'une version antérieure reste servi tel quel** — il reste valable — et rien n'est réanalysé de soi-même :
un nouvel ordre au même `etag` répond encore `done`. Pour refaire avec les règles du jour : `DELETE` puis un
nouvel ordre (ou, quand seules les règles de noms ont changé, un renommage). Un ordre commencé sous une
version antérieure et pas fini repart de zéro, pour ne jamais mêler deux règles dans un même résultat.

| Version des scènes | Date | Changement |
|---|---|---|
| 1 | 11/2026 | première version |
| 2 | 09/11/2026 | bande de noms « à confirmer », scènes de 3 min au plus, HDR adapté |
| 3 | 09/11/2026 | la même, plus la coupe à contraste égal (décors sombres d'une seule teinte) |
| 4 | 09/11/2026 | images non référencées sautées aussi sur l'iGPU ; détecteur INT8 ; règles de noms et de scènes inchangées |
| 5 | 10/11/2026 | l'étape « qui parle » dans le même passage ; un ordre v4 fini garde ses scènes et ses voix sont complétées par le son seul |

Sans changer de version (10/11/2026) : une rafale de plans courts d'un autre lieu reste une scène — les
scènes sont regroupées à neuf à chaque assemblage depuis les plans gardés en base.

| Version des voix | Changement |
|---|---|
| 1 | morceaux de 2 s coupés aux changements de voix, consensus de trois seuils, contraste local avec les visages, mémoire de la série |
| 2 | petites voix (moins de 6 morceaux) nommées seulement à 0,75 ; lecture des lèvres (`via: "asd"`). Un résultat 1 reste servi ; un renommage le refait en 2 |

---

## Historique du contrat

| Date | Ajout compatible |
|---|---|
| 09/11/2026 | v1 : `/health`, `POST /jobs`, `/items/{id}`, `/items/{id}/scenes`, `DELETE /items/{id}` |
| 09/11/2026 | `skip` ; `rebindIfSameDuration` + `durationS` ; `durationS` et `stats` dans `/items/{id}` ; `inference` dans `/health` |
| 10/11/2026 | « Qui parle » : `originalLanguage`, `/items/{id}/voices`, `voices` et `faces` dans `/items/{id}`, `voice` dans `/health`, renommer sans relire, mémoire des séries, `/quality` |
| 10/11/2026 | lecture des lèvres : `via: "asd"`, `/voices` en version 2, `voices.asd`, `voice.asd` |
| 10/11/2026 | `/items/{id}/report` ; `items[]` avec `reportUrl` dans `/quality` |
