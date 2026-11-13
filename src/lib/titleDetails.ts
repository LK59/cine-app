import { prettyCodec } from "@/lib/fileTracks";
import { chooseAudioTrack, type TrackPreferences } from "@/lib/trackPreferences";

/**
 * La fenêtre « Détails » d'un film (DECISIONS.md §152, 13/11/2026) : ce qui se dit de l'image d'un
 * fichier, en mots que tout le monde lit. Des fonctions pures, partagées par la route qui décrit le
 * fichier (`/api/jellyfin/streams/[itemId]`) et la fenêtre qui l'affiche (`TitleDetailsSheet`).
 *
 * L'image peut s'annoncer telle que le fichier la porte : elle traverse les deux chemins de lecture
 * **copiée** (voir `videoQuality.ts`), donc « 4K » et « Dolby Vision » décrivent bien ce qu'on verra.
 */

/** La dynamique, nommée comme sur une jaquette ; `SDR` ne se dit pas (rien n'est affiché). */
export type DynamicRange = "Dolby Vision" | "HDR10+" | "HDR10" | "HLG" | "HDR" | "SDR";

/**
 * Ce que Jellyfin écrit dans `VideoRangeType` (« DOVIWithHDR10 », « HDR10Plus »…), ramené à un nom.
 *
 * Dolby Vision l'emporte sur ce qu'il accompagne (`DOVIWithHDR10`, `DOVIWithHLG`…), comme partout
 * ailleurs (`toDynamicRange`). `DOVIInvalid` — une couche Dolby Vision que Jellyfin juge inutilisable —
 * ne promet pas le Dolby Vision : on retombe sur `VideoRange` (« HDR » ou « SDR »). Une valeur
 * inconnue d'une version future de Jellyfin fait de même plutôt que d'inventer un nom.
 */
export function dynamicRangeOf(rangeType: string | null | undefined, videoRange?: string | null): DynamicRange | null {
  const raw = (rangeType ?? "").trim();
  if (/^DOVI(?!Invalid)/i.test(raw)) return "Dolby Vision";
  if (/^HDR10Plus$/i.test(raw)) return "HDR10+";
  if (/^HDR10$/i.test(raw)) return "HDR10";
  if (/^HLG$/i.test(raw)) return "HLG";
  if (/^SDR$/i.test(raw)) return "SDR";
  const range = (videoRange ?? "").trim();
  if (/^HDR$/i.test(range)) return "HDR";
  if (/^SDR$/i.test(range)) return "SDR";
  return null;
}

/**
 * La définition, lue sur la largeur **et** la hauteur.
 *
 * La hauteur seule se trompe sur les films en scope : un 1080p en 2,39:1 fait 1920 × 800, un 4K
 * 3840 × 1600 — classés « 720p » et « 1080p » par leur hauteur. La largeur les remet à leur place ;
 * la hauteur reste pour les formats plus étroits que le 16:9 (un 4:3 en 1440 × 1080 est du 1080p).
 * Les seuils laissent la marge des recadrages (3 832, 1 916…).
 */
export function definitionLabel(width: number | null | undefined, height: number | null | undefined): string | null {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w <= 0 && h <= 0) return null;
  if (w >= 3200 || h >= 2000) return "4K";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 700) return "720p";
  return "SD";
}

/** « HEVC 10 bits », « H.264 » : le codec, et la profondeur seulement quand elle dépasse 8 bits. */
export function videoCodecLabel(codec: string | null | undefined, bitDepth: number | null | undefined, bits: (n: number) => string): string | null {
  const name = prettyCodec(codec);
  if (!name) return null;
  return bitDepth && bitDepth > 8 ? `${name} ${bits(bitDepth)}` : name;
}

/**
 * La marge du débit conseillé : **×1,5** sur le débit moyen du fichier.
 *
 * `MediaSource.Bitrate` est une moyenne sur tout le film. Un encodage à débit variable dépense bien
 * plus dans les scènes chargées (grain, pluie, explosions, mouvements de caméra) que dans un dialogue
 * en plan fixe : les pointes de quelques dizaines de secondes à une fois et demie ou deux fois la
 * moyenne sont courantes. Une connexion qui ne tient que la moyenne prend du retard précisément là.
 * Une fois et demie couvre l'essentiel de ces pointes, l'avance que le lecteur garde en mémoire
 * (`MemoryReserve`) absorbant le reste ; deux fois aurait conseillé 100 Mb/s pour un 4K à 50 Mb/s,
 * un chiffre qui décourage pour rien.
 *
 * **Un conseil, pas une condition** : en dessous, le lecteur passe de lui-même à une version allégée
 * quand le lien ne suit pas (DECISIONS.md §78). La fenêtre le dit « pour la qualité d'origine ».
 */
