// La session administrateur du banc de nuit, fabriquée DANS l'instance jetable (docker exec), avec son
// SESSION_SECRET et sa base — jamais celles de la production. Même format que src/lib/auth.ts (encodeSession) :
// corps JSON en base64url, signature HMAC-SHA256 ; et la ligne `sessions` que verifySessionFull exige. L'identité Jellyfin est celle du compte de test,
// ouverte par AuthenticateByName (identifiants lus sur l'entrée standard, jamais affichés).
//
//   node .mint.mjs            < creds   → écrit `cine_session=<jeton>` sur la sortie standard
import fs from "node:fs";
import Database from "better-sqlite3";

const env = Object.fromEntries(
  fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")])
);
const user = env.JELLYFIN_TEST_USER;
const password = env.JELLYFIN_TEST_PASSWORD;
const jf = process.env.JELLYFIN_URL || "http://jellyfin:8096";
const secret = process.env.SESSION_SECRET;
const identity = `MediaBrowser Client="Laterna", Device="banc-nuit", DeviceId="lumen-nuit-banc", Version="banc"`;

if (process.argv.includes("--logout")) process.exit(0); // rien à rendre : le jeton l'est dès la fabrication

if (!user || !password || !secret) throw new Error("identifiants ou secret absents");
if (/^admin/i.test(user)) throw new Error("refus : le banc n'ouvre que le compte de test");
const res = await fetch(`${jf}/Users/AuthenticateByName`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: identity },
  body: JSON.stringify({ Username: user, Pw: password }),
});
if (!res.ok) throw new Error(`Jellyfin : ${res.status}`);
const auth = await res.json();
const jfToken = auth.AccessToken;
const jfId = String(auth.User.Id).replace(/-/g, "");
// Le jeton ne sert qu'à prouver le compte et à lire son identifiant : rendu aussitôt (l'appareil quitte Jellyfin), et
// jamais mis dans la session. Une session administrateur qui porte le jeton d'un compte Jellyfin non administrateur
// est fermée par le proxy (« Rôle changé dans Jellyfin depuis la connexion », jellyfinToken.ts) ; sans jeton, la
// vérification n'a pas lieu, et les routes du banc lisent Jellyfin avec la clé du serveur et l'identifiant du compte.
await fetch(`${jf}/Sessions/Logout`, { method: "POST", headers: { Authorization: `${identity}, Token="${jfToken}"` } });

const enc = new TextEncoder();
const b64u = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jti = b64u(crypto.getRandomValues(new Uint8Array(16)));
const payload = { u: "banc-nuit", role: "admin", exp: Date.now() + 7 * 24 * 3600 * 1000, jti, jfUser: auth.User.Name, jfId };
const body = b64u(enc.encode(JSON.stringify(payload)));
const hmac = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = b64u(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, enc.encode(body))));

const db = new Database("/app/data/cine.db");
const now = Date.now();
db.prepare("INSERT OR REPLACE INTO sessions (jti, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").run(jti, "banc-nuit", now, now);
db.close();
process.stdout.write(`cine_session=${body}.${sig}\n`);
