# Le lecteur canevas — retiré le 24/09/2026

Le lecteur natif a eu, pendant trois semaines, un second chemin local : décoder le fichier avec
WebCodecs et peindre l'image dans un `<canvas>`. Ce document dit ce qu'il était, pourquoi il a été
retiré, ce qu'il a appris au projet, et comment le retrouver.

Le code est intact au tag **`lecteur-canvas-final-2026-09-24`**.

## Ce qu'il était

Deux façons de lire une vidéo dans un navigateur, qui ne diffèrent pas là où on l'attendrait.
WebCodecs utilise lui aussi le décodeur matériel quand il existe : la différence n'est pas
« matériel contre logiciel », elle est dans **qui tient la chaîne de présentation**.

- **Le chemin natif** (remultiplexage → MediaSource → `<video>`) s'arrête au conteneur. Il
  réemballe le fichier en MP4 fragmenté et le confie à un vrai élément vidéo : le navigateur et le
  système décodent, synchronisent l'image sur leur propre horloge audio, composent l'image
  directement et l'envoient en HDR à l'écran. C'est un *muxer* qui alimente un lecteur.
- **Le chemin canevas** tenait tout après le démultiplexage. `VideoDecoder` rendait des
  `VideoFrame`, qu'une boucle `requestAnimationFrame` choisissait et dessinait en WebGL ; le son,
  décodé à part (`AudioDecoder` ou nos décodeurs WebAssembly), passait par WebAudio, et c'était ce
  code qui tenait l'horloge maîtresse et y calait l'image. Le HDR était converti en SDR dans un
  shader. Un objet imitait un `HTMLMediaElement` (`currentTime`, `paused`…) pour que les commandes
  ne voient pas la différence. C'était un *lecteur*.

| | Natif | Canevas |
|---|---|---|
| Synchronisation image/son | le navigateur | notre code, latence de sortie comprise |
| HDR | natif | conversion approchée, réglée à l'œil |
| Batterie, chaleur | minimales | une boucle JavaScript par image, une copie vers le GPU |
| PiP, AirPlay, écran verrouillé, plein écran iOS | fournis | perdus, ou à refaire |
| Contraintes de MediaSource | subies | aucune |
| Contrôle image par image | non | total |

Il avait sa place au début : il savait lire ce que MediaSource refusait — un son qu'aucun
navigateur n'accepte dans un MP4, un codec que le remultiplexeur ne savait pas décrire.

| Fichier | Lignes | Rôle |
|---|---|---|
| `engine.ts` | 1 270 | démultiplexage, décodeurs, boucle de présentation, sous-titres |
| `renderer.ts` | 570 | dessin WebGL, conversion HDR, repli 2D |
| `audioOutput.ts` | 374 | graphe WebAudio, horloge, repli stéréo |
| `mediaFacade.ts` | 145 | l'imitation d'élément média pour les commandes |
| `hdrMath.ts` | 61 | la courbe de la conversion HDR, pour les tests |

## Pourquoi il a été retiré

**Il ne servait plus.** Du 4 au 24 septembre 2026, le journal du lecteur compte 616 séances :
600 par le chemin natif, 6 par le lecteur serveur, **10 par le canevas** — toutes d'un même compte,
en essai, et aucune après le 21 septembre. Aucune n'a servi à regarder un film :

| Séances | Ce qui s'est passé | Ce qui l'a rendu inutile |
|---|---|---|
| 3 | E-AC3 sur Chrome, une minute chacune, puis relancées en natif | le son réencodé en AAC ou en Opus dans le chemin natif |
| 1 | Dolby Vision sans couche de base : échec en 2 s (« conversion HDR impossible ») | ce cas va directement au lecteur serveur |
| 4 | TrueHD : échec en 1 s (« pas de son ») | le décodeur TrueHD de FFmpeg, compilé en WebAssembly |
| 2 | FLAC : le décodeur audio casse dans la même seconde | FLAC décodé par libFLAC, livraison par piste |

Les seuls fichiers qu'il savait encore lire et que le chemin natif refuse sont en VP8 ou VP9 :
la bibliothèque n'en contient aucun (5 150 HEVC, 1 215 H.264, 21 AV1, un MPEG-4), et le lecteur
serveur les lit.

**Il coûtait à chaque fois qu'il était tenté.** Un canevas qui échoue tout de suite, c'est du
chargement en plus avant le même repli, et du bruit dans le journal.

**Il compliquait chaque décision.** Chaque refus du chemin natif devait dire s'il visait *ce
chemin* (« essayez le canevas ») ou *ce lecteur* (« passez au serveur »). Deux fois, le journal a
montré le canevas ouvert pour échouer sur un problème déjà connu : le Dolby Vision sans couche de
base (20/09), le MP2 (24/09). Chaque garde de lecture devait être posée des deux côtés ; les sauts,
les pauses, les reconstructions avaient deux mécaniques.

