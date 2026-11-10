import { request } from "@playwright/test";

/**
 * Ouvre une session avec le compte de test (jamais un compte réel) et la garde pour tous les
 * scénarios. Les identifiants viennent de l'environnement (`immersion/.env`, ignoré par git).
 */
export default async function globalSetup() {
  const base = process.env.BASE || "http://localhost:3097";
  // SANS_APPLICATION=1 : l'aperçu seul, sans instance derrière — pour ce qui ne demande rien à l'application
  // (le monde, le son, les interactions, le clavier) et doit quand même tourner sous sa politique de sécurité.
  if (process.env.SANS_APPLICATION) {
    const fs = await import("node:fs");
    fs.writeFileSync("/tmp/immersion-state.json", JSON.stringify({ cookies: [], origins: [] }));
    return;
  }
  const user = process.env.JELLYFIN_TEST_USER;
  const password = process.env.JELLYFIN_TEST_PASSWORD;
  if (!user || !password) throw new Error("JELLYFIN_TEST_USER / JELLYFIN_TEST_PASSWORD manquants (immersion/.env)");
  // Garde-fou : ces scénarios lancent des lectures — jamais contre autre chose qu'une instance locale jetable.
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error(`BASE doit être une instance locale jetable, pas ${base}`);
  const ctx = await request.newContext({ baseURL: base });
  const res = await ctx.post("/api/auth/jellyfin", { data: { username: user, password } });
  if (!res.ok()) throw new Error(`connexion du compte de test refusée : ${res.status()}`);
  await ctx.storageState({ path: "/tmp/immersion-state.json" });
  await ctx.dispose();
}
