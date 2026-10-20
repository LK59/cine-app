import { deleteOverride, readOverride, writeOverride } from "./store";
import { SETTINGS, SETTINGS_BY_KEY, missingRequired, urlProblem, type SettingSource, type SettingView } from "./schema";
import { ADMIN_HASH_KEY, ADMIN_USER_KEY, MIN_ADMIN_PASSWORD, hashAdminPassword, verifyAdminPassword } from "../../../server-boot/adminAccount.mjs";

export { MIN_ADMIN_PASSWORD };

/**
 * Le premier lancement : l'assistant, le compte administrateur créé par lui, et la lecture des
 * réglages pour l'interface (DECISIONS.md §48).
 */

/** Le drapeau de l'assistant : posé par « Terminer », il ne se rouvre plus. */
const SETUP_DONE_KEY = "__SETUP_DONE";

const envValue = (key: string) => process.env[key] ?? "";

/**
 * La valeur d'un réglage : application, sinon `.env`, sinon défaut — la règle de `config.ts`. Une
 * option de déploiement (`inApp: false`) se lit dans l'environnement seul, comme `config.ts` la lit
 * (`envOnly`) : une ligne restée en base n'est plus appliquée, elle ne doit pas non plus s'afficher
 * (§81) — la page Déploiement dit ce qui est posé.
 */
export function settingValue(key: string): string {
  const def = SETTINGS_BY_KEY.get(key);
  const env = process.env[key];
  if (def && !def.inApp) return env ?? def.fallback;
  return readOverride(key) ?? env ?? def?.fallback ?? "";
}

export function settingSource(key: string): SettingSource {
  const def = SETTINGS_BY_KEY.get(key);
  if (def && !def.inApp) return process.env[key] !== undefined && process.env[key] !== "" ? "env" : "default";
  if (readOverride(key) !== null) return "app";
  if (process.env[key] !== undefined && process.env[key] !== "") return "env";
  return "default";
}

/** Ce que le navigateur peut voir d'un réglage : un secret n'en sort jamais. */
export function settingView(key: string): SettingView {
  const def = SETTINGS_BY_KEY.get(key);
  const value = settingValue(key);
  const secret = def?.kind === "secret";
  return {
    key,
    source: settingSource(key),
    value: secret ? null : value,
    set: value.trim().length > 0,
    hint: secret && value.length >= 8 ? `…${value.slice(-4)}` : null,
    envPresent: envValue(key) !== "",
  };
}

export function allSettingViews(): SettingView[] {
  return SETTINGS.map((s) => settingView(s.key));
}

export function missingRequiredSettings(): string[] {
  return missingRequired(settingValue);
}

/**
 * L'assistant est-il terminé ?
 *
 * Posé par « Terminer », ou forcé par `SETUP_COMPLETE=true`. Une installation configurée par son
 * `.env` avant que l'assistant n'existe — Jellyfin et TMDB déjà renseignés (Radarr et Sonarr sont
 * facultatifs depuis le 14/10/2026, §89) — est
 * reconnue comme terminée, et le drapeau est posé une fois pour toutes : la vider plus tard de son
 * `.env` ne la renverra jamais dans l'assistant.
 */
export function setupDone(): boolean {
  if (readOverride(SETUP_DONE_KEY) === "1") return true;
  if (envValue("SETUP_COMPLETE") === "true") return true;
  const configured =
    envValue("JELLYFIN_API_KEY").trim() !== "" &&
    envValue("TMDB_API_KEY").trim() !== "";
  if (configured) {
    try {
      writeOverride(SETUP_DONE_KEY, "1");
    } catch {
      /* la base reviendra : la détection, elle, tient déjà */
    }
    return true;
  }
  return false;
}

export function completeSetup(): void {
  writeOverride(SETUP_DONE_KEY, "1");
}

/** Pour les tests : rouvrir l'assistant. */
export function reopenSetupForTests(): void {
  deleteOverride(SETUP_DONE_KEY);
}

// ─── Le compte administrateur local ───────────────────────────────────────────

/**
 * Le compte administrateur local, s'il existe : celui de `.env` (`APP_ADMIN_PASSWORD`), sinon
 * celui créé par l'assistant. Une installation neuve démarre sans aucun : l'assistant le demande.
 */
export function localAdmin(): { user: string; source: "env" | "setup" } | null {
  if (envValue("APP_ADMIN_PASSWORD")) return { user: envValue("APP_ADMIN_USER") || "admin", source: "env" };
  if (readOverride(ADMIN_HASH_KEY)) return { user: readOverride(ADMIN_USER_KEY) || "admin", source: "setup" };
  return null;
}

/**
 * Crée le compte de l'assistant, ou change son mot de passe : gardé haché seulement (scrypt, sel
 * aléatoire), par le module que partage la commande de réinitialisation (`server-boot/adminAccount.mjs`).
 */
export function createSetupAdmin(user: string, password: string): void {
  writeOverride(ADMIN_USER_KEY, user);
  writeOverride(ADMIN_HASH_KEY, hashAdminPassword(password));
}

/** Le compte de l'assistant accepte-t-il ce nom et ce mot de passe ? */
export function verifySetupAdmin(user: string, password: string): boolean {
  const stored = readOverride(ADMIN_HASH_KEY);
  const expectedUser = readOverride(ADMIN_USER_KEY) || "admin";
  if (!stored || user !== expectedUser) return false;
  return verifyAdminPassword(password, stored);
}

