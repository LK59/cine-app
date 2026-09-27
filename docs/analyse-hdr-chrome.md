# HDR trop sombre dans Chrome sous Windows (écran SDR) — analyse

*Recherche du 22/09/2026. Aucune modification du code de l'application. Les références au code
Chromium/Skia renvoient à la branche `main` lue ce jour-là ; la machine observée tourne sous
Chrome 152, et les points qui dépendent de la version sont signalés.*

---

## 1. Résumé

1. Sous Windows, avec un écran SDR, Chrome **ne confie pas** la vidéo HDR au pilote (pas de plan
   matériel, pas de VideoProcessor). Le compositeur (Viz → Skia) la convertit lui-même, par un
   opérateur normalisé : **RWTMO** (SMPTE ST 2094-50 annexe C, dans l'esprit de BT.2408).
2. Sous Windows, le « blanc de référence » de cet opérateur est le **niveau de blanc SDR que
   Windows déclare pour l'écran** (fonction `UseDisplaySDRMaxLuminanceNits`, active par défaut sous
   Windows seulement). Sur un écran SDR, c'est très probablement **80 nits**.
3. Sur un écran SDR, RWTMO place ce blanc de référence à **50 % de la lumière linéaire** dès que la
   lumière maximale annoncée dépasse ~394 nits (4,93 × 80). Autrement dit, **tout ce qui est
   en dessous de 80 nits, soit l'essentiel d'un film, est assombri d'un diaphragme**. La
   métadonnée ne décide que de la façon dont les hautes lumières sont compressées.
4. D'où **l'échec du plafond à 650 nits** : 650 > 394, donc le facteur appliqué aux tons moyens
   reste 0,5. Retirer le HDR10+ n'a rien changé non plus : Chrome ne lit que les SEI T.35 au format
   SMPTE ST 2094-50 (AGTM), pas l'ST 2094-40 (HDR10+).
5. *Dirty Dancing* paraît juste parce que **son étalonnage est plus lumineux**, pas grâce à ses
   métadonnées : la valeur PQ moyenne de ses images, mesurée ici, est nettement au-dessus de celle
   de *2012*, *American Psycho* et *Apocalypse Now*.
6. Firefox (Windows) ne fait aucun tone mapping lui-même. Le rendu clair vient très probablement du
   VideoProcessor du pilote graphique, sans métadonnée, qui écrête les hautes lumières (à confirmer,
   voir le plan de test). Safari (EDR) fait correspondre **100 nits PQ au blanc SDR** et range les
   hautes lumières dans la marge de l'écran : c'est le « juste milieu ».
7. **Levier direct et bon marché** : le plafond existant, mais **placé sous 394 nits**. Vers
   **150 nits**, Chrome rend les tons moyens comme « 100 nits = blanc » (le repère de Safari), avec
   une compression douce de 80 à 150 nits et un écrêtage au-delà. C'est un changement d'une ligne,
   testable en cinq minutes.
8. **Levier robuste mais coûteux** : demander à Jellyfin une version SDR tone-mappée côté serveur
   quand l'écran n'est pas HDR. Le serveur (iGPU UHD 630, QSV + OpenCL, `bt2390` déjà actif) tient
   **~7× le temps réel en 1080p SDR** et **~1,4× en 4K SDR** (mesuré).
9. Voie écartée : reconvertir nous-mêmes dans le canevas sous Chrome/Windows. Les images HEVC
   matérielles sont opaques (`format: null`) et WebGL ne rend les codes PQ bruts qu'en 8 bits.
10. **Recommandation** : (1) confirmer le mécanisme par un balayage du plafond (650 → 203 → 150 →
    100) et par `chrome://gpu` ; (2) si c'est confirmé, livrer le plafond à ~150 nits, toujours
    limité à `dynamic-range: high` = faux ; (3) garder le SDR serveur comme repli par titre, et
    l'AGTM (ST 2094-50) comme piste future.

---

## 2. Ce qui a été observé et mesuré

### 2.1 Constats sur le portable (écran SDR, `dynamic-range: high` faux, `color-gamut: p3` faux)

