import { request } from "@playwright/test";

/**
 * Ouvre une session avec le compte de test (jamais un compte réel) et la garde pour tous les
 * scénarios. Les identifiants viennent de l'environnement (`immersion/.env`, ignoré par git).
 */
export default async function globalSetup() {
  const base = process.env.BASE || "http://localhost:3097";
  const user = process.env.IMMERSION_TEST_USER;
  const password = process.env.IMMERSION_TEST_PASSWORD;
  if (!user || !password) throw new Error("IMMERSION_TEST_USER / IMMERSION_TEST_PASSWORD manquants (immersion/.env)");
  const ctx = await request.newContext({ baseURL: base });
  const res = await ctx.post("/api/auth/jellyfin", { data: { username: user, password } });
  if (!res.ok()) throw new Error(`connexion du compte de test refusée : ${res.status()}`);
  await ctx.storageState({ path: "/tmp/immersion-state.json" });
  await ctx.dispose();
}
