import crypto from "node:crypto";
import { deleteOverride, readOverride, writeOverride } from "./store";
import { SETTINGS, SETTINGS_BY_KEY, missingRequired, type SettingSource, type SettingView } from "./schema";
import { timingSafeEquals } from "@/lib/timingSafeEquals";

/**
 * Le premier lancement : l'assistant, le compte administrateur créé par lui, et la lecture des
 * réglages pour l'interface (DECISIONS.md §48).
 */

/** Le drapeau de l'assistant : posé par « Terminer », il ne se rouvre plus. */
const SETUP_DONE_KEY = "__SETUP_DONE";
const ADMIN_USER_KEY = "__ADMIN_USER";
const ADMIN_HASH_KEY = "__ADMIN_PASSWORD_HASH";

const envValue = (key: string) => process.env[key] ?? "";

/** La valeur d'un réglage : application, sinon `.env`, sinon défaut — la règle de `config.ts`. */
export function settingValue(key: string): string {
  return readOverride(key) ?? process.env[key] ?? SETTINGS_BY_KEY.get(key)?.fallback ?? "";
}

export function settingSource(key: string): SettingSource {
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
 * `.env` avant que l'assistant n'existe — Jellyfin, TMDB et Radarr ou Sonarr déjà renseignés — est
 * reconnue comme terminée, et le drapeau est posé une fois pour toutes : la vider plus tard de son
 * `.env` ne la renverra jamais dans l'assistant.
 */
export function setupDone(): boolean {
  if (readOverride(SETUP_DONE_KEY) === "1") return true;
  if (envValue("SETUP_COMPLETE") === "true") return true;
  const configured =
    envValue("JELLYFIN_API_KEY").trim() !== "" &&
    envValue("TMDB_API_KEY").trim() !== "" &&
    (envValue("RADARR_API_KEY").trim() !== "" || envValue("SONARR_API_KEY").trim() !== "");
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

export const MIN_ADMIN_PASSWORD = 8;

function hash(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** Crée le compte de l'assistant : le mot de passe n'est gardé que haché (scrypt, sel aléatoire). */
export function createSetupAdmin(user: string, password: string): void {
  const salt = crypto.randomBytes(16);
  writeOverride(ADMIN_USER_KEY, user);
  writeOverride(ADMIN_HASH_KEY, `scrypt$${salt.toString("hex")}$${hash(password, salt).toString("hex")}`);
}

/** Le compte de l'assistant accepte-t-il ce nom et ce mot de passe ? */
export function verifySetupAdmin(user: string, password: string): boolean {
  const stored = readOverride(ADMIN_HASH_KEY);
  const expectedUser = readOverride(ADMIN_USER_KEY) || "admin";
  if (!stored || user !== expectedUser) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  return timingSafeEquals(hash(password, Buffer.from(saltHex, "hex")).toString("hex"), hashHex);
}

// ─── L'écriture des réglages ──────────────────────────────────────────────────

/** La raison de refuser cette valeur, ou `null`. */
export function settingProblem(key: string, value: string): string | null {
  const def = SETTINGS_BY_KEY.get(key);
  if (!def || !def.inApp) return "unknown";
  if (value.length > 2000) return "too-long";
  if (def.kind === "boolean" && value !== "true" && value !== "false") return "invalid";
  if (def.kind === "select" && !def.options?.includes(value)) return "invalid";
  if (def.kind === "url" && value !== "") {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid-url";
    } catch {
      return "invalid-url";
    }
  }
  return null;
}

/**
 * Enregistre des réglages faits dans l'application. Un secret laissé vide n'est pas touché — le
 * champ d'un secret s'affiche vide, et l'enregistrer tel quel ne doit pas effacer la clé. Rien
 * n'est écrit si une seule valeur est refusée.
 */
export function saveSettings(values: Record<string, unknown>): { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
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
