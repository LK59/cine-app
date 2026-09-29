/**
 * Ce qui rend une installation forgeable, dit avant qu'elle ne démarre — la seule copie de ces
 * règles. `boot.mjs` les applique avant d'importer le serveur, `src/lib/sessionSecret.ts` les
 * réexporte pour `instrumentation.ts`. Du JavaScript pur, parce que `boot.mjs` est exécuté tel
 * quel par node dans l'image, sans TypeScript ni alias `@/`.
 *
 * Pourquoi dans `boot.mjs` (audit du 29/09/2026) : le refus ne vivait que dans
 * `instrumentation.ts`, dont Next rattrape l'exception en « Failed to prepare server » et une
 * promesse rejetée. Le processus ne sortait pas ; le conteneur restait « Up », répondait 500 à tout
 * et ne devenait « unhealthy » qu'au bout de 150 s — alors que la documentation promet une sortie
 * immédiate. Refuser avant l'import, puis `process.exit(1)`, tient cette promesse.
 *
 * Le contrôle ne refusait d'abord que la valeur par défaut du code, `change-me-in-production`. Or
 * le modèle publié, `.env.example`, en portait une autre — `generate-a-long-random-string` — et un
 * inconnu qui le recopiait sans y toucher obtenait un serveur signé d'un secret que n'importe qui
 * peut lire sur GitHub : une session administrateur à la portée de tous. Une valeur vide passait
 * aussi (audit de la documentation, 22/09/2026). Même chose pour le mot de passe administrateur
 * d'exemple.
 *
 * Seize caractères au moins, et pas davantage : l'installation de référence tourne avec un secret
 * de vingt caractères, et une règle qui l'empêcherait de redémarrer serait une panne, pas une
 * protection. Un secret plus long reste recommandé (`openssl rand -hex 32`).
 */
import fs from "node:fs";
import path from "node:path";

export const PLACEHOLDER_SECRETS = new Set(["change-me-in-production", "generate-a-long-random-string"]);
export const PLACEHOLDER_PASSWORDS = new Set(["change-me"]);
export const MIN_SECRET_LENGTH = 16;

/** La raison de refuser ce secret de session, ou `null` s'il convient. */
export function sessionSecretProblem(secret) {
  if (!secret.trim()) return "SESSION_SECRET est vide.";
  if (PLACEHOLDER_SECRETS.has(secret)) return "SESSION_SECRET est la valeur d'exemple publiée.";
  if (secret.length < MIN_SECRET_LENGTH) {
    return `SESSION_SECRET fait ${secret.length} caractères — ${MIN_SECRET_LENGTH} au moins.`;
  }
  return null;
}

/**
 * La raison de refuser le mot de passe administrateur local, ou `null`. Vide est permis : c'est
 * ainsi qu'on désactive le compte administrateur local (seuls les comptes Jellyfin entrent alors).
 */
export function adminPasswordProblem(password) {
  if (PLACEHOLDER_PASSWORDS.has(password)) return "APP_ADMIN_PASSWORD est la valeur d'exemple publiée.";
  return null;
}

/**
 * Le message complet qui refuse le démarrage — la raison et ce qu'il faut faire —, ou `null`.
 * Les deux contrôles (`boot.mjs`, `instrumentation.ts`) disent la même phrase, celle que la
 * documentation cite.
 */
export function startupRefusal({ sessionSecret, adminPassword }) {
  const secretProblem = sessionSecretProblem(sessionSecret);
  if (secretProblem) {
    return `${secretProblem} Posez-en un dans .env (openssl rand -hex 32) — sans lui, une session administrateur peut être forgée.`;
  }
  const passwordProblem = adminPasswordProblem(adminPassword);
  if (passwordProblem) {
    return `${passwordProblem} Choisissez-en un dans .env, ou laissez-le vide pour désactiver le compte local.`;
  }
  return null;
}

/**
 * La raison pour laquelle le dossier de données ne peut pas être écrit, ou `null`. Un fichier
 * témoin créé puis effacé : c'est la seule question qui vaille (les droits affichés ne disent rien
 * d'un montage en lecture seule). Sans ce test, un `data/` au mauvais propriétaire donnait lui
 * aussi un conteneur « Up » qui répondait 503.
 */
export function dataDirProblem(dataDir) {
  const probe = path.join(dataDir, `.ecriture-${process.pid}`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return null;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : String(error);
    return `DATA_DIR (${dataDir}) ne peut pas être écrit (${code}). Donnez le dossier au compte du conteneur (chown -R 1001:1001 data).`;
  }
}
