# laterna-salons

Le temps réel du mode Immersion à plusieurs : les **salons du chalet**. Un service à part, facultatif, à côté de
Laterna. Sans lui (ou coupé dans les réglages), le chalet et ses jeux restent jouables seul — rien d'autre ne
change.

- Installer et mettre à jour : [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md).
- Ce qui est construit, et dans quel ordre : [`../immersion/docs/MULTIJOUEUR.md`](../immersion/docs/MULTIJOUEUR.md).
- La décision côté application : `DECISIONS.md` §146.

## Ce qu'il fait

- Des **salons** publics (listés, ouverts à tout compte de la maison) ou privés (un code d'invitation de six
  caractères), huit personnes au plus.
- L'**état partagé** du chalet : les lampes (trois groupes), la porte, le feu, la musique, la **télévision
  commune** ; les positions et l'apparence de chacun, le chat, « Devine le film ». Le reste du chalet est le même
  pour tous et ne passe pas par ici.
- Une **horloge** commune : chaque client mesure son décalage avec le service (`ping`/`pong`), et tout ce qui
  doit arriver au même moment chez tous est daté en heure du service.

Il ne stocke rien : les salons vivent en mémoire. Ils survivent aux redéploiements de Laterna (le service est un
autre conteneur) ; un redémarrage du service les ferme, et les clients reviennent au salon d'accueil.

## Comment on l'atteint

```
navigateur ──HTTPS/WSS──▶ relais inverse ──▶ Laterna ──(réseau Docker)──▶ laterna-salons
            /api/salons/ws                  server-boot/salonsRelay.mjs           /ws
```

- Le navigateur ne connaît que l'adresse de Laterna : même domaine, même HTTPS, même politique de sécurité. Le
  service n'est publié sur aucun port.
- Laterna relaie la connexion montante `/api/salons/ws` vers `SALONS_URL` (réglage) ; le relais inverse de la
  maison laisse déjà passer les WebSockets.

## Qui entre

1. Le chalet demande un **laissez-passer** : `GET /api/salons/pass`, derrière la session Laterna. La route répond
   toujours 200 : `{ available: false }` si le jeu à plusieurs n'est pas pour cette session (coupé, réservé aux
   administrateurs, lien de partage, service sans clé), sinon `{ available: true, pass, socket }`.
2. Le laissez-passer est signé par Laterna avec `SALONS_KEY` (HMAC-SHA256, cinq minutes) : `v1.<charge>.<signature>`,
   la charge `{ sub, name, admin, exp }`. Le service le vérifie et ne connaît ni compte ni secret de session.
   Le format est écrit deux fois — `src/pass.ts` ici, `src/lib/salons/pass.ts` dans l'application — et les deux
   côtés éprouvent le même vecteur de test.
3. Un laissez-passer refusé ferme la connexion **après** la poignée de main, code 4401 — jamais une réponse HTTP
   4xx, que le pare-feu du serveur compterait.

## Le protocole

Des messages JSON sur la WebSocket, chacun avec un type `t` ; le contrat est **`src/protocol.ts`**, importé tel
quel par le chalet (`immersion/src/net/`).

| Du client | Effet |
|---|---|
| `{ t: "ping", c }` | `{ t: "pong", c, s }` — `s` en heure du service |
| `{ t: "list" }` | `{ t: "rooms", rooms }` — les salons publics |
| `{ t: "create", visibility, name }` | ouvre un salon et y entre (quitte le précédent) → `joined` |
| `{ t: "join", code }` | entre dans un salon → `joined` ; erreurs `no-room`, `full` |
| `{ t: "leave" }` | → `left` |
| `{ t: "set", key, value }` | change un objet partagé ; diffusé à tous, demandeur compris : `{ t: "state", key, v, value, by }` |
| `{ t: "pos", p }` | sa position `[cm, cm, cm, mrad, mrad, bits]` — relayée aux autres : `{ t: "pos", id, p }` |
| `{ t: "chat", text }` | 200 caractères, 5 messages par 10 s → `{ t: "chat", id, name, text, at }` à tous |
| `{ t: "roster" }` | `{ t: "roster", token }` — les présents, signés pour l'application (`seal.ts`) |
| `{ t: "game.start", game, sealed }` | lance « Devine le film » : la partie et ses réponses scellées par l'application |
| `{ t: "game.answer", round, choice }` | une réponse (une par manche) ; `{ t: "game", game }` à chaque changement, `result` signé à la fin |
| `{ t: "game.stop" }` | arrête la partie pour tous |
| `{ t: "tv.open", ticket, title, from }` | lance un titre sur la télévision commune — `ticket` : le droit signé par l'application pour ce salon et ce titre (`seal.ts`, « tv ») ; → `{ t: "tv", tv }` à tous |
| `{ t: "tv.ready", epoch }` | prêt pour la préparation `epoch` ; quand tous les présents le sont, la lecture part à une heure du service |
| `{ t: "tv.play" }`, `{ t: "tv.pause" }`, `{ t: "tv.seek", to }`, `{ t: "tv.stop" }` | reprendre (nouvelle préparation), pause, saut, arrêt — pour tous |
| `{ t: "look", look }` | son apparence `[couleur, chapeau, écharpe, lunettes]` (`tv.ts`, bornée) → `{ t: "look", id, look }` aux autres |