| Titre | Type | MaxCLL | Chrome | Firefox | Safari iPhone (écran HDR) |
|---|---|---|---|---|---|
| Ted Lasso S01E03 | DV P8 + HDR10+ | 1641 | trop sombre | clair | juste |
| 1917 | HDR10+ | 1000 | trop sombre | clair | juste |
| Ballerina | DV P8 + HDR10+ | 1000 | trop sombre | clair | juste |
| 2012 | HDR10 (SEI seulement) | 4451 | très sombre | clair | juste |
| Apocalypse Now | HDR10 (DV P8 selon Jellyfin) | 4136 | très sombre | clair | juste |
| American Psycho | HDR10 | 1000 | un peu moins sombre | clair | juste |
| Dirty Dancing | DV P8 + HDR10 | 657 | **juste** | clair | juste |

Essais sans effet dans Chrome : retrait des SEI HDR10+, boîtes `colr`/`mdcv`/`clli` dans
l'en-tête MP4, plafond à 650 nits de MaxCLL/MaxFALL/luminance de mastering (SEI 137/144 réécrites
et boîtes). Le journal `player.log` confirme que Chrome et Firefox passent tous deux par le chemin
**remux → `<video>` natif** (`path: "remux"`), et que Chrome 152 a bien reçu `hdrLightCap: 650`.

### 2.2 Luminance d'étalonnage des films (mesurée sur le serveur)

Seize images réparties dans chaque film, décodées par le ffmpeg de Jellyfin, `signalstats` en
10 bits. Il s'agit de la médiane, sur les seize images, de la valeur de code Y moyenne (YAVG) et
du 90ᵉ centile (YHIGH), convertis en nits PQ à titre indicatif. Une moyenne de codes n'est pas une
moyenne de lumière, mais l'ordre de grandeur est parlant.

| Film | YAVG médian (code 10 bits) | ≈ nits | YHIGH médian | ≈ nits |
|---|---|---|---|---|
| Dirty Dancing | 288 | ~5,6 | 418 | ~34 |
| 2012 | 199 | ~1,1 | 319 | ~9 |
| American Psycho | 225 | ~1,9 | 358 | ~16 |
| Apocalypse Now | 214 | ~1,5 | 416 | ~33 |

*Dirty Dancing* est étalonné un bon diaphragme au-dessus des autres. Dans tous les films, **90 %
des pixels restent sous ~35 nits**, donc bien sous le blanc de référence : c'est la zone où Chrome
applique son facteur fixe (§3.1), et où les métadonnées n'ont aucun effet.

### 2.3 Le serveur

`/System/Configuration/encoding`, lu par l'API : `HardwareAccelerationType: "qsv"`,
`EnableTonemapping: true` (OpenCL), `EnableVppTonemapping: false`, `TonemappingAlgorithm: "bt2390"`,
`TonemappingMode/Range: "auto"`, `TonemappingPeak: 100`, `TonemappingDesat: 0`, décodage HEVC
10 bits et encodage HEVC matériels actifs. Matériel : i7-8700, **UHD 630** (VA-API : HEVC Main10 en
décodage et en encodage ; OpenCL : « Intel(R) UHD Graphics 630 » visible dans le conteneur Jellyfin).

Mesure de débit (40 s puis 30 s de *2012* en 4K HDR10, tone mapping OpenCL `bt2390`, peak 100) :

| Sortie | Vitesse | Remarque |
|---|---|---|
| 1080p SDR H.264 (VA-API, 10 Mb/s) | **6,9× temps réel** (166 i/s) | CPU hôte quasi au repos |
| 2160p SDR HEVC (VA-API, 25 Mb/s) | **1,38× temps réel** (33 i/s) | Une seule lecture 4K SDR simultanée tient, pas deux |

---

## 3. Mécanismes, navigateur par navigateur

### 3.1 Chrome sous Windows

**Qui convertit ?** Chrome a deux chemins possibles pour une vidéo :

- **Plan matériel (MPO / DirectComposition)** : le `VideoProcessorBlt` de D3D11 convertit et le
  **pilote** fait le tone mapping, avec les métadonnées passées par
  `VideoProcessorSetStreamHDRMetaData` (`ui/gl/swap_chain_presenter.cc`).
- **Composition par Viz/Skia** : la vidéo est dessinée comme une texture et Skia applique un filtre
  de tone mapping (`components/viz/service/display/skia_renderer.cc`, `needs_tone_map` quand
  `is_video_frame && IsHDR()`).

