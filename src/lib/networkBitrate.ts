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
 * second l'était sur une coïncidence. On demande donc au réseau lui-même.
 *
 * Pas de renégociation en cours de lecture pour la résolution (compromis accepté).
 */

/** Ce que `navigator.connection` expose, non typé par lib.dom. */
interface NetworkInformationLike {
  effectiveType?: string;
  downlink?: number;
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
const CRAWL = 1_500_000;

/**
 * `downlink` sature à 10 Mbps.
 *
 * Chrome arrondit l'estimation à 25 kbit/s près **et la plafonne à 10**, pour ne pas transformer
 * l'API en empreinte. Donc 10 ne veut pas dire « dix », il veut dire « au moins dix, on ne dira
 * pas combien » : le lire comme une mesure ferait brider un wifi gigabit à 7,5 Mbps et partir en
 * ré-encodage 38 % de la bibliothèque — le défaut qu'on corrige, en pire. Seule une valeur
 * *sous* le plafond est une vraie mesure.
 */
const DOWNLINK_SATURATION_MBPS = 10;

/**
 * La part du débit annoncé qu'on accepte de réserver au film.
 *
 * `downlink` est une estimation du débit observé récemment, pas une garantie ; il faut de la
 * place pour les en-têtes, la variabilité, et le fait qu'un tampon qui se remplit tout juste au
 * rythme de la lecture ne se remplit jamais.
 */
const USABLE_SHARE = 0.75;

/**
 * Le plafond à envoyer, d'après ce que le navigateur dit du lien.
 *
 * **Le repli est la valeur haute, délibérément.** `navigator.connection` n'existe pas sur Safari
 * — donc sur tous les iPhone et iPad du foyer — et l'absence d'information n'est pas une
 * information de lenteur. Entre les deux erreurs possibles, on choisit celle qui se répare toute
 * seule : un tampon qui se remplit lentement est un démarrage plus long, un ré-encodage inutile
 * est une charge CPU sur une machine qui n'en a pas à donner, pour tout le monde à la fois.
 */
export function pickMaxBitrate(): number {
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!conn) return UNCONSTRAINED;

  const { effectiveType, downlink } = conn;
  if (effectiveType === "slow-2g" || effectiveType === "2g") return CRAWL;

  // Pas de mesure exploitable : on retombe sur la classe annoncée, et « 4g » ou rien du tout
  // veut dire « pas de raison de brider ».
  if (typeof downlink !== "number" || !Number.isFinite(downlink) || downlink >= DOWNLINK_SATURATION_MBPS) {
    return effectiveType === "3g" ? THREE_G : UNCONSTRAINED;
  }

  const usable = Math.round(downlink * USABLE_SHARE * 1_000_000);
  // En dessous de `CRAWL`, un plafond ne sert plus qu'à rendre la lecture impossible proprement.
  return Math.max(usable, CRAWL);
}
