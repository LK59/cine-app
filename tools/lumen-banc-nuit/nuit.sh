#!/usr/bin/env bash
# L'orchestration d'une nuit de banc — voir README.md à côté. Lit un plan (une étape par ligne) et le déroule :
#
#   lot <commit>                         (re)démarre l'instance : jamais plus de NUIT_LOT_MAX_S d'affilée (défaut 6600)
#   reseau <aucun|5g|wifi-faible>        profil tc netem sur la boucle de l'instance
#   serie <va|sw> <passe> <ordre>        une passe de la page /lumen-test (courte, complète, leviers, multiplexé)
#   conso <va|sw> <label> <item> <serveur|actuel> <durée s> [piste]   une lecture continue mesurée
#   essai <va|sw> <titre> <item> <serveur|actuel> [mux]   un essai seul (10 sauts) dans un navigateur neuf
#   pause <s>                            rien (laisser retomber la charge)
#   script <fichier> <durée s> [args]    un essai à part, écrit à côté (redemarrage.sh, son.sh) ; absent : sauté
#
# Avant chaque étape : l'heure limite (NUIT_FIN, epoch s), les lectures Jellyfin en cours et la charge sont notées dans
# $WORK/out/journal.log. Une `conso` attend que la charge retombe sous NUIT_CHARGE_MAX (défaut 6) au plus
# NUIT_ATTENTE_MAX_S (défaut 600) ; sinon elle est jouée quand même et marquée (`load` dans marks.jsonl).
#
#   NUIT_CREDS=… NUIT_FIN=$(date -d 07:00 +%s) nuit.sh plan.txt
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${NUIT_WORK:-$HOME/xbench/lumen-serveur/nuit}"
PLAN="$1"
FIN="${NUIT_FIN:?NUIT_FIN : heure limite, epoch s}"
LOT_MAX="${NUIT_LOT_MAX_S:-6600}"
CHARGE_MAX="${NUIT_CHARGE_MAX:-6}"
ATTENTE_MAX="${NUIT_ATTENTE_MAX_S:-600}"
J="$WORK/out/journal.log"
mkdir -p "$WORK/out"
log() { echo "$(date '+%F %T') $*" | tee -a "$J"; }
load1() { cut -d' ' -f1 /proc/loadavg; }
lot_start=0
lot_ref=""

# Une étape de plus tiendrait-elle avant l'heure limite ?
reste() { echo $(( FIN - $(date +%s) )); }

start_lot() {
  lot_ref="$1"
  log "lot : sessions Jellyfin avant démarrage"
  "$HERE/sessions.sh" 2>&1 | sed 's/^/    /' | tee -a "$J"
  log "lot : charge $(cat /proc/loadavg)"
  "$HERE/reseau.sh" aucun >/dev/null 2>&1 || true
  "$HERE/instance.sh" start "$1" 2>&1 | tail -2 | tee -a "$J"
  lot_start=$(date +%s)
  # Les journaux de démarrage de l'instance : une tâche de fond qui démarrerait malgré CINE_BACKGROUND_JOBS=off se lirait ici.
  docker logs lumen-nuit-app 2>&1 | tail -15 | sed 's/^/    [instance] /' | tee -a "$J"
}

ensure_lot() {
  local need="$1"
  if [ -z "$(docker ps -q -f name=^lumen-nuit-app$)" ] || [ $(( $(date +%s) - lot_start + need )) -gt "$LOT_MAX" ]; then
    local net; net="$(cat "$WORK/out/reseau.courant" 2>/dev/null || echo aucun)"
    log "lot : redémarrage de l'instance (durée du lot ou instance absente)"
    start_lot "$lot_ref"
    [ "$net" != aucun ] && "$HERE/reseau.sh" "$net" >/dev/null 2>&1
  fi
}

wait_calm() {
  local t0; t0=$(date +%s)
  while awk -v l="$(load1)" -v m="$CHARGE_MAX" 'BEGIN{exit !(l>m)}'; do
    if [ $(( $(date +%s) - t0 )) -ge "$ATTENTE_MAX" ]; then log "charge toujours à $(load1) après ${ATTENTE_MAX} s : mesure jouée quand même"; return; fi
    sleep 30
  done
}