Pour une vidéo HDR non protégée, sur une machine dont **un écran au moins n'a pas le HDR activé**,
Viz refuse le plan matériel (`DC_LAYER_FAILED_YUV_VIDEO_QUAD_HDR_TONE_MAPPING`,
`dc_layer_overlay.cc`). Le commentaire le dit sans détour : *« in case of very bad tone-mapping
result by video processor on non-HDR-enabled display, we tend to be strict about the overlay
promotion and always let Viz do HDR tone mapping »*. **Sur l'écran SDR du portable, c'est donc
Chrome qui convertit, jamais le pilote.** Cela explique aussi pourquoi le réglage Windows
« Diffuser des vidéos HDR » ne change rien : il ne concerne que le pipeline du système.

**Quel opérateur ?** `cc::ToneMapUtil::AddGlobalToneMapFilterToPaint` délègue à Skia
(`src/codec/SkHdrAgtm.cpp`). En l'absence de métadonnée AGTM dans le flux, Skia construit **RWTMO**
(*Reference White Tone Mapping Operator*, ST 2094-50 annexe C) :

- lumière maximale du contenu = **MaxCLL**, sinon luminance max de mastering, sinon **1000 nits**
  (`get_max_luminance`) ;
- blanc de référence `W` : 203 nits par défaut, **mais sous Windows**
  `kUseDisplaySDRMaxLuminanceNits` (activée par défaut sous Windows, désactivée ailleurs) le
  remplace par le niveau de blanc SDR de l'écran (`SetNDWL(GetSDRMaxLuminanceNits())`). Windows le
  renvoie via `DISPLAYCONFIG_SDR_WHITE_LEVEL`, en multiples de 80 nits. Sur un écran SDR, la valeur
  attendue est 1000, soit **80 nits** (200 si l'appel échoue) ;
- marge de référence `H = log2(max(Lmax / W, 1))` ;
- sur un écran SDR (marge cible 0), l'image du blanc de référence vaut
  **`yWhite = 1 − 0,5 · min(H / log2(1000/203), 1)`**, et tout ce qui est sous `W` est multiplié
  par `yWhite`. Au-dessus, une courbe de Bézier va de `(1, yWhite)` à `(2^H, 1)`, appliquée sur
  max(R,G,B).

Conséquences, en supposant `W` = 80 nits :

| Lmax annoncé | `yWhite` | Effet sur les tons moyens |
|---|---|---|
| ≥ 394 nits (657, 1000, 4451…) | **0,50** | −1 diaphragme, identique pour tous |
| 203 | 0,71 | −0,5 diaphragme |
| 150 | 0,80 | ≈ repère « 100 nits = blanc » |
| 120 | 0,87 | |
| 100 | 0,93 | ≈ « 80 nits = blanc », écrêtage presque immédiat |

Simulation de la sortie (valeur sRGB sur 255, affichage idéal, sans le passage BT.2020→709) :

| Pixel PQ (nits) | Lmax 4451 | Lmax 650 | Cap 203 | Cap 150 | Cap 100 | « nits/100 » (≈ Safari sans marge) |
|---|---|---|---|---|---|---|
| 5 | 49 | 49 | 59 | 63 | 68 | 63 |
| 20 | 99 | 99 | 117 | 124 | 132 | 124 |
| 50 | 152 | 152 | 178 | 188 | 201 | 188 |
| 80 | 188 | 188 | 219 | 231 | 247 | 231 |
| 200 | 203 | 223 | 255 | 255 | 255 | 255 |
| 400 | 212 | 243 | 255 | 255 | 255 | 255 |
| 1000 | 226 | 255 | 255 | 255 | 255 | 255 |

Ce tableau explique chacun des constats :

- **Trop sombre** : les tons moyens sont à 0,5× dès que Lmax dépasse ~394 nits.
- **« 4000 nits plus sombre que 1000 »** : seules les zones au-dessus de 80 nits (ciels, peaux
  éclairées, lampes) diffèrent, et elles sont plus comprimées quand Lmax est grand.
- **Plafond à 650 sans effet visible** : 4451 et 650 donnent exactement la même chose sous 80 nits,
  là où vivent 90 % des pixels.
- **HDR10+ sans effet** : `h265_decoder.cc` ne transforme en métadonnée que les SEI T.35 du préfixe
  `B5 0090 0001` (SMPTE, ST 2094-50 / AGTM, `media/base/agtm.cc`). Le HDR10+ (`B5 003C 0001`) est
  ignoré.

**D'où viennent les métadonnées ?** `D3DVideoDecoder` préfère celles du flux (SEI 137/144,
conservées d'une image à l'autre) et retombe sur la configuration, c'est-à-dire les boîtes
`mdcv`/`clli` du MP4, qui écrasent ce que contient le `hvcC` (`box_definitions.cc`). Nos boîtes et
nos SEI réécrites parviennent donc bien à Chrome. Elles ne pouvaient simplement pas changer ce qui
compte ici.

