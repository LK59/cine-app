# Immersion à plusieurs — plan arrêté (11/11/2026)

Ce document remplace le premier jet de la phase 1. Il fixe ce qui sera construit, dans quel ordre, et
comment chaque étape est vérifiée. Tout ce qui n'y figure pas est hors périmètre tant qu'il n'y est pas ajouté.

## Décisions

| Sujet | Décision |
|---|---|
| Où vit le temps réel | Un **service à part**, conteneur `laterna-salons` (Node, WebSocket), sur le modèle du service des acteurs à l'écran. Les salons et leur état vivent en mémoire dans ce service : ils **survivent aux redéploiements de l'application**. |
| Comment on l'atteint | **Par l'adresse de Laterna**, sans toucher au relais inverse (qui laisse déjà passer les WebSockets) : le programme de démarrage de l'application (`server-boot/boot.mjs`) relaie la connexion montante `/api/salons/ws` vers le service, sur le réseau Docker. Même origine : la politique de sécurité (`connect-src 'self'`) n'a pas à changer. |
| Qui entre | Un **laissez-passer** court (signé par l'application, lié à la session et au compte, quelques minutes) que le service vérifie à la connexion. Aucun compte ni secret de session dans le service. Les liens de partage (`share`) n'y ont pas accès. |
| Salons | **Publics** (listés, ouverts à tout compte de la maison) et **privés** (code d'invitation, lien). **8 personnes au plus.** En solo : un salon d'une personne, même code. |
| État du chalet | **Sans état** (identique pour tous, rien de synchronisé) **sauf** : les **écrans** (ce qui joue), les **lampes** (trois groupes), la **musique** (en marche, morceau, position), la **porte** et le **feu**. |
| Avatars | **Personnalisables**, construits par le code (formes simples, couleurs, accessoires) — **aucun fichier à télécharger**. Choix gardés par compte, dans l'application. Nom au-dessus de la tête, tête qui suit le regard, marche animée. |
| Discussion | **Un chat texte** dans le salon, à la façon d'un jeu : une touche pour écrire, Entrée pour envoyer, les messages s'affichent en bas à gauche puis s'effacent. **Pas de voix.** |
| Mini-jeu | **« Devine le film »** : manches chronométrées, réponses en **QCM**, sur la télévision, chacun gardant la liberté de se déplacer. |
| Records | **Gardés par compte**, consultables dans le menu (Échap) → **Statistiques**. |

## Le protocole

- Messages **JSON** sur la WebSocket, petits, chacun avec un type (`hello`, `snapshot`, `op`, `state`, `pos`,
  `chat`, `game`, `ping`/`pong`). Le service est **l'autorité** : un client envoie une **intention**
  (« allumer les lampes du salon », « pause »), le service l'applique, la numérote et la **diffuse à tous** — le
  client qui l'a demandée l'applique à son retour, pas avant (pas de divergence possible).
- **À l'arrivée** (et à chaque reconnexion) : un `snapshot` complet de l'état du salon. Ensuite seulement des
  **changements**, chacun portant la **version** de l'objet : un message plus vieux que l'état connu est ignoré.
- **L'horloge** : décalage mesuré par `ping`/`pong` à la connexion puis régulièrement (le plus court aller-retour
  fait foi) ; tout ce qui est daté l'est en heure du service.
- **Positions** : 10 à 15 par seconde au plus, **seulement quand on bouge**, quantifiées (centimètres, angles
  en entiers) ; interpolées à l'arrivée avec ~100 ms de retard voulu, extrapolées brièvement si un paquet manque.
- **Reconnexion** : coupure (déploiement de l'application, réseau) → nouvelle connexion avec le même salon et
  un nouveau laissez-passer, `snapshot`, et l'on repart. Le service garde la place d'un participant 60 s.
- **Bornes** : taille des messages, cadence par participant (positions, chat, intentions), nombre de salons.
  Un client qui dépasse est coupé, pas puni silencieusement.

## La télévision commune

- Chacun lit **son propre flux** (sa propre séance Jellyfin, négociée pour son navigateur, comme aujourd'hui).
  Seul l'**état de lecture** est partagé : titre, position, lecture ou pause, heure du service.
- **Démarrage quand tout le monde est prêt** : le service annonce le titre et la position ; chaque client
  négocie, **précharge** (premières secondes en mémoire tampon) et répond « prêt » ; quand tous sont prêts (ou au
  bout d'un délai, ceux qui ne le sont pas suivent seuls), le service fixe **l'instant de départ** dans un futur
  proche, et chacun démarre à cet instant. Même chose pour une reprise après pause ou un saut.
- **Dérive** : chaque client compare sa position à celle attendue ; écart sous 2 s → `playbackRate` ± 5 %
  le temps de rattraper ; au-delà → saut.
- **Droits** : un titre ne se lance pour le salon **que si tous les participants peuvent le voir** (tags
  bloqués de chacun). C'est l'application qui répond, et un refus ne dit pas à cause de qui. Chacun rapporte sa
  propre progression à Jellyfin.

## « Devine le film »

- **Lancé sur une télévision** (celle du salon ou une autre) ; la question s'affiche **sur l'écran 3D**, les
  quatre propositions **sur l'écran de chacun** : touches **1 à 4** au clavier (sans libérer le curseur — on
  continue de marcher, de regarder), quatre boutons au doigt.
- **Manches chronométrées**, comme les jeux de « blind test » : un indice apparaît, le temps file, la première
  bonne réponse rapporte le plus ; une réponse fausse bloque le joueur pour la manche. Indices : **affiche floue
  qui se précise**, image du film (fond), **réplique**, slogan, distribution, année. Séries de 10 manches,
  puis le tableau des résultats ; des variantes (tout en affiches, rythme qui accélère) se règlent au lancement.
- **Préparé par l'application, pas par le navigateur** : les manches sont tirées **parmi les titres que tous
  les participants peuvent voir** ; les images sont servies par une route du jeu **sans l'identifiant du titre
  dans l'adresse** (personne ne triche en lisant le réseau) ; le service tient le chronomètre et les scores.
- **Records** : à la fin d'une partie, l'application enregistre le score de chaque compte (meilleur score, meilleure
  série, justesse, parties jouées, par variante). Menu Échap → **Statistiques** : les siens et le classement de
  la maison.

## Le chat

- Une touche ouvre la saisie (sans libérer le curseur au-delà de la frappe), Entrée envoie, Échap annule ; au
  doigt, un bouton. 200 caractères au plus, texte brut, cadence bornée.
- Les messages (nom, texte) s'affichent en bas à gauche et s'effacent après quelques secondes ; la saisie
  ouverte montre les derniers. **Rien n'est gardé** une fois le salon fermé ; rien n'est écrit au journal.

## Pare-feu, journaux, tests

- La WebSocket est **une seule connexion** : rien de nouveau pour la règle des noms de fichiers. Les images du
  jeu passent par **une seule route** ; le scénario 15 (noms distincts, réponses 4xx) est étendu à une partie.
- Journaux : une ligne par salon ouvert et fermé (durée, participants, parties jouées) dans `docker logs` du
  service ; les erreurs des clients par la route d'erreurs de l'application.
- Tests : unitaires dans le service (protocole, versions, horloge, bornes, droits) ; scénarios Playwright à
  **deux ou trois navigateurs dans le même salon** (une lampe allumée par l'un l'est chez les autres, une pause,
  un départ synchronisé, le chat, une partie complète, la reconnexion après un redémarrage du service).
- Toute instance de test de l'application tourne avec `CINE_BACKGROUND_JOBS=off`, est arrêtée dès les tests
  finis, et ses `docker logs` sont lus deux minutes après son démarrage. Conteneurs de test nommés, `docker ps`
  vérifié à la fin.

## Ordre de travail (une livraison par étape)

1. **Le service et la connexion** : conteneur `laterna-salons`, laissez-passer, relais par `boot.mjs`, salons
   (créer, rejoindre, quitter, publics et privés), horloge, reconnexion, bornes ; tests unitaires et un scénario à
   deux navigateurs.
2. **Le chalet partagé** : lampes, porte, feu, musique synchronisés ; présence (positions, avatars simples avec
   nom) ; le chat.
3. **La télévision commune** : état de lecture partagé, préchargement et départ quand tous sont prêts, dérive,
   droits de tous.
4. **« Devine le film »** : manches, indices, QCM, scores, records et Statistiques.
5. **Avatars personnalisables, liste des salons, invitations** ; finitions.
