import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { localAdmin, setupDone } from "./setup";

/**
 * Le code d'installation : la preuve qu'on a la main sur le serveur, demandée pour créer le compte
 * administrateur à l'assistant (20/10/2026, DECISIONS.md §48).
 *
 * Avant lui, une installation neuve appartenait au premier visiteur : la route qui crée le compte est
 * publique — personne n'en a encore — et le port publié sur toutes les interfaces suffisait à
 * quiconque passait par là pour devenir administrateur, puis lire chaque clé des services. Le code est
 * tiré au hasard au démarrage tant qu'aucun administrateur n'existe, gardé dans
 * `data/config/setup-code` (lisible par le seul compte du conteneur, comme `secrets.json`) pour
 * survivre aux redémarrages, et écrit dans les journaux du conteneur : seul qui lit `docker logs`
 * le connaît. Le compte créé, le fichier est effacé ; une installation qui a déjà un administrateur
 * (celui de `.env` ou de l'assistant) ou dont l'assistant est terminé n'en a jamais.
 */

/** Sans 0/O ni 1/I : il se recopie depuis un terminal. 32 signes × 12 = 60 bits. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 12;

export function setupCodeFile(): string {
  return path.join(DATA_DIR, "config", "setup-code");
}

/** Faut-il un code ? Tant que le compte administrateur reste à créer. */
export function setupCodeNeeded(): boolean {
  return !setupDone() && localAdmin() === null;
}

function generate(): string {
  let raw = "";
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join("-");
}

/** Recopié à la main : casse, espaces et tirets ne comptent pas. */
function canonical(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, "");
}

function readCode(): string | null {
  try {
    const code = fs.readFileSync(setupCodeFile(), "utf8").trim();
    return canonical(code).length === LENGTH ? code : null;
  } catch {
    return null;
  }
}

/** Efface le code : le compte existe, il ne sert plus. Sans fichier, rien à faire. */
export function clearSetupCode(): void {
  try {
    fs.rmSync(setupCodeFile(), { force: true });
  } catch {
    /* un fichier resté ne sert plus à rien : la route refuse dès qu'un administrateur existe */
  }
}

/**
 * Le code en cours, créé s'il manque ; `null` quand il n'en faut pas (et un fichier resté est
 * effacé). `created` : il vient d'être tiré, à écrire dans les journaux.
 */
export function ensureSetupCode(): { code: string; created: boolean } | null {
  if (!setupCodeNeeded()) {
    clearSetupCode();
    return null;
  }
  const existing = readCode();
  if (existing) return { code: existing, created: false };
  const file = setupCodeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const code = generate();
  try {
    // `wx` : deux modules (le démarrage, une route) qui le tirent en même temps gardent le même.
    fs.writeFileSync(file, code + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    const raced = (error as NodeJS.ErrnoException).code === "EEXIST" ? readCode() : null;
    if (raced) return { code: raced, created: false };
    // Un fichier illisible ou vide resté là : remplacé.
    fs.writeFileSync(file, code + "\n", { mode: 0o600 });
  }
  // Le mode de `writeFileSync` ne s'applique qu'à la création ; un umask large ne l'élargit pas ici.
  fs.chmodSync(file, 0o600);
  return { code, created: true };
}

/** La ligne des journaux du conteneur — la seule façon de connaître le code. */
export function setupCodeLogLine(code: string): string {
  return `[setup] One-time setup code: ${code} — enter it in the setup assistant to create the administrator account (valid until that account exists).`;
}

/**
 * Au démarrage : le code écrit dans les journaux tant qu'il en faut un, à chaque démarrage — un
 * redémarrage ne doit pas le faire disparaître de `docker logs`, qui repart à zéro avec le conteneur.
 */
export function announceSetupCode(log: (line: string) => void = console.log): void {
  const current = ensureSetupCode();
  if (current) log(setupCodeLogLine(current.code));
}

/** Le code saisi est-il le bon ? Comparé en temps constant, sur des empreintes de même longueur. */
export function verifySetupCode(input: unknown): boolean {
  const stored = readCode();
  if (!stored || typeof input !== "string" || input.length > 64) return false;
  const digest = (s: string) => crypto.createHash("sha256").update(canonical(s)).digest();
  return crypto.timingSafeEqual(digest(input), digest(stored));
}