while read -r step a b c d e f; do
  case "$step" in ""|\#*) continue ;; esac
  left=$(reste)
  case "$step" in
    lot) start_lot "$a"; continue ;;
    reseau) "$HERE/reseau.sh" "$a" 2>&1 | tail -1 | sed "s/^/réseau $a : /" | tee -a "$J"; echo "$a" > "$WORK/out/reseau.courant"; continue ;;
    pause) sleep "$a"; continue ;;
    script)
      # Un essai à part (redémarrage, vérification du son), écrit à côté ; absent : sauté.
      if [ -x "$HERE/$a" ] && [ "$left" -gt "${b:-1800}" ]; then
        ensure_lot "${b:-1800}"
        log "début script $a (charge $(load1))"; "$HERE/$a" $c $d $e $f >> "$WORK/out/script-$a.log" 2>&1; log "fin script $a : sortie $?"
      else log "script $a sauté (absent ou plus le temps)"; fi
      continue ;;
  esac
  case "$step" in
    serie) need=$([ "$b" = complète ] && echo 2700 || echo 1500) ;;
    essai) need=300 ;;
    conso) need=$(( e + 240 )) ;;
    *) log "étape inconnue : $step"; continue ;;
  esac
  if [ "$left" -lt "$need" ]; then log "sautée (reste ${left} s, il en faut ~${need}) : $step $a $b $c $d $e $f"; continue; fi
  ensure_lot "$need"
  net="$(cat "$WORK/out/reseau.courant" 2>/dev/null || echo aucun)"
  log "sessions Jellyfin :"; "$HERE/sessions.sh" 2>&1 | sed 's/^/    /' | tee -a "$J"
  case "$step" in
    serie)
      label="serie-$b-$c-$a-$net-$(date +%H%M)"
      log "début $label (charge $(load1))"
      DECODE="$a" timeout 5400 "$HERE/nav.sh" MODE=serie PASS="$b" ORDER="$c" LABEL="$label" NET="$net" > "$WORK/out/$label.log" 2>&1
      log "fin $label : sortie $? (charge $(load1))"
      ;;
    essai)
      # essai <décodage> <titre> <item> <lecteur> [mux] — un navigateur neuf par essai (fuite du greffon `va`).
      label="essai-$b-$d${e:+-mux}-$a-$net-$(date +%H%M%S)"
      log "début $label (charge $(load1))"
      NAV_MEM="${NAV_MEM_ESSAI:-8g}" DECODE="$a" timeout 600 "$HERE/nav.sh" MODE=essai ITEM="$c" PLAYER="$d" SEEKS="${NUIT_SEEKS:-10}" ${e:+MUX=1} LABEL="$label" NET="$net" > "$WORK/out/$label.log" 2>&1
      log "fin $label : sortie $? (charge $(load1))"
      ;;
    conso)
      wait_calm
      label="conso-$b-$d-$a-$net-$(date +%H%M)"
      log "début $label (charge $(load1))"
      # L'iGPU, sur la même fenêtre : intel_gpu_top (conteneur privilégié, lecture des compteurs seulement).
      docker run -d --rm --name lumen-nuit-gputop --privileged lumen-nuit-webkit:1 \
        sh -c "intel_gpu_top -J -s 5000 -d drm:/dev/dri/card0 > /dev/stdout" >/dev/null 2>&1 || true
      DECODE="$a" timeout $(( e + 600 )) "$HERE/nav.sh" MODE=conso ITEM="$c" PLAYER="$d" DURATION_S="$e" ${f:+AUDIO=$f} LABEL="$label" NET="$net" > "$WORK/out/$label.log" 2>&1
      rc=$?
      docker logs lumen-nuit-gputop > "$WORK/out/$label.gpu.json" 2>/dev/null || true
      docker rm -f lumen-nuit-gputop >/dev/null 2>&1 || true
      log "fin $label : sortie $rc (charge $(load1))"
      ;;
  esac
done < "$PLAN"
log "plan terminé"