export const ADVISED_MARGIN = 1.5;

/**
 * Le débit de connexion conseillé, en Mb/s, arrondi **vers le haut** à un chiffre qui se lit :
 * à l'unité jusqu'à 10, à 5 près jusqu'à 50, à 10 près au-delà (« 8 », « 25 », « 90 »). Un « 37,5 »
 * ferait croire à une précision que la marge n'a pas. `null` quand le débit est inconnu.
 */
export function advisedConnectionMbps(bitrateBps: number | null | undefined): number | null {
  if (typeof bitrateBps !== "number" || !Number.isFinite(bitrateBps) || bitrateBps <= 0) return null;
  const needed = (bitrateBps / 1_000_000) * ADVISED_MARGIN;
  // Le millième retiré avant l'arrondi : 10 Mb/s × 1,5 donne 15,000000000000002 en virgule flottante,
  // et sans lui « 15 » devenait « 20 ».
  const n = Math.max(needed - 1e-9, 0);
  if (n <= 10) return Math.max(1, Math.ceil(n));
  if (n <= 50) return Math.ceil(n / 5) * 5;
  return Math.ceil(n / 10) * 10;
}

/** Le débit moyen du fichier en Mb/s, pour l'affichage : une décimale sous 10, l'unité au-delà. */
export function bitrateMbps(bitrateBps: number | null | undefined): number | null {
  if (typeof bitrateBps !== "number" || !Number.isFinite(bitrateBps) || bitrateBps <= 0) return null;
  const mbps = bitrateBps / 1_000_000;
  return mbps < 10 ? Math.round(mbps * 10) / 10 : Math.round(mbps);
}

/** Une piste son telle que la fenêtre la reçoit de la route — ce que la règle d'ouverture lit. */
export interface OpeningAudioCandidate {
  language: string | null;
  /** Le `Title` brut du conteneur, que `trackLanguage` et `isAudioDescription` lisent. */
  name?: string | null;
  title?: string | null;
  isDefault: boolean;
  channels: number | null;
}

/**
 * La piste que la fenêtre marque « Par défaut » : **celle que le lecteur ouvrira pour ce compte**, et non
 * le drapeau du fichier (Louis, 13/11/2026 — une VO anglaise marquée par défaut dans le fichier était
 * annoncée « Par défaut » à un compte réglé en français, qui ouvrait pourtant sur la VF).
 *
 * La même règle que le lecteur à l'ouverture (`remuxPlayback.preferredAudio`, `ExperimentalPlayerHost`) :
 * les préférences Jellyfin du compte (`playback-state`, la langue de la série comprise) passées à
 * `chooseAudioTrack` ; quand elle ne choisit rien — pas de langue, `playDefaultAudioTrack`, la langue
 * absente du fichier, préférences inconnues —, la piste par défaut du fichier, puis la première, comme le
 * lecteur. Sans le prédicat « ce chemin la porte » ni les canaux *livrés* : ils dépendent du navigateur,
 * et la fenêtre parle pour tous les appareils : deux pistes de la langue demandée se départagent par les
 * canaux de la source (`rank` sans `delivered`). Sur un iPhone, une TrueHD 7.1 et une AC-3 5.1 de la même
 * langue peuvent donc différer d'ici à ce que le lecteur ouvre (§3) — un cas rare, accepté.
 *
 * Rend le rang de la piste dans la liste, `null` pour un fichier sans son.
 */
export function openingAudioIndex(audio: readonly OpeningAudioCandidate[], preferences: TrackPreferences | null): number | null {
  if (audio.length === 0) return null;
  const tracks = audio.map((a, i) => ({
    language: a.language,
    name: a.name ?? a.title ?? null,
    isDefault: a.isDefault,
    isForced: false,
    channels: a.channels,
    at: i,
  }));
  const chosen = preferences ? chooseAudioTrack(tracks, preferences) : null;
  if (chosen) return chosen.at;
  const flagged = audio.findIndex((a) => a.isDefault);
  return flagged >= 0 ? flagged : 0;
}
