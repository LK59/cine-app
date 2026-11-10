#!/usr/bin/env bash
# Cuisson des lightmaps du chalet : Blender (Cycles CPU, dans le conteneur immersion-blender) puis encodage KTX2.
# Depuis immersion/ :  tools/bake/bake.sh [--only salon,sud,nuit,sofa] [--sofa fichier.glb] [--samples N] [--calibrate] [--margin PX] [--exposure EV] [--layers nuit,lampes] [--no-preview]
# Voir tools/bake/README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
# Par défaut : tous les groupes de l'export (salon, sud, nuit, terrasse… — la liste vient de scene.json).
ONLY="$(python3 -I -c "import json;print(','.join(json.load(open('assets-src/bake/scene.json'))['groups']))" 2>/dev/null || echo salon,sud,nuit)"; ONLY_GIVEN=0; SOFA="assets-src/sofa/sofa_bake.glb"; SAMPLES=128; CAL=0; PREVIEW=1; LAYERS="nuit,lampes"; EXPO=""; MARGIN=""; CPUS=5
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; ONLY_GIVEN=1; shift 2;;
    --sofa) SOFA="$2"; shift 2;;
    --samples) SAMPLES="$2"; shift 2;;
    --calibrate) CAL=1; shift;;
    --margin) MARGIN="$2"; shift 2;;
    --exposure) EXPO="$2"; shift 2;;
    --layers) LAYERS="$2"; shift 2;;
    --no-preview) PREVIEW=0; shift;;
    *) echo "option inconnue : $1" >&2; exit 2;;
  esac
done
U=(--rm --cpus "$CPUS" --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work -w /work)
BL() { local n="$1"; shift; docker run "${U[@]}" --name "immersion-bake-$n-$$" immersion-blender -b --python tools/bake/bake.py -- "$@"; }
mkdir -p assets-src/bake/work public/assets/lightmaps tools/bake/previews
EXTRA=(); [ -n "$MARGIN" ] && EXTRA+=(--margin "$MARGIN")

# Le canapé réel, s'il existe à cet instant, remplace les occluders pour toutes les cuissons ; sinon on le dit.
SOFA_ARGS=()
if [ -f "$SOFA" ]; then SOFA_ARGS=(--sofa "$SOFA"); echo "canapé : $SOFA (cuit comme quatrième atlas)"; [[ ",$ONLY," == *,sofa,* ]] || ONLY="$ONLY,sofa"
else echo "canapé : $SOFA absent — occluders en boîtes, pas d'atlas sofa"; ONLY="${ONLY/,sofa/}"; fi

if [ "$CAL" = 1 ] || [ ! -f assets-src/bake/work/calibration.json ]; then BL calibrate --calibrate; fi
if [ "$CAL" = 1 ] && [ "$ONLY_GIVEN" = 0 ]; then echo "étalonnage seul"; exit 0; fi

# KTX2 : sRGB 8 bits, UASTC + zstd, mipmaps ; le lambda de RDO monte jusqu'à passer sous le budget.
# Budgets par fichier (deux couches par atlas, 9 Mo au total : assemble.py le vérifie).
encode() {
  local stem="$1" budget="$2" in="assets-src/bake/work/$1.png" out="public/assets/lightmaps/$1.ktx2" l
  for l in 1 3 6 10 16 24 40; do
    docker run "${U[@]}" --name "immersion-bake-ktx-$$" --entrypoint ktx immersion-assets-tools create --format R8G8B8_SRGB --encode uastc \
      --uastc-quality 2 --uastc-rdo --uastc-rdo-l "$l" --zstd 18 --generate-mipmap --mipmap-wrap clamp --threads 3 --assign-tf srgb "$in" "$out"
    local sz; sz=$(stat -c %s "$out"); echo "  $stem.ktx2 : lambda $l -> $sz octets (budget $budget)"
    [ "$sz" -le "$budget" ] && return 0
  done
  echo "  $stem.ktx2 : budget dépassé" >&2
}

IFS=, read -ra GROUPS_ <<< "$ONLY"
IFS=, read -ra LAYERS_ <<< "$LAYERS"
for g in "${GROUPS_[@]}"; do
  BL "$g" --group "$g" --samples "$SAMPLES" --layers "$LAYERS" ${SOFA_ARGS[@]+"${SOFA_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"}
  for layer in "${LAYERS_[@]}"; do
    stem="$g"; [ "$layer" = nuit ] || stem="${g}_${layer}"
    # Le canapé : ses coutures sont des creux d'un ou deux texels, cuits presque noirs — à l'écran, des traits
    # sombres en pointillé le long des coussins. Les clairs sont dilatés de trois texels (filtre « maximum »)
    # avant l'encodage : les traits disparaissent, l'ombrage large reste. L'original est gardé à côté.
    if [ "$g" = sofa ]; then
      command -v ffmpeg >/dev/null || { echo "ffmpeg manquant : nécessaire pour adoucir la lightmap du canapé" >&2; exit 3; }
      cp "assets-src/bake/work/$stem.png" "assets-src/bake/work/${stem}_brut.png"
      ffmpeg -v error -y -i "assets-src/bake/work/${stem}_brut.png" -vf "format=gbrp,dilation,dilation,dilation" "assets-src/bake/work/$stem.png"
    fi
    case "$g" in nuit) encode "$stem" 450000;; sofa|terrasse) encode "$stem" 700000;; *) encode "$stem" 1800000;; esac
  done
done
python3 -I tools/bake/assemble.py
if [ "$PREVIEW" = 1 ]; then
  P=(--preview ${SOFA_ARGS[@]+"${SOFA_ARGS[@]}"}); [ -n "$EXPO" ] && P+=(--exposure "$EXPO")
  BL preview "${P[@]}"
fi
echo "ok : public/assets/lightmaps/"; ls -l public/assets/lightmaps