`{ t: "list" }` rend aussi, pour chaque salon public, les premiers noms présents et ce qui s'y passe (`activity` :
`tv`, `quiz` ou rien).

Le service est **l'autorité** : un changement n'existe qu'une fois appliqué ici et numéroté (`v`, par objet) ; un
client ignore un `state` plus vieux que ce qu'il a. À l'arrivée — et à chaque reprise — `joined`/`welcome` porte
l'état complet du salon.

**Coupures** : `welcome` rend un jeton de reprise ; une nouvelle connexion qui le présente (même compte, dans les
60 s) retrouve la même place et le même salon. Les autres voient la personne « absente » entre-temps
(`{ t: "away" }`). Un salon que le dernier **quitte** (« Quitter », ou un autre salon) ferme aussitôt ; vidé par
une **coupure**, il attend 60 s de plus que la place du dernier, et ne figure plus dans la liste publique dès que
personne n'y est connecté.

**Bornes** (`LIMITS`) : 4 Kio par message, 8 personnes par salon, 64 salons, 30 messages par seconde (rafale de 60)
— au-delà la connexion est coupée (4429).

| Code de fermeture | Sens |
|---|---|
| 4401 | laissez-passer absent, mal signé ou expiré : en redemander un |
| 4429 | trop de messages |
| 4503 | le service s'arrête : se reconnecter |

## « Devine le film »

Le moteur est **un seul fichier**, `src/quiz.ts` : le service le fait tourner pour un salon (il tient le chronomètre
et les scores), et le chalet le fait tourner lui-même quand on joue seul, sans service. Les réponses d'une partie
arrivent **scellées** par l'application (`src/seal.ts`, AES-256-GCM sous la clé partagée) : le joueur qui lance les
transporte sans pouvoir les lire. À la fin, le service **signe le bilan** ; l'application n'enregistre de records à
plusieurs que ceux-là. `seal.ts` est importé tel quel par l'application (`src/lib/quiz/`).

## La télévision commune

`src/tv.ts`. Chacun lit **son propre flux** (sa séance Jellyfin) ; seul l'état est partagé : le titre, la phase
(`preparing`, `playing`, `paused`), la position et l'**heure de départ** en heure du service. Lancer, reprendre ou
sauter ouvre une préparation numérotée (`epoch`) : chacun cale son flux en pause et répond « prêt » ; quand tous les
présents l'ont dit — ou au bout de 20 s, ou dès qu'un absent part —, la lecture part 1,2 s plus tard pour tous. Le
service ne lance qu'un titre que l'application a signé pour ce salon, après avoir vérifié que chaque présent peut le
voir. Une partie de « Devine le film » prend la télévision.

## Développer

Node 26 exécute le TypeScript tel quel (types retirés au chargement) : rien n'est compilé, seule la syntaxe
effaçable est permise.

```sh
docker run --rm -v "$PWD":/w -w /w node:26-alpine sh -c 'npm ci && npm run typecheck && npm test'
docker build -t laterna-salons:local .     # les tests tournent dans la construction
```

Les scénarios du chalet à plusieurs navigateurs (`immersion/tests/e2e/18-salons.spec.ts`) tournent contre un vrai
service : voir le guide de déploiement, « Essayer sans rien déployer ».

## Journal

`docker logs laterna-salons` : le démarrage, et une ligne par salon ouvert et fermé (durée, participants au plus).
Jamais le contenu d'un message.
