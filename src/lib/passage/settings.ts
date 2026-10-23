import { SUBTITLE_BACKGROUNDS, SUBTITLE_COLORS, SUBTITLE_SIZES } from "@/lib/subtitleStyle";
import { HDR_CAP_CHOICES } from "@/lib/webcodecs/hdrDisplay";

/**
 * Les réglages d'appareil que le passage emporte d'une adresse à l'autre (DECISIONS.md §119) — la
 * liste blanche, et la seule.
 *
 * Chaque adresse a son propre `localStorage` : arrivé sur la nouvelle, l'appareil avait tout oublié —
 * le volume, l'apparence des sous-titres, l'interface choisie sur l'iPad. Ce qui est rangé sous le
 * compte côté serveur (langue, disposition de l'accueil, défilement guidé, langue du son par série)
 * suit déjà la session et n'a rien à faire ici.
 *
 * **Jamais** : la session, un bilan de séance gardé (`cine:unsent-stop:*`), la file des lignes
 * (`cine:unsent-lines`), une position en attente, le catalogue gardé, la reprise sur l'appareil, les
 * mesures du navigateur (`cine:codec-support:*`) — qui ne valent que pour ce navigateur-là, ou qui
 * rejoueraient des choses déjà faites. Rien n'est copié « par préfixe » : un nom qui n'est pas ici
 * n'existe pas pour le passage, à l'aller comme à l'arrivée.
 *
 * Les noms transportés sont logiques (`volume`, `quality`…), pas des clés : la qualité est rangée
 * sous le compte (`cine:quality:<compte>`), et l'arrivée la range sous le sien. Chaque valeur est
 * relue par son validateur des deux côtés — à la demande (le serveur ne garde que ce qui passe) et à
 * l'arrivée (l'appareil ne pose que ce qui passe).
 */
export const PASSAGE_SETTINGS = {
  /** `cine:player-volume` — `{ volume: 0..1, muted }` (`rememberedVolume.ts`). */
  volume: { key: "cine:player-volume", valid: validVolume },
  /** `cine:subtitle-style` — taille, couleur, fond, version 2 (`subtitleStyle.ts`). */
  subtitleStyle: { key: "cine:subtitle-style", valid: validSubtitleStyle },
  /** `cine:dual-subtitles` — les deux langues du dernier « deux sous-titres » (`dualSubtitles.ts`). */
  dualSubtitles: { key: "cine:dual-subtitles", valid: validDualSubtitles },
  /** `cine:interface` — Tactile / Ordinateur choisis (`useIsMobile.ts`). « Auto » n'est pas rangé. */
  interface: { key: "cine:interface", valid: (v: string) => v === "touch" || v === "desktop" },
  /** `cine:frame-fit` — l'agrandissement automatique des bandes noires (`frameFit.ts`). */
  frameFit: { key: "cine:frame-fit", valid: (v: string) => v === "on" || v === "off" },
  /** `cine-dialogue` — « Améliorer les dialogues » (`dialoguePreference.ts`). */
  dialogue: { key: "cine-dialogue", valid: (v: string) => v === "on" || v === "strong" },
  /** `cine.hdrLightCap` — le plafond HDR de cet écran (`hdrDisplay.ts`). */
  hdrCap: { key: "cine.hdrLightCap", valid: (v: string) => v === "native" || HDR_CAP_CHOICES.some((c) => typeof c === "number" && String(c) === v) },
  /** `cine:quality:<compte>` — « Originale » (`playbackQuality.ts`) ; la clé prend le compte d'arrivée. */
  quality: { key: "cine:quality:", perAccount: true, valid: (v: string) => v === "original" },
} as const satisfies Record<string, { key: string; perAccount?: boolean; valid: (v: string) => boolean }>;

export type PassageSettingName = keyof typeof PASSAGE_SETTINGS;
export type PassageSettings = Partial<Record<PassageSettingName, string>>;

/** Au-delà, le paquet entier est refusé : huit valeurs courtes n'en approchent pas. */
export const PASSAGE_SETTINGS_MAX_BYTES = 2048;
/** Une valeur seule : la plus longue (le style des sous-titres) fait une soixantaine d'octets. */
const MAX_VALUE = 256;

function json(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function onlyKeys(o: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function validVolume(v: string): boolean {
  const o = json(v);
  if (!o || !onlyKeys(o, ["volume", "muted"])) return false;
  return typeof o.volume === "number" && o.volume >= 0 && o.volume <= 1 && (o.muted === undefined || typeof o.muted === "boolean");
}

function validSubtitleStyle(v: string): boolean {
  const o = json(v);
  if (!o || !onlyKeys(o, ["size", "color", "background", "v"])) return false;
  return (
    o.v === 2 &&
    SUBTITLE_SIZES.some((s) => s.value === o.size) &&
    (SUBTITLE_COLORS as string[]).includes(o.color as string) &&
    (SUBTITLE_BACKGROUNDS as string[]).includes(o.background as string)
  );
}

const LANGUAGE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})?$/;

function validDualSubtitles(v: string): boolean {
  const o = json(v);
  if (!o || !onlyKeys(o, ["v", "primary", "second"])) return false;
  return o.v === 1 && typeof o.second === "string" && LANGUAGE.test(o.second) && (o.primary === null || (typeof o.primary === "string" && LANGUAGE.test(o.primary)));
}

/**
 * Ce qui reste d'un paquet venu d'ailleurs : les seuls noms de la liste, des chaînes valides, sous la
 * borne. Tout le reste est ignoré sans bruit — un nom inconnu, une valeur abîmée. `{}` pour tout ce
 * qui n'est pas un objet, ou un objet trop gros.
 */
export function cleanPassageSettings(raw: unknown): PassageSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return {};
  }
  if (size > PASSAGE_SETTINGS_MAX_BYTES) return {};
  const out: PassageSettings = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(PASSAGE_SETTINGS, name)) continue;
    if (typeof value !== "string" || value.length > MAX_VALUE) continue;
    if (PASSAGE_SETTINGS[name as PassageSettingName].valid(value)) out[name as PassageSettingName] = value;
  }
  return out;
}

function storageKey(name: PassageSettingName, account: string | null): string | null {
  const entry = PASSAGE_SETTINGS[name];
  if ("perAccount" in entry && entry.perAccount) return account ? entry.key + account : null;
  return entry.key;
}

/** Les réglages de cet appareil, lus dans son stockage — seulement ceux de la liste, et valides. */
export function readPassageSettings(storage: Pick<Storage, "getItem">, account: string | null): PassageSettings {
  const raw: Record<string, string> = {};
  for (const name of Object.keys(PASSAGE_SETTINGS) as PassageSettingName[]) {
    const key = storageKey(name, account);
    if (!key) continue;
    try {
      const value = storage.getItem(key);
      if (value !== null) raw[name] = value;
    } catch {
      /* stockage illisible : ce réglage ne voyage pas */
    }
  }
  return cleanPassageSettings(raw);
}

/** Pose les réglages arrivés — revalidés ici. Rend combien ont été écrits. */
export function writePassageSettings(storage: Pick<Storage, "setItem">, settings: unknown, account: string | null): number {
  const clean = cleanPassageSettings(settings);
  let written = 0;
  for (const [name, value] of Object.entries(clean) as [PassageSettingName, string][]) {
    const key = storageKey(name, account);
    if (!key) continue;
    try {
      storage.setItem(key, value);
      written += 1;
    } catch {
      /* stockage refusé : la valeur par défaut reste */
    }
  }
  return written;
}
