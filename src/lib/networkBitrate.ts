/**
 * Le plafond envoyé à Jellyfin comme `MaxStreamingBitrate`, déduit du réseau et non de l'écran.
 *
 * Cette valeur décide de **deux** choses, et c'est ce qui la rend piégeuse : elle borne la sortie
 * d'un éventuel transcodage, mais elle décide *d'abord* si la source est éligible au
 * DirectPlay/DirectStream. Un plafond trop bas ne réduit donc pas la charge, il la crée : le
 * fichier est refusé tel quel et part en ré-encodage HEVC, sur un serveur sans GPU — exactement
 * ce que ce projet existe pour éviter.
 *
 * Les anciens paliers (4/8/15 Mbps par taille de fenêtre) venaient du modèle « on transcode
 * toujours », où un plafond bas allégeait le ré-encodage. Relevés une première fois, il restait
 * le palier mobile à 20 Mbps — à l'intérieur de l'intervalle qu'un remux Blu-ray FHD HEVC occupe
 * couramment (15-25+ Mbps).
 *
 * Mais le vrai défaut n'était pas la valeur, c'était la question posée : la largeur de l'écran ne
 * dit rien du réseau. Un téléphone sur le wifi du salon et le même téléphone en 4G donnent la
 * même largeur physique et recevaient le même plafond ; le premier était bridé pour rien, le
 * second l'était sur une coïncidence. On demande donc au réseau lui-même — sa classe annoncée,
 * jamais son estimation chiffrée (voir `pickMaxBitrate`).
 *
 * Pas de renégociation en cours de lecture pour la résolution (compromis accepté).
 */

/** Ce que `navigator.connection` expose, non typé par lib.dom (`downlink` n'est pas lu : voir plus bas). */
interface NetworkInformationLike {
  effectiveType?: string;
}

/**
 * « Le plafond ne décide de rien. »
 *
 * Le fichier le plus lourd de la bibliothèque mesure 38,4 Mbps (relevé sur les 499 sources via
 * `/Items?Fields=MediaSources` : médiane 6,4 · p90 17,6 · p95 23,2 · max 38,4). Au-delà, aucun
 * fichier existant ne peut plus être refusé sur le débit, et c'est la compatibilité codec /
 * conteneur qui tranche — la seule question que Jellyfin doit avoir à trancher ici. La marge
 * au-dessus de 38,4 est là pour le prochain remux 4K qui entrera dans la bibliothèque.
 */
const UNCONSTRAINED = 100_000_000;

/**
 * Les deux seuils bas, pris sur la bibliothèque réelle et pas sur des chiffres ronds.
 *
 * `THREE_G` est la médiane de la bibliothèque : sur un lien de cette classe, la moitié des films
 * passe intacte et l'autre moitié est contrainte — le partage que le réseau impose de toute
 * façon. `CRAWL` est en dessous de tout ce que la bibliothèque contient : sur 2G rien ne passera
 * tel quel, et le seul service qu'on puisse rendre est un flux que le lien peut porter.
 */
const THREE_G = 6_400_000;
export const CRAWL = 1_500_000;

/**
 * **`downlink` n'est jamais lu comme une mesure** (15/10/2026, LECTEUR-10).
 *
 * Jusque-là, toute valeur sous 10 (Chrome la plafonne à 10 pour ne pas en faire une empreinte)
 * faisait un plafond de 0,75 × `downlink`, plancher 1,5 Mb/s. Relevé sur la prod : 22 % des
 * séances Chrome / Edge / Android annoncent un `downlink` sous 10 — 1,45, 1,55, 4,8… — pendant que
 * le lecteur natif du même onglet mesure le lien à 15–110 Mb/s (`diag.linkMbps`). L'estimateur de
 * Chrome part d'une valeur par défaut, n'apprend rien des hôtes proches, et ne voit que le trafic
 * récent de l'onglet. Le lire comme une mesure, c'était exactement le défaut décrit plus haut : un
 * film de 2,5 Mb/s ré-encodé en 720p à 1,5 Mb/s (« Le Grinch », Chrome, la nuit du 14/10), sur un
 * lien qui en portait cent fois plus — la charge créée par le plafond lui-même.
 *
 * Seule la **classe** annoncée (`effectiveType`) reste : elle ne descend sous « 4g » que sur un lien
 * réellement mauvais (RTT et débit observés sur plusieurs requêtes), et un spectateur sur un tel lien
 * ne perd rien à recevoir un flux qu'il peut porter. La vraie mesure du lien, c'est celle de l'app
 * (§77/§78 : `LinkMeter`, préchauffage et bascule sur blocage réel), pas celle du navigateur.
 */

/**
 * Le plafond à envoyer, d'après la classe de lien que le navigateur annonce.
 *
 * **Le repli est la valeur haute, délibérément.** `navigator.connection` n'existe pas sur Safari
 * — donc sur tous les iPhone et iPad du foyer — et l'absence d'information n'est pas une
 * information de lenteur. Entre les deux erreurs possibles, on choisit celle qui se répare toute
 * seule : un tampon qui se remplit lentement est un démarrage plus long (et, s'il bloque vraiment,
 * la bascule de §78), un ré-encodage inutile est une charge sur une machine qui n'en a pas à donner,
 * pour tout le monde à la fois.
 */
export function pickMaxBitrate(): number {
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!conn) return UNCONSTRAINED;
  const { effectiveType } = conn;
  if (effectiveType === "slow-2g" || effectiveType === "2g") return CRAWL;
  // « 4g », rien du tout ou une valeur inconnue : pas de raison de brider.
  return effectiveType === "3g" ? THREE_G : UNCONSTRAINED;
}