// ─── L'écriture des réglages ──────────────────────────────────────────────────

/** La raison de refuser cette valeur, ou `null`. */
export function settingProblem(key: string, value: string): string | null {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def || !def.inApp) return "unknown";
  if (value.length > 2000) return "too-long";
  if (def.kind === "boolean" && value !== "true" && value !== "false") return "invalid";
  if (def.kind === "select" && !def.options?.includes(value)) return "invalid";
  // Un montant (budget, prix au million de jetons) : vide, ou un nombre positif — « 5 », « 0,75 ».
  if (def.kind === "number" && value !== "" && !/^\d{1,6}([.,]\d{1,4})?$/.test(value)) return "invalid";
  if (def.kind === "profile" && value !== "" && !/^[1-9]\d{0,8}$/.test(value)) return "invalid";
  if (def.kind === "url" && value !== "") {
    const problem = urlProblem(value);
    if (problem) return problem;
  }
  return null;
}

// ─── Une adresse changée ne reçoit pas le secret enregistré ───────────────────

/** Le code d'erreur d'un secret à ressaisir, et ce que disent les routes qui le refusent. */
export const SECRET_REQUIRED = "secret-required";
export const SECRET_REQUIRED_CODE = "settings-secret-required";

/**
 * Une adresse comparable : sans espaces ni barre finale, le schéma et l'hôte en minuscules
 * (`HTTP://Radarr:7878/` est `http://radarr:7878`). Le chemin garde sa casse : il est celui du
 * service. Illisible, l'adresse est rendue telle quelle (sans espaces ni barre finale).
 */
export function normalizeServiceUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  try {
    // L'analyseur met déjà le schéma et l'hôte en minuscules ; l'identifiant éventuel compte.
    const parsed = new URL(trimmed);
    const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@` : "";
    return `${parsed.protocol}//${auth}${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

/**
 * Les secrets à ressaisir parce que l'adresse de leur service change (20/10/2026).
 *
 * Un secret laissé vide reprend celui qui est enregistré — au test comme à l'enregistrement. Mais
 * changer la seule adresse envoyait alors la clé d'administration de Jellyfin, de Radarr, de Sonarr…
 * au nouvel hôte : un cookie administrateur volé devenait le vol de toutes les clés. L'adresse d'un
 * groupe qui diffère de celle en vigueur exige donc que chacun de ses secrets *déjà renseignés* soit
 * fourni à nouveau. Une adresse inchangée garde la règle d'avant ; un secret encore vide n'a rien à
 * fuir, et l'assistant d'une installation neuve n'a rien à ressaisir.
 *
 * `given(key)` : la valeur soumise, vide si absente. Rend les clés de secret manquantes, par groupe
 * dont l'adresse change (`changed`, pour le journal des actions de l'administrateur).
 */
export function secretsToResubmit(given: (key: string) => string, groups?: readonly string[]): { missing: string[]; changed: { group: string; urlKey: string }[] } {
  const missing: string[] = [];
  const changed: { group: string; urlKey: string }[] = [];
  for (const def of SETTINGS) {
    if (def.kind !== "url" || !def.inApp || def.key !== `${def.group.toUpperCase()}_URL`) continue;
    if (groups && !groups.includes(def.group)) continue;
    const next = given(def.key).trim();
    // Pas d'adresse soumise (rien ne change), ou vidée : aucun hôte nouveau à qui parler.
    if (next === "" || normalizeServiceUrl(next) === normalizeServiceUrl(settingValue(def.key))) continue;
    changed.push({ group: def.group, urlKey: def.key });
    for (const secret of SETTINGS) {
      if (secret.group !== def.group || secret.kind !== "secret" || !secret.inApp) continue;
      if (settingValue(secret.key).trim() === "") continue;
      if (given(secret.key).trim() === "") missing.push(secret.key);
    }
  }
  return { missing, changed };
}

/** L'hôte d'une adresse, pour le journal : jamais un identifiant qu'elle porterait (`user:pass@`). */
export function urlForLog(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "(illisible)";
  }
}

/**
 * Enregistre des réglages faits dans l'application. Un secret laissé vide n'est pas touché — le
 * champ d'un secret s'affiche vide, et l'enregistrer tel quel ne doit pas effacer la clé. Rien
 * n'est écrit si une seule valeur est refusée. Sauf quand l'adresse de son service change : le
 * secret enregistré n'y suivrait pas sans être ressaisi (`secretsToResubmit`), il est demandé.
 */
export function saveSettings(values: Record<string, unknown>): { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const givenString = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "");
  for (const key of secretsToResubmit(givenString).missing) errors[key] = SECRET_REQUIRED;
  const writes: [string, string][] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (typeof raw !== "string") {
      errors[key] = "invalid";
      continue;
    }
    const value = raw.trim();
    const def = SETTINGS_BY_KEY.get(key);
    if (def?.kind === "secret" && value === "") continue;
    const problem = settingProblem(key, value);
    if (problem) errors[key] = problem;
    else writes.push([key, value]);
  }
  if (Object.keys(errors).length === 0) for (const [key, value] of writes) writeOverride(key, value);
  return { errors };
}

/** « Revenir à la valeur du .env » : l'application rend la main. */
export function resetSetting(key: string): boolean {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def || !def.inApp) return false;
  deleteOverride(key);
  return true;
}
