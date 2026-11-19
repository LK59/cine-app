# Essayé et abandonné

Ce que le projet a construit puis retiré, et ce qu'il a examiné puis écarté. Pour chaque entrée : pourquoi,
ce que ça a appris, et où retrouver le code ou la décision. Une idée qui figure ici ne revient pas sans un fait
nouveau ; la décision détaillée est dans `DECISIONS.md` quand une section existe.

## Construits puis retirés

### Le lecteur canevas — retiré le 24/09/2026

Un second chemin local : décoder la vidéo avec WebCodecs et la peindre dans un `<canvas>`, avec une horloge
audio tenue à la main et un HDR → SDR en shader, essayé avant le lecteur serveur.

- **Pourquoi** : en trois semaines, dix séances, toutes des essais, chacune finie par le même repli une seconde
  plus tard. Il obligeait aussi chaque refus à dire « pas par ce chemin » ou « pas par ce lecteur », distinction
  qui a disparu avec lui.
- **Appris** : WebCodecs passe lui aussi par le décodeur matériel ; la différence avec `<video>` n'est pas là où
  on l'attend. Garder un seul chemin local, et le lecteur serveur pour ce qu'il ne porte pas.
- **Où** : étiquette `lecteur-canvas-final-2026-09-24`, document complet `docs/lecteur-canvas.md`, DOC-TECH
  (« There used to be a second local path »).

### La lecture directe des MP4 — septembre 2026

Un chemin à part pour les fichiers MP4, confiés tels quels à `<video>`.

- **Pourquoi** : E-AC3 muet sur Chrome, pas de menus de pistes, pas de sous-titres intégrés. Un bon conteneur ne
  veut pas dire que tout ce qu'il contient se lit nativement.
- **Remplacé par** : `mediaFile.ts`, qui lit le MP4 comme le Matroska et le fait passer par le même remux.

### Le changement de piste son « dans le tampon » — retiré le 22/09/2026

Changer de piste sans reconstruire le lecteur, en remplaçant le son dans le tampon MediaSource.

- **Pourquoi** : plus lent qu'une reconstruction sur tous les moteurs, et un décalage image-son durable sur
  WebKit ; chaque tentative de survivre à un changement de codec dans un même tampon était un pari sur le
  décodeur d'un autre (Safari acceptait l'échange et ne jouait aucun son).
- **Règle restante** : tout changement de piste reconstruit le lecteur (CLAUDE.md, « Do not change these »).

### La réserve d'avance sur le disque — retirée le 28/09/2026

`DiskReserve` : télécharger l'avance du film dans le stockage de l'appareil (OPFS).

- **Pourquoi** : presque chaque octet regardé passait par la mémoire flash — environ 12 Go par heure de 4K. Retiré
  le jour même pour la santé des appareils.
- **Remplacé par** : `MemoryReserve`, l'avance en mémoire vive, par rafales (CLAUDE.md, « Reprendre et À suivre »).

### Lumen serveur — archivé le 17/11/2026

Le même remultiplexeur, exécuté par le serveur de Laterna et servi en HLS à Safari, avec des versions allégées
réencodées par le processeur graphique.

- **Pourquoi** (mesuré le 17/11/2026) : Safari choisit lui-même l'échelon de qualité, sans qu'on puisse le
  contraindre (un 4K sur un lien à 44 Mb/s joué en 536p) ; un saut à froid sur un échelon coûtait 4 à 16 s.
  MediaSource marche désormais sur tous les moteurs, iPhone compris.
- **Gardé** : le son tenu éveillé pendant une pause sur iPhone (`audioKeepAwake.ts`), la réouverture à l'image clé
  suivante après une perte répétée. Les anciennes adresses `/api/lumen/*` répondent 410.
- **Où** : étiquette `lumen-serveur-final-2026-11-17`, dossier `docs/remux-serveur/`, DECISIONS §196.

### mediabunny — retiré le 19/11/2026 (10.64.0)

La bibliothèque qui lisait le son que le navigateur ne décode pas : son propre lecteur Matroska/MP4, et ses
extensions `@mediabunny/ac3` et `@mediabunny/dts`.

- **Pourquoi** : deux lecteurs du même fichier, chacun avec son idée du point de départ d'un saut ; un
  comportement vu de l'extérieur seulement (la régression de 1.62.0 relisait le fichier entier, 18,9 Go pour un
  film) ; un défaut sur l'Opus « laçé » (trames d'une fin de cluster toutes au même instant) ; un banc à chaque
  montée de version.
- **Remplacé par** : `audioDemux.ts` (les paquets lus par le lecteur de l'image) et nos décodeurs — FFmpeg 7.1.5
  compilé ici pour l'AC-3, l'E-AC3 et le DTS (`tools/ac3dts-wasm`), libFLAC, l'AudioDecoder du navigateur pour
  l'Opus, l'AAC et le MP3. Prouvé identique à l'échantillon près sur 100 pistes de la bibliothèque avant le retrait.
- **Appris** : la spécialisation sur ses propres fichiers bat une bibliothèque générale, à condition de copier son
  comportement exactement et de le mesurer, pas de le supposer.
- **Où** : étiquette `mediabunny-final-2026-11-19` (10.63.2), DECISIONS §197, banc `audio-ref-bench.spec.ts`.

## Examinés puis écartés

| Idée | Pourquoi | Où |
|---|---|---|
| **Caler un saut sur l'image clé précédente** | la position demandée doit être exacte à la seconde | — |
| **Une application native complète** | l'interface et le lecteur à réécrire, AVPlayer ne lit ni le MKV ni le DTS, pas de machine macOS pour construire ; une coque native reste envisageable si iOS ne corrige pas ses défauts d'applications installées | — |
| **L'image dans l'image** | ne fonctionne pas dans une application web installée sur iPhone | — |
| **Le Dolby Vision vers un téléviseur** | la diffusion passe par le lecteur serveur | — |
| **Les acteurs à l'écran pour la musique** | étudié, peu de valeur pour le coût | — |
| **Un apprentissage par appareil** (réglages qui s'adaptent seuls) | décisions opaques, impossibles à relire au journal | — |
| **« Lire sur » un appareil Jellyfin** | hors du périmètre du cinéma | — |
| **Le flou sur les grandes surfaces** | coût mesuré par image, refusé à l'œil | DECISIONS §45 |
| **Les préchargements de tuiles au premier toucher de la barre** | une à deux secondes sans aperçu ; défait le jour même | CLAUDE.md, « Known pitfalls » |
| **Les parades au bug de hauteur des applications installées sur iOS** | quatre essayées (retirer la coquille du rendu, focus sans clavier, clavier appelé puis refermé, `scrollTo`), aucune n'a réparé | `src/lib/viewportWatch.ts` |
| **Des tests sans isolation, ou en `vmThreads`** | des doublures qui fuient d'un fichier à l'autre, une suite instable une fois sur trois | CLAUDE.md, « Where the suite's time goes » |
| **Livrer de l'E-AC3 à Safari au lieu d'AAC** | même plafond de 5.1, encodeur moins efficace, calcul en WebAssembly au lieu de l'encodeur du système | — |
