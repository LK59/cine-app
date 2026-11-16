#!/usr/bin/env bash
# Vérifier soi-même quelle piste son joue, et le changement de piste (demande de Louis du 16/11) — voir README.md.
# Pour chaque titre à deux langues de la passe « son multiplexé » : Lumen serveur (groupes son séparés, la règle),
# Lumen serveur multiplexé, et le lecteur actuel (chaque langue ouverte d'emblée : la page ne sait pas lui faire
# changer de piste, l'hôte le fait par reconstruction). Le son joué est capté dans la page (banc.mjs MODE=son),
# le son de référence de chaque piste décodé par ffmpeg depuis le fichier (lecture seule), puis comparé
# (verif-son.mjs). Résultats : $WORK/out/son-<label>.verdict.json, et une ligne `son-verdict` dans marks.jsonl.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${NUIT_WORK:-$HOME/xbench/lumen-serveur/nuit}"
START="${START_AT:-600}"
M="$WORK/out/marks.jsonl"
REFS="$WORK/out/son-refs"
mkdir -p "$REFS"
# titre | identifiant | chemin du fichier (sous /mnt/media/video) | piste A (n° Matroska) | piste B
TITLES=(
  "maison-blanche|d4513bcf59bba90a23656f40ed816c3d|tv/The West Wing/Season 3/The West Wing - S03E01 - Manchester (1).mkv|2|3"
  "notting-hill|55027c51fd0cdeceec6062202c73a4db|movies/Notting Hill (1999)/Notting Hill (1999).mkv|2|3"
)
for row in "${TITLES[@]}"; do
  IFS='|' read -r key item path ta tb <<< "$row"
  [ -n "${TITLES_ONLY:-}" ] && [ "$key" != "$TITLES_ONLY" ] && continue
  # Les références : 70 s depuis START − 10, mono 8 kHz, chaque piste son par son rang (a:0 = la première).
  for k in 0 1; do
    out="$REFS/$key-a$k.f32"
    [ -s "$out" ] || docker run --rm --name lumen-nuit-ffref --cpus 1 -v /mnt/media/video:/m:ro -v "$REFS:/o" --entrypoint ffmpeg lumen-banc:etape2 \
      -hide_banner -loglevel error -ss $((START - 10)) -i "/m/$path" -t 70 -map 0:a:$k -ac 1 -ar 8000 -f f32le "/o/$key-a$k.f32"
  done
  for c in ${CASES_ONLY:-"serveur::$ta" "serveur:1:$ta" "actuel::$ta" "actuel::$tb"}; do
    IFS=':' read -r player mux audio <<< "$c"
    label="son-$key-$player$([ -n "$mux" ] && echo -mux)-p$audio-$(date +%H%M%S)"
    DECODE=sw "$HERE/nav.sh" MODE=son ITEM="$item" PLAYER="$player" ${mux:+MUX=1} AUDIO="$audio" START_AT="$START" LABEL="$label" > "$WORK/out/$label.log" 2>&1
    if [ -s "$WORK/out/son-$label.json" ]; then
      docker run --rm --name lumen-nuit-verif --cpus 1 -v "$HERE:/t:ro" -v "$WORK/out:/o" node:26-alpine \
        node /t/verif-son.mjs "/o/son-$label.json" "/o/son-refs/$key-a0.f32" fr "/o/son-refs/$key-a1.f32" en $((START - 10)) > "$WORK/out/son-$label.verdict.json" 2>&1
      echo "{\"t\":$(date +%s%3N),\"label\":\"$label\",\"mode\":\"son\",\"phase\":\"son-verdict\",\"verdict\":$(head -c 200000 "$WORK/out/son-$label.verdict.json")}" >> "$M" || true
      echo "$label : $(head -c 400 "$WORK/out/son-$label.verdict.json")"
    else
      echo "$label : pas de capture ($(tail -2 "$WORK/out/$label.log" | tr '\n' ' ' | cut -c1-300))"
    fi
  done
done
