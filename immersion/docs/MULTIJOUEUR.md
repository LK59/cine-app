# Immersion à plusieurs — plan (phase 2)

La phase 1 ne contient **aucun code réseau**. Ce document dit ce qui est visé, comment, et ce que la
phase 1 a fait pour ne rien fermer.

## Regarder ensemble

Chaque participant lit **son propre flux** : une séance Jellyfin par personne, négociée pour son
navigateur comme aujourd'hui. Personne ne relaie de vidéo à personne. Ce qui est partagé, c'est un petit
**état de lecture** :

```
{ titre, position, lecture | pause, horodatage du serveur }
```

Chaque client s'y conforme : il connaît l'heure du serveur (décalage mesuré à la connexion), en déduit
la position attendue à l'instant présent, et corrige la sienne — par une légère variation de
`playbackRate` (± 5 %) pour un écart de moins de deux secondes, par un saut au-delà. Une pause, un saut
ou un changement de titre par l'un est une **commande** envoyée au service, qui met à jour l'état et le
diffuse à tous.

Charge serveur : **une lecture par participant** (un transcodage chacun si son navigateur l'exige). À
borner : nombre de participants par salon, et la « conversion HDR → SDR » multipliée d'autant.

## Un service temps réel à part

Next.js n'est pas fait pour tenir des connexions permanentes. Le temps réel vit dans un **service à
part** (WebSocket), sur le modèle du service des acteurs à l'écran : son propre conteneur, son propre
code, commandé par l'application.

- **Entrée derrière la session Laterna** : l'application délivre un laissez-passer court (signé, lié à
  la session et au compte) ; le service ne parle qu'à qui le présente. Aucun compte ni mot de passe dans
  le service.
- **Salons** : créés par un participant, rejoints par une invitation ; état en mémoire, rien de durable.
- **Messages** : commandes de lecture (`open`, `play`, `pause`, `seek`), positions des personnages (dix à
  vingt par seconde, interpolées à l'arrivée), présence.

## Droits

Un titre ne se lance pour le groupe **que si tous les participants peuvent le voir** : les tags bloqués
de chaque compte s'appliquent. C'est l'application qui répond — le service lui demande, pour un titre et
une liste de comptes, « tous peuvent-ils ? » — et un refus ne dit pas à cause de qui. Chaque client
négocie ensuite sa propre lecture, sous son propre compte : un participant sans droit sur un titre ne
recevrait de toute façon aucun flux.

Chaque client **rapporte sa propre progression** à Jellyfin (reprise, « vu ») : rien n'est écrit au nom
d'un autre.

## Ensuite

- **Avatars** : une silhouette simple par participant (tête orientée comme son regard), son nom.
- **La voix** (WebRTC, pair à pair pour de petits groupes, avec un serveur de relais en secours),
  spatialisée comme le reste : une `PositionalAudio` par participant.

## Ce que la phase 1 a préparé

| Besoin du multijoueur | Où c'est dans la phase 1 |
|---|---|
| Un état de lecture qui n'est pas le `<video>` | `Playback` dans `src/state/store.ts` : ce qui est **voulu** (titre, pause, saut) y est écrit ; le `<video>` s'y conforme (`follow()` dans `src/media/playback.ts`) et n'en est jamais la source. Un état partagé n'aurait qu'à écrire au même endroit. |
| Des commandes de lecture en un seul endroit | `src/media/commands.ts` : `open`, `play`, `pause`, `toggle`, `seek`, `seekBy`, `mute`, `stop`, par `dispatch(commande, origine)`. Aucun composant ne touche à l'élément vidéo. C'est là que les commandes partiront au réseau et en reviendront. |
| Un personnage local parmi d'autres | `src/world/rig.ts` : un registre de personnages (identifiant, position, orientation) ; celui de la page est l'entrée `local`. La caméra le lit, elle n'est pas son état. |
| Rien qui suppose un seul compte | Chaque page négocie, rapporte et journalise sous sa propre session ; aucun état de lecture n'est gardé côté application. |

## Effort et ordre

1. **Le service** (4 à 6 jours) : WebSocket, salons, laissez-passer délivré par l'application, horloge.
2. **Lecture synchronisée** (4 à 6 jours) : état partagé, commandes par le réseau, correction de dérive,
   vérification des droits de tous.
3. **Présence** (3 à 4 jours) : positions, interpolation, avatars simples, noms.
4. **Invitations et interface** (3 à 4 jours) : créer un salon, inviter, rejoindre, quitter ; qui est là.
5. **La voix** (5 à 8 jours) : WebRTC, relais, spatialisation, coupure du micro.
6. **Mesure de charge** : combien de lectures simultanées le serveur tient, transcodages compris.
