/**
 * Les secrets aléatoires d'une installation, générés au premier lancement (DECISIONS.md §48).
 *
 * Personne n'a à inventer un secret de session ni des clés de notifications pour démarrer : ce qui
 * manque à l'environnement est tiré au hasard une fois, gardé dans `data/config/secrets.json`
 * (lisible par le seul compte du conteneur), puis relu à chaque démarrage — les sessions et les
 * abonnements aux notifications survivent donc aux redémarrages et aux mises à jour.
 *
 * **L'environnement l'emporte toujours** : une valeur posée dans `.env` est prise telle quelle, et
 * le fichier n'est ni lu ni écrit pour elle. Une installation qui a déjà tout dans `.env` ne voit
 * aucune différence.
 *
 * Du JavaScript pur, comme `startupChecks.mjs` : exécuté par node dans l'image avant le serveur,
 * et réutilisé par `instrumentation.ts` (serveur de développement).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Le fichier des secrets générés. */
export function secretsFile(dataDir) {
  return path.join(dataDir, "config", "secrets.json");
}

function readSecrets(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Des clés VAPID, si `web-push` est là ; sinon rien — les notifications restent simplement éteintes. */
async function vapidKeys() {
  try {
    const webPush = (await import("web-push")).default;
    return webPush.generateVAPIDKeys();
  } catch {
    return null;
  }
}

/**
 * Pose dans `process.env` chaque secret manquant, généré au besoin. Rend la liste de ceux qui
 * viennent du fichier (pour la ligne de démarrage), sans jamais leurs valeurs.
 */
export async function applyFirstRunSecrets(dataDir, env = process.env) {
  const file = secretsFile(dataDir);
  const stored = readSecrets(file);
  let changed = false;
  const fromFile = [];

  const want = (key) => !(env[key] ?? "").trim();

  if (want("SESSION_SECRET")) {
    if (typeof stored.SESSION_SECRET !== "string" || stored.SESSION_SECRET.length < 32) {
      stored.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
      changed = true;
    }
    env.SESSION_SECRET = stored.SESSION_SECRET;
    fromFile.push("SESSION_SECRET");
  }

  // Les deux clés vont ensemble : une moitié venue de `.env` et l'autre générée ne signeraient rien.
  if (want("VAPID_PUBLIC_KEY") && want("VAPID_PRIVATE_KEY")) {
    if (typeof stored.VAPID_PUBLIC_KEY !== "string" || typeof stored.VAPID_PRIVATE_KEY !== "string") {
      const keys = await vapidKeys();
      if (keys) {
        stored.VAPID_PUBLIC_KEY = keys.publicKey;
        stored.VAPID_PRIVATE_KEY = keys.privateKey;
        changed = true;
      }
    }
    if (typeof stored.VAPID_PUBLIC_KEY === "string" && typeof stored.VAPID_PRIVATE_KEY === "string") {
      env.VAPID_PUBLIC_KEY = stored.VAPID_PUBLIC_KEY;
      env.VAPID_PRIVATE_KEY = stored.VAPID_PRIVATE_KEY;
      fromFile.push("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY");
    }
  }

  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  }
  return fromFile;
}