**Bogues connus** : [40259188](https://issues.chromium.org/issues/40259188) « HDR(PQ) Video → SDR
tone mapping result is too dark » (Windows, ouvert en 2023) ;
[40266959](https://issues.chromium.org/issues/40266959) « Tonemap independently of SDR white
level » ; [40285630](https://issues.chromium.org/issues/40285630) (écarts de luminosité entre
composition et plan matériel, raison d'être de `UseDisplaySDRMaxLuminanceNits`) ;
[486121442](https://issues.chromium.org/issues/486121442) « HDR videos ignore brightness setting ».
Aucun drapeau utilisateur documenté ne règle l'exposition du tone mapping.

**Drapeaux, en théorie** :

- `--disable-features=UseDisplaySDRMaxLuminanceNits` remet `W` à 203 nits, donc 80 nits → ~0,2.
  C'est **plus sombre**.
- `chrome://flags/#force-color-profile` (HDR10 / scRGB) fait croire à une marge HDR et éclaircit les
  tons moyens, mais produit des couleurs fausses sur un écran SDR. Ce n'est pas une solution, au
  mieux un moyen de diagnostic.
- La propriété CSS `dynamic-range-limit` ne joue que sur la marge HDR, qui vaut déjà 0 sur un écran
  SDR : aucun effet.

### 3.2 Firefox sous Windows

D'après le document d'architecture « HDR Video Playback on Windows » maintenu côté Mozilla
(avril 2026) :

- décodage WMF/DXVA en P010 pour le HDR ;
- sur le chemin plan matériel, le **VideoProcessor D3D11** convertit PQ → sortie et **le pilote
  fait le tone mapping à l'aveugle** : *« VP blit missing display + stream HDR metadata; driver
  tone-maps blind »* (bogues 1793908, 2027623) ;
- sur le chemin WebRender (décodage logiciel), le shader applique la matrice BT.2020 mais **aucune
  EOTF PQ**, seulement un gamma de type BT.1886 : on obtient une image plate et délavée.

Firefox n'a donc **aucun tone mapping à lui**. Le rendu « clair, presque trop, mais agréable »
correspond le mieux au tone mapping HDR→SDR d'un pilote (Intel/AMD/NVIDIA). Ces conversions du
VideoProcessor placent en général ~100 nits au blanc et écrêtent au-dessus, soit une exposition
proche de la colonne « nits/100 » du tableau ci-dessus. Le rendu PQ-affiché-en-gamma serait plutôt
grisâtre et peu contrasté. **Ce point reste une hypothèse** tant que le chemin réellement pris sur
le portable n'est pas lu (voir le plan de test, étape 5). Conséquence pratique : le rendu Firefox
dépend du pilote, et un autre PC Windows peut ne pas lui ressembler.

### 3.3 Safari / AVFoundation (iPhone, écran HDR)

Avec l'EDR d'Apple, pour du PQ, **100 nits = 1,0 = blanc de référence de l'écran**, qui suit le
réglage de luminosité. Tout ce qui dépasse va dans la marge disponible (`currentEDRHeadroom`), et le
tone mapper de la couche (utilisé par AVPlayer) n'applique qu'une compression douce près du
maximum. Les tons moyens sont exposés « 100 nits = blanc » (plus clairs que Chrome), et les hautes
lumières sont montrées au lieu d'être écrêtées (plus fidèles que Firefox) : c'est le « juste
milieu » observé. Sur un écran SDR, Safari ramènerait les hautes lumières vers 1,0, mais le
portable est sous Windows et la question ne se pose pas.

---

## 4. Ce que font les plateformes

| Plateforme | Client HDR sur écran SDR | Comment le client est jugé |
|---|---|---|
| **jellyfin-web** | `supportsHdr10()` renvoie **vrai pour tout Chrome de bureau** (« client side tone-mapping »), et Edge ≥ 121. Firefox n'est HDR que sous macOS. Chrome/Windows reçoit donc le HDR en lecture directe, **avec exactement la même obscurité**. Firefox/Windows reçoit un transcodage tone-mappé par le serveur. | Liste d'agents utilisateurs, aucune question à l'écran. Le profil déclare `VideoRangeType` par codec (`SDR|HDR10|HDR10Plus|DOVIWith…`). |
| **Serveur Jellyfin** | Si le profil n'accepte pas la plage du fichier, transcodage avec tone mapping : OpenCL/CUDA (`bt2390`, `hable`, `reinhard`…, `peak`, `desat`, `mode`), VPP Intel (table matérielle, peu réglable), VideoToolbox. Ici : QSV + OpenCL `bt2390`, peak 100. | Le `DeviceProfile` du client (`CodecProfiles` → `VideoRangeType`). |
| **Plex** | Tone mapping côté serveur quand le client ne sait pas lire le HDR. Dans le navigateur, en qualité « Maximum », **pas de tone mapping** : le HDR part tel quel et le rendu dépend du navigateur. | Profils de clients côté serveur. |
| **YouTube** | Chaque vidéo HDR reçoit aussi une conversion SDR produite par YouTube. Un écran non HDR reçoit la version SDR (le libellé « HDR » disparaît du menu qualité). | Côté navigateur : l'écran (`dynamic-range: high`) plus les capacités de décodage. |
| **Netflix (PC)** | HDR seulement dans Edge ou l'application, sur un écran HDR avec HDR activé (PlayReady). Ailleurs : **flux SDR** étalonné. | DRM et capacités du système. |
| **MediaCapabilities** | Chrome répond **vrai** à `decodingInfo` pour HDR10 même sur un écran SDR, puisqu'il sait tone-mapper. | Ce n'est donc pas une information sur l'écran. |

Ce qu'on en retient : les services qui soignent le rendu sur SDR (YouTube, Netflix) **servent une
version SDR**, et ne comptent pas sur le tone mapping du navigateur. Jellyfin et Plex dans Chrome
laissent faire le navigateur et héritent de son obscurité.

---

## 5. Options

Le signal fiable dont on dispose est `matchMedia('(dynamic-range: high)')`, la question standard
« cet écran affiche-t-il le HDR maintenant ? ». Il est déjà lu (`hdrDisplay.ts`), écrit dans
`player.log` et affiché dans le panneau des capacités. Ce n'est pas une pseudo-détection. Le test
d'agent utilisateur « Chromium sous Windows » décrit un **défaut d'implémentation** (le blanc de
référence propre à Windows, §3.1), au même titre que `isWebKitEngine`.

| # | Option | Fidélité | Coût | Risque | Verdict |
|---|---|---|---|---|---|
| a | **Ne rien faire** | Tons moyens à −1 diaphragme dans Chrome/Windows/SDR. Jellyfin et Plex font pareil. | 0 | 0 | Acceptable seulement si le plafond (b′) échoue |
| b′ | **Plafond abaissé à ~150 nits** (code existant, `SDR_LIGHT_CAP_NITS`), seulement si Chromium/Windows **et** `dynamic-range: high` faux | Tons moyens ≈ repère Safari. Compression douce de 80 à 150 nits, **hautes lumières écrêtées** au-delà (comme Firefox). | Une ligne, déjà testée et journalisée | Faible. Dépend de `W` = 80 : si Windows déclare un autre blanc, l'exposition change (d'où l'étape 1 du plan). Un fichier sans aucune métadonnée retombe sur 1000 nits : il faut **toujours écrire `clli`** quand le plafond s'applique. | **Recommandée d'abord** |
| b | **SDR tone-mappé par Jellyfin** quand l'écran n'est pas HDR : profil `VideoRangeType` réduit à `SDR|DOVIWithSDR` → lecteur serveur (HLS) | Bonne, contrôlée côté serveur (`bt2390`, peak/desat réglables, identique pour tous les navigateurs SDR). DV P8 lu par sa couche HDR10. | Ré-encodage : 1080p ≈ 7× temps réel, 4K ≈ 1,4× sur l'UHD 630 (une seule 4K à la fois). Perte du lecteur natif (pistes par piste, reprises rapides, `changeAudio`…), démarrage et saut plus lents. | Moyen. Charge serveur si plusieurs spectateurs SDR, qualité d'encodage, second chemin de lecture pour les mêmes films. | Repli **par titre** ou **au choix de l'utilisateur**, pas par défaut |
| b″ | Hybride : vidéo SDR du serveur + audio remuxé par nous | Celle de b | Élevé : synchroniser deux sources, ou demander à Jellyfin un transcodage vidéo seul avec audio en copie (possible avec `TranscodingProfile`, mais on reste dans son HLS) | Élevé | Non, pour l'instant |
| c | **Tone mapping maison sur le canevas** (WebCodecs + WebGL) sous Chrome/Windows | Potentiellement la meilleure (notre courbe) | Élevé : chemin canevas (horloge audio à la main, cadence, batterie) | Élevé. Les images HEVC matérielles sont **opaques** (`format: null`, déjà vu dans le journal), donc pas de `copyTo`. `texImage2D` avec `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` réinterprète l'image en sRGB et donne les **codes PQ bruts, mais en 8 bits** (instantané N32, `video_frame_image_util.cc`), d'où des aplats dans les ombres. WebGPU `importExternalTexture` ne propose que `srgb`/`display-p3`, donc une conversion par Chrome. Pas de décodeur HEVC logiciel dans Chrome. | Non |
| d | **Réglages Chrome côté utilisateur** | — | — | Aucun drapeau n'expose l'exposition. `force-color-profile` fausse les couleurs. | Non (diagnostic seulement) |
| e1 | **Métadonnée AGTM (SMPTE ST 2094-50)** injectée en SEI T.35 `B5 0090 0001` | Excellente : on dicte la courbe, qui s'adapte à la marge de l'écran (identité sur écran HDR, notre courbe sur SDR). Ignorée par Safari et Firefox. | Moyen : sérialiser la syntaxe AGTM (Skia `SkHdrAgtmParse.cpp`) | Moyen-élevé : norme jeune, syntaxe déjà changée dans Chrome (`HdrAgtmParseOldSyntax`), pas de retour d'expérience | Piste future, à surveiller |
| e2 | Déclarer le flux SDR (`colr` BT.709) | Mauvaise : PQ affiché en gamma, image grise et délavée | — | — | Non |
| e3 | HLG | Ré-encodage complet, et Chrome refuse le plan matériel pour le HLG | Élevé | — | Non |

---

## 6. Recommandation

1. **Confirmer le mécanisme** (ci-dessous, étapes 1 à 3). Tout repose sur le fait que `W` = 80 nits
   sous Windows et que le facteur 0,5 ne dépend pas des métadonnées au-dessus de 394 nits. Le
   balayage du plafond le prouve ou le réfute en quelques minutes, sans rien changer d'autre.
2. **Si c'est confirmé : abaisser `SDR_LIGHT_CAP_NITS` à ~150** (à régler à l'œil entre 120 et 203
   sur les films sombres, *2012* en tête), en gardant la double condition Chromium/Windows **et**
   `dynamic-range: high` = faux, et en écrivant toujours `clli`/`mdcv` quand le plafond s'applique
   (un fichier sans aucune métadonnée retomberait sinon sur 1000 nits). Mettre à jour le
   commentaire de `hdrDisplay.ts` : ce n'est pas « la lumière maximale ramenée sous la lumière
   annoncée », c'est « l'exposition RWTMO sous un blanc de référence de 80 nits ». C'est une
   correction fondée sur le mécanisme, bon marché, sans nouveau chemin de lecture.
3. **Ne pas faire du SDR serveur le défaut.** L'offrir plus tard en repli explicite (menu, ou par
   titre si un film reste mauvais), puisque le serveur en a la capacité en 1080p.
4. **Surveiller l'AGTM** (ST 2094-50) : c'est la manière standard de dire à Chrome quelle courbe
   appliquer, sans tricher sur MaxCLL. À reconsidérer quand la syntaxe sera figée et reconnue par
   d'autres navigateurs.

Limite assumée du plafond : au-dessus d'environ 150 nits, les hautes lumières sont écrêtées sur
Chrome/Windows/SDR (ciels, fenêtres, lampes). C'est déjà ce que fait Firefox sur ce portable, et
c'est ce que le spectateur a jugé fidèle.

---

## 7. Plan de test (sur le portable concerné)

1. **`chrome://gpu`**, section *Display(s)* et *Display color spaces* : relever le niveau de blanc
   SDR / `sdr_max_luminance_nits` (80 attendu). Noter aussi *Video Acceleration Information* (HEVC
   Main10 en décodage matériel) et *Hardware overlays* / *Direct Composition*.
2. **`chrome://media-internals`** pendant la lecture de *2012* : `kVideoDecoderName`
   (`D3DVideoDecoder` / `D3D11VideoDecoder` attendu), `kIsPlatformVideoDecoder`, et dans la config
   vidéo la colorimétrie (`BT2020/PQ`) et les `hdr_metadata` (MaxCLL reçu). Vérifier que la valeur
   plafonnée y apparaît.
3. **Balayage du plafond** (dev, `SDR_LIGHT_CAP_NITS` = 650 → 203 → 150 → 100), même scène de
   *2012* et d'*American Psycho*, capture d'écran à chaque fois. Prédiction du modèle : **650 ≡
   aucun plafond** ; 203 nettement plus clair (+0,5 diaphragme) ; 150 proche de Firefox et
   Safari ; 100 « 80 nits = blanc » et des hautes lumières écrêtées tôt. Si 203 et 150 ne changent
   rien non plus, la métadonnée n'atteint pas le compositeur et l'étape 2 dit où elle se perd.
4. **Contrôle croisé du blanc Windows** : sur un écran externe HDR, HDR Windows activé, déplacer le
   curseur « luminosité du contenu SDR » et vérifier que l'exposition des tons moyens dans Chrome
   suit (c'est l'effet de `UseDisplaySDRMaxLuminanceNits`). Facultatif.
5. **Firefox** : `about:support` → *Graphics* (compositing, *HW overlays*, décodage matériel HEVC)
   et `about:config` → `gfx.color_management.hdr_video`, `gfx.webrender.dcomp.video.yuv-overlay-win`.
   Mettre temporairement `media.hardware-video-decoding.enabled` ou l'overlay YUV à `false` : si
   l'image devient grise et plate, le rendu « clair » venait bien du VideoProcessor du pilote.
6. **Référence serveur** : lire *2012* dans le lecteur serveur en forçant un profil SDR (profil
   `VideoRangeType: SDR`), puis comparer à l'œil avec Chrome plafonné à 150 et avec Firefox.
7. Consigner les résultats dans `player.log` (les lignes `start` portent déjà `displayHdr` et
   `hdrLightCap`).

---

## 8. Ce que le dépôt contient déjà

- `src/lib/webcodecs/hdrDisplay.ts` : `displayIsHdr()` (requête média standard),
  `isChromiumOnWindows()`, `hdrLightCap()` → `SDR_LIGHT_CAP_NITS = 650`. **La seule constante à
  changer pour l'essai.**
- `src/lib/webcodecs/codecConfig.ts` : `withCappedLightLevels()` / `cappedSei()` réécrivent les SEI
  137/144. `remuxer.ts` / `remuxPlayback.ts` écrivent `clli`/`mdcv` plafonnés.
- `src/lib/webcodecs/capabilities.ts` : ligne « Écran HDR (dynamic-range: high) » dans le panneau.
- `src/lib/webcodecs/renderer.ts` / `hdrMath.ts` : tone mapping du chemin canevas (PQ → linéaire,
  Reinhard étendu sur la luminance, `peakNits`, BT.2020→709, sRGB) avec relecture `copyTo`.
  Inutilisable sur les images HEVC opaques de Chrome/Windows, d'où `PunchRenderer`, qui ne rattrape
  qu'une image déjà aplatie.
- `src/lib/deviceProfile.ts` : `SAFE_VIDEO_RANGES = "SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|
  DOVIWithHDR10Plus|DOVIWithSDR"`, déclarée partout. L'option b consisterait à la réduire à
  `SDR|DOVIWithSDR` quand `displayIsHdr() === false`. Le commentaire du fichier rappelle que, sans
  condition du tout, Jellyfin tone-mappe et ré-encode tout.
- `canvasHdrRefusal` (`/api/jellyfin/direct/[itemId]`) est aujourd'hui toujours `null`, mais le
  branchement vers `fallToStable` existe déjà dans `ExperimentalPlayerHost.tsx` : c'est le point
  d'accroche naturel d'un repli SDR serveur par titre.

---

## 9. Sources

Chromium / Skia (code, branche `main`) :

- `components/viz/service/display/dc_layer_overlay.cc` (refus du plan matériel pour le HDR sur écran SDR) — https://github.com/chromium/chromium/blob/main/components/viz/service/display/dc_layer_overlay.cc
- `components/viz/service/display/skia_renderer.cc` (`needs_tone_map`, NDWL) — https://github.com/chromium/chromium/blob/main/components/viz/service/display/skia_renderer.cc
- `components/viz/common/features.cc` (`kUseDisplaySDRMaxLuminanceNits`, activée sous Windows) — https://github.com/chromium/chromium/blob/main/components/viz/common/features.cc
- `ui/display/win/screen_win.cc` (`GetSDRWhiteLevel`, `SDRWhiteLevel * 80 / 1000`, 200 par défaut) — https://github.com/chromium/chromium/blob/main/ui/display/win/screen_win.cc
- `ui/gfx/hdr_metadata.cc` (`GetContentMaxLuminance`, `PopulateUnspecifiedWithDefaults` 1000 nits) — https://github.com/chromium/chromium/blob/main/ui/gfx/hdr_metadata.cc
- `ui/gfx/switches.cc` (`kHdrAgtm` activée) — https://github.com/chromium/chromium/blob/main/ui/gfx/switches.cc
- `ui/gl/swap_chain_presenter.cc` (chemin VideoProcessor, métadonnées du flux) — https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/gl/swap_chain_presenter.cc
- `media/gpu/h265_decoder.cc`, `media/gpu/windows/d3d_video_decoder.cc` (SEI → métadonnées, priorité au flux) — https://github.com/chromium/chromium/blob/main/media/gpu/h265_decoder.cc
- `media/base/agtm.cc` (préfixe T.35 `B5 0090 0001` = ST 2094-50) — https://github.com/chromium/chromium/blob/main/media/base/agtm.cc
- `media/formats/mp4/box_definitions.cc` (`mdcv`, `clli`, `SmDm`, `CoLL`) — https://github.com/chromium/chromium/blob/main/media/formats/mp4/box_definitions.cc
- `third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc` et `platform/graphics/video_frame_image_util.cc` (`kReinterpretAsSRGB`, instantané N32) — https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/graphics/video_frame_image_util.cc
- Skia `src/codec/SkHdrAgtm.cpp` (`PopulateUsingRwtmo`, `get_max_luminance`, `PopulateToneMapAgtmParams`) et `include/private/SkHdrMetadata.h` (`kDefaultHdrReferenceWhite = 203`) — https://github.com/google/skia/blob/main/src/codec/SkHdrAgtm.cpp

Bogues Chromium :

- https://issues.chromium.org/issues/40259188 — HDR(PQ) Video → SDR tone mapping result is too dark
- https://issues.chromium.org/issues/40266959 — HDR/windows: Tonemap independently of SDR white level
- https://issues.chromium.org/issues/40285630 — HDR10 overlay issues: brightness shifts
- https://issues.chromium.org/issues/486121442 — HDR videos ignore brightness setting
- https://issues.chromium.org/issues/40184904 — PQ HDR images have incorrect tone-mapping on SDR

Firefox :

- HDR Video Playback on Windows — Architecture and Status (document de travail Mozilla, avril 2026) — https://gist.github.com/alastor0325/fe76114f484e21c4bd7c2f496fd83612

Apple :

- Explore HDR rendering with EDR (WWDC21) — https://developer.apple.com/videos/play/wwdc2021/10161/
- Explore EDR on iOS (WWDC22) — https://developer.apple.com/videos/play/wwdc2022/10113/
- Rendering HDR Video with AVFoundation and Metal — https://metalbyexample.com/hdr-video/

Normes et API :

- SMPTE ST 2094-50 (dépôt de travail) — https://github.com/SMPTE/st2094-50
- DISPLAYCONFIG_SDR_WHITE_LEVEL — https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-displayconfig_sdr_white_level
- Advanced Color / HDR sous DirectX — https://learn.microsoft.com/en-us/windows/win32/direct3darticles/high-dynamic-range
- MediaCapabilities et HDR (Intent to Ship) — https://groups.google.com/a/chromium.org/g/blink-dev/c/0neM-5GDn8I

Plateformes :

- jellyfin-web `browserDeviceProfile.js` (`supportsHdr10`, `VideoRangeType`) — https://github.com/jellyfin/jellyfin-web/blob/master/src/scripts/browserDeviceProfile.js
- Jellyfin, accélération matérielle Intel (tone mapping OpenCL / VPP) — https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/intel/
- Plex, HDR to SDR Tone Mapping — https://support.plex.tv/articles/hdr-to-sdr-tone-mapping/
- YouTube, Upload HDR videos (conversion SDR) — https://support.google.com/youtube/answer/7126552
- Netflix sous Windows — https://help.netflix.com/en/node/23931
