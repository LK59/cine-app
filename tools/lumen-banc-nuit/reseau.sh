#!/usr/bin/env bash
# Les profils réseau du banc : `tc netem` sur la boucle locale (`lo`) de l'espace réseau de l'instance — celui que le
# navigateur partage (`--network container:lumen-nuit-netns`). Tout le trafic navigateur ↔ instance passe par `lo`, et
# lui seul : l'instance parle à Jellyfin par son autre interface, que rien ne touche. Sur `lo`, chaque paquet traverse
# la file une fois (aller comme retour) : le délai posé ici vaut une fois par sens, l'aller-retour en vaut le double.
#
#   reseau.sh aucun | 5g | wifi-faible | montrer
#
# 5g          : 80 Mb/s, 25 ms ± 5 par sens (aller-retour ~50 ms) — une 5G moyenne, d'après les médianes publiées
#               (Opensignal, Ookla : 5G en Europe, débit descendant médian 100–200 Mb/s en ville, bien moins en
#               mobilité ou en itinérance ; latence 30–60 ms). Volontairement sous la médiane urbaine : le cas de Louis
#               (itinérance, serveur à l'autre bout de l'Europe).
# wifi-faible : 20 Mb/s, 10 ms ± 5 par sens, 0,05 % de pertes (le Wi-Fi répète ses trames : TCP voit peu de pertes ;
#               à 0,5 %, la formule de Mathis bornait TCP sous 5 Mb/s) — un Wi-Fi à travers deux murs ; sous le débit d un
#               film 4K à 25–40 Mb/s, au-dessus d'un 1080p à 5–10 Mb/s.
set -euo pipefail
# Des paquets de la taille d'un vrai lien : sur `lo` (MTU 65 536, TSO/GSO), une perte ou un délai s'appliquerait à
# 64 Ko d'un coup. MTU 1500 et segmentation logicielle coupée, le temps du profil.
SMALL="ip link set dev lo mtu 1500 && ethtool -K lo tso off gso off gro off >/dev/null"
case "${1:-montrer}" in
  aucun) cmd="tc qdisc del dev lo root 2>/dev/null || true; ip link set dev lo mtu 65536; ethtool -K lo tso on gso on gro on >/dev/null 2>&1 || true" ;;
  5g) cmd="$SMALL; tc qdisc replace dev lo root netem rate 80mbit delay 25ms 5ms distribution normal limit 100000" ;;
  wifi-faible) cmd="$SMALL; tc qdisc replace dev lo root netem rate 20mbit delay 10ms 5ms distribution normal loss 0.05% limit 100000" ;;
  montrer) cmd="true" ;;
  *) echo "profil inconnu : $1" >&2; exit 2 ;;
esac
docker run --rm --name lumen-nuit-tc --network container:lumen-nuit-netns --cap-add NET_ADMIN --entrypoint sh lumen-nuit-webkit:1 \
  -c "$cmd; tc qdisc show dev lo"
