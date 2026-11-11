# Déployer les salons du chalet

Le service `laterna-salons` est facultatif : sans lui, le mode Immersion reste solitaire, jeux compris. Il se
déploie à côté de Laterna, comme le service des acteurs à l'écran, et ne demande **aucun changement du relais
inverse** : les navigateurs passent par l'adresse de Laterna.

## Ce qu'il faut

- Laterna **10.38** ou plus récent (le relais `/api/salons/ws` et la route du laissez-passer).
- Un réseau Docker partagé avec le conteneur de Laterna (ici `media_net`).
- Un relais inverse qui laisse passer les WebSockets jusqu'à Laterna (Nginx Proxy Manager : « Websockets
  Support » coché sur l'hôte de Laterna — déjà le cas si le lecteur fonctionne derrière lui depuis longtemps, à
  vérifier sinon).
- Environ 60 Mo de mémoire au repos ; un cœur suffit largement.

## 1. La clé

Une seule valeur, partagée par Laterna et le service. 32 caractères au moins (le service refuse de démarrer
sinon) :

```sh
openssl rand -hex 32
```

Gardez-la hors du dépôt (un fichier `.env` à côté du `docker-compose.yml` du service).

## 2. Le service

Dans un dossier à lui (par exemple `/opt/stacks/laterna-salons/`), un `docker-compose.yml` — l'exemple complet
est [`../docker-compose.example.yml`](../docker-compose.example.yml) :

```yaml
services:
  laterna-salons:
    image: ghcr.io/lk59/laterna-salons:latest   # ou build: <dépôt>/salons
    container_name: laterna-salons
    restart: unless-stopped
    environment:
      SALONS_KEY: ${SALONS_KEY:?SALONS_KEY manquante}
    networks: [media_net]
    mem_limit: 256m
    cpus: 1
networks:
  media_net:
    external: true
```

et un `.env` à côté : `SALONS_KEY=<la clé>`. Puis :

```sh
docker compose up -d
docker logs laterna-salons     # « [salons] prêt (version …) », « à l'écoute sur le port 8090 »
```

Aucun port n'est publié : le service n'est joignable que depuis le réseau Docker.

## 3. Laterna

Gestion → Configuration → **Connexions** → carte **Salons du chalet** :

| Champ | Valeur |
|---|---|
| Adresse du service des salons | `http://laterna-salons:8090` (le nom du conteneur sur le réseau partagé) |
| Clé du service des salons | la même clé qu'à l'étape 1 |
| Jeu à plusieurs ouvert à | `admins` pour essayer, puis `tous` |

« Tester » doit répondre `laterna-salons <version>`. Les mêmes réglages existent en variables (`SALONS_ENABLED`,
`SALONS_URL`, `SALONS_KEY`, voir `.env.example`) ; ceux de l'application l'emportent. Rien à redémarrer.

## 4. Vérifier

1. Ouvrir le chalet (chercher « immersion » dans le cinéma), Échap → **À plusieurs** : les salons publics et
   les boutons de création s'affichent. « Le jeu à plusieurs n'est pas disponible ici » : la fonction est coupée
   pour ce compte, ou la clé ne correspond pas (`docker logs laterna-salons` ne dit rien d'une connexion refusée,
   c'est voulu ; « Tester » dans Laterna dit si la clé est bonne).
2. Créer un salon privé ; depuis un autre appareil ou un autre compte, le rejoindre par son code. Chacun voit
   l'autre dans la liste des présents.
3. `docker logs laterna-salons` : `salon ouvert <code> (privé) par …`.

## Mettre à jour

```sh
docker compose pull && docker compose up -d
```

Un redémarrage ferme les salons ouverts : les clients reçoivent « redémarrage » (code 4503), se reconnectent
d'eux-mêmes et reviennent à l'accueil des salons. Mieux vaut le faire quand personne ne joue. Un redéploiement de
**Laterna**, lui, ne ferme aucun salon : les connexions sont coupées une seconde et reprennent leur place.

## Couper

Réglage « Jeu à plusieurs ouvert à » sur `off` : plus aucun laissez-passer n'est délivré, l'écran « À plusieurs »
dit que le chalet est solitaire. Les connexions déjà ouvertes continuent jusqu'à leur prochaine coupure. Le
conteneur peut ensuite être arrêté.

## Essayer sans rien déployer

Pour les scénarios du chalet (`immersion/tests/e2e/18-salons.spec.ts`), un service de test et l'aperçu du
chalet, qui relaie la WebSocket comme Laterna :

```sh
docker build -t laterna-salons:test salons
docker run -d --rm --name immersion-salons-test --network host -e PORT=8097 \
  -e SALONS_KEY=cle-de-test-des-salons-scenario-18-0123456789 laterna-salons:test
# aperçu du chalet avec SALONS_DEV_URL=http://127.0.0.1:8097 (voir immersion/PROGRESS.md, « Environnements »)
```

Arrêtez-le ensuite (`docker stop immersion-salons-test`).

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Tester » : injoignable | le service n'est pas sur le même réseau Docker que Laterna, ou son nom diffère de l'adresse réglée |
| « Tester » : non autorisé | la clé de Laterna n'est pas celle du service |
| Le chalet dit « indisponible » | fonction coupée ou réservée aux administrateurs ; clé de moins de 32 caractères dans Laterna |
| « Connexion perdue, reconnexion… » en boucle | le relais inverse ne laisse pas passer les WebSockets ; ou le service est arrêté |
| Le service ne démarre pas | `SALONS_KEY` absente ou trop courte (`docker logs laterna-salons`) |
