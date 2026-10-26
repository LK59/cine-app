import { toJellyfinLanguage } from "@/lib/trackPreferences";

/**
 * Le sous-titre incrusté dans l'image envoyée à un téléviseur par AirPlay (26/10/2026).
 *
 * Diffuser depuis le téléphone confie au téléviseur l'adresse du flux, et à lui seul : les `<track>`
 * de la page ne voyagent pas, et un récepteur AirPlay de téléviseur (TCL, Samsung, LG) n'a pas de
 * menu pour choisir une piste du manifeste. Un compte a changé huit fois de sous-titres depuis son
 * iPhone sur deux soirs, coupé la diffusion à chaque fois, et regardé sans. Le sous-titre choisi sur
 * le téléphone au moment de diffuser est donc incrusté par Jellyfin, ce qui ré-encode l'image.
 *
 * L'index Jellyfin vaut pour le fichier où il a été lu ; la langue et le drapeau « forcé » servent à
 * retrouver le même sous-titre dans l'épisode suivant d'une diffusion (`castCarriedTo`), dont les
 * index ne sont pas les mêmes.
 */
export interface CastSubtitle {
  /** L'index Jellyfin dans le fichier d'origine ; absent pour un autre fichier. */
  index?: number;
  /** Code Jellyfin (`fra`, `eng`…), `null` si la piste n'en dit rien. */
  language: string | null;
  forced: boolean;
}

/** Le même sous-titre, pour un autre fichier : sa langue et son drapeau, sans index. */
export function castSubtitleForAnotherFile(subtitle: CastSubtitle | undefined): CastSubtitle | undefined {
  return subtitle ? { language: subtitle.language, forced: subtitle.forced } : undefined;
}

/** Relu d'un corps de requête : rien d'inventé, une forme inattendue ne vaut rien. */
export function parseCastSubtitle(value: unknown): CastSubtitle | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const index = typeof v.index === "number" && Number.isInteger(v.index) && v.index >= 0 ? v.index : undefined;
  const language = typeof v.language === "string" && /^[a-z]{2,8}$/i.test(v.language) ? toJellyfinLanguage(v.language) : null;
  if (index === undefined && language === null) return null;
  return { ...(index !== undefined ? { index } : {}), language, forced: v.forced === true };
}

interface StreamFacts {
  Type: string;
  Index: number;
  Language?: string | null;
  IsForced?: boolean;
  IsTextSubtitleStream?: boolean;
}

/**
 * L'index du sous-titre à incruster dans ce fichier, ou `null` : aucun ne correspond.
 *
 * L'index demandé d'abord, s'il désigne bien un sous-titre de cette langue ; sinon un sous-titre de
 * la même langue — le même drapeau « forcé » avant l'autre, un texte avant une image, puis l'ordre du
 * fichier. Sans langue connue, seul l'index demandé peut valoir.
 */
export function castSubtitleStream(streams: StreamFacts[] | undefined, wanted: CastSubtitle): number | null {
  const subtitles = (streams ?? []).filter((s) => s.Type === "Subtitle");
  const sameLanguage = (s: StreamFacts) => wanted.language !== null && toJellyfinLanguage(s.Language) === wanted.language;
  if (wanted.index !== undefined) {
    const asked = subtitles.find((s) => s.Index === wanted.index);
    if (asked && (wanted.language === null || sameLanguage(asked))) return asked.Index;
  }
  if (wanted.language === null) return null;
  const candidates = subtitles.filter(sameLanguage);
  const rank = (s: StreamFacts) => ((s.IsForced === true) === wanted.forced ? 0 : 2) + (s.IsTextSubtitleStream === false ? 1 : 0);
  const best = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  return best ? best.Index : null;
}