## Ce qui a changé

- Le choix du chemin est binaire : le chemin natif, ou une erreur qui nomme la raison et que
  l'hôte confie au lecteur serveur (`choosePlaybackPath`, `fallToStable`). Le libellé des refus
  est inchangé (« Aucun chemin de lecture disponible pour ce fichier. remux : … »).
- Les cinq fichiers ci-dessus sont supprimés, avec leurs tests (681 lignes).
- Ce que le chemin natif empruntait au moteur a déménagé : le type des pistes (`PlayerTrack`,
  `playerTrack.ts`, ex-`EngineTrack`) et le texte des sous-titres (`subtitleText`,
  `TEXT_SUBTITLE_CODECS`, `SubtitleCue`, dans `subtitleMarkup.ts`).
- Retirés parce que seul le canevas s'en servait : `videoConfigFor`, `audioConfigCandidates`,
  `unsupportedReason` et `SOFTWARE_AUDIO_CODECS` (`codecConfig.ts`) ; trois avertissements (« pas de
  son », « son interrompu », « aucun décodeur ») ; le champ `canvasHdrRefusal` de
  `/api/jellyfin/direct`, toujours nul.
- Restent, parce que le chemin natif s'en sert : les décodeurs FLAC et TrueHD, l'audio logiciel
  qui alimente le réencodage, le plafond de lumière HDR du chemin natif (`hdrDisplay.ts`).
- Sans lecteur serveur (`PLAYER_SERVER_FALLBACK=false`), un fichier que le chemin natif refuse
  finit sur une erreur de lecture qui nomme la raison.

## Ce qu'il a appris au projet

Ce qui suit vaut au-delà du canevas, et c'est ce qui en reste de plus utile.

- **L'horloge doit dater ce qu'on entend, pas ce qu'on traite.** Le son sort avec une latence que
  le navigateur annonce (`outputLatency`, sinon `baseLatency`) : l'ignorer, c'est une image en
  avance de 150 à 250 ms avec un casque Bluetooth. Le chemin natif n'a pas ce problème parce que le
  navigateur tient l'horloge — c'est une des raisons de le préférer.
- **L'ordre des canaux se mesure, il ne se déduit pas.** Le canevas repliait le multicanal en
  stéréo avec sa propre matrice, qui avait divergé de celle du réencodage. Il n'en reste qu'une,
  `fold` (`audioTranscode.ts`), et la méthode qui l'a réglée : décoder le vrai fichier en Node,
  comparer chaque canal à `ffmpeg -filter:a astats` (voir DOC-TECH, « Channel order »).
- **Le blanc SDR est à 203 nits.** Normaliser un HDR sur son pic de mastering donnait une image
  deux à quatre fois trop sombre. La même valeur a réglé, par un autre chemin, le HDR trop sombre de
  Chrome sur un écran SDR.
- **Le goulot n'était pas le décodage.** Mesuré sur la bibliothèque (`cout.spec.ts`) : ouvrir un
  film est borné par les octets à rapatrier, pas par le processeur. Décoder soi-même ne rendait rien
  plus rapide.
- **Une réponse de capacité est une promesse, pas une preuve.** Un appareil annonçait un décodeur
  E-AC3 et n'en tirait aucun son, sans erreur ; seul un décodage réel le révélait. Le chemin natif
  ne se fie pas davantage à `isTypeSupported` : un navigateur qui l'accepte puis refuse le
  `SourceBuffer` à l'ouverture fait passer le film au lecteur serveur au lieu de le laisser muet
  (`RemuxPlayback.start`), et le profil d'appareil du lecteur serveur éprouve chaque codec par un
  vrai `addSourceBuffer` (`codecSupport.ts`).
- **WebCodecs n'existe qu'en contexte sécurisé.** Sur le port de développement en HTTP, ni le
  canevas ni le réencodage audio ne tournent.

## Le retrouver

```sh
# Le code tel qu'il était, sans rien restaurer
git show lecteur-canvas-final-2026-09-24:src/lib/webcodecs/engine.ts

# Les fichiers d'origine, dans un dossier à part
git worktree add ../lecteur-canvas lecteur-canvas-final-2026-09-24
```

Le remettre en service demanderait de rebrancher `startEngine` dans `ExperimentalPlayerHost.tsx`,
la variante `webcodecs` de `choosePlaybackPath` et de `PathProbe`, et la distinction de refus
qu'elle impose — tout est visible dans le commit qui l'a retiré. Il faudrait d'abord une raison
mesurée : un format réel de la bibliothèque, lu par des spectateurs, que ni le chemin natif ni le
lecteur serveur ne savent servir.
