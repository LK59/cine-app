// Ce que coûte l'ouverture du panneau Activité côté serveur — mesuré sur les vrais journaux.
//
// Écrit le 13/10/2026 (« la page Activité est lente à ouvrir ») pour répondre par des chiffres. Le
// serveur ne voit de Jellyfin que trois appels parallèles (comptes, sessions, appareils), mesurés à
// part ; le reste est du calcul sur les journaux, que ce banc chronomètre : la route entière, puis
// chacune de ses parties, à froid (premier passage, journaux lus et analysés) puis à chaud.
//
//   docker run --rm -v "$PWD":/app -w /app --tmpfs /banc -v "$PWD/data/logs":/banc/logs:ro \
//     -e ACTIVITE_BANC=/banc node:24-alpine npx vitest run activite-bench.spec.ts
//
// `DATA_DIR` pointe vers un dossier jetable dont seul `logs/` est monté, en lecture seule : la base
// y est neuve et vide, rien n'est écrit dans les vrais journaux.
//
// Ce qu'il a établi le 13/10/2026 (13 300 lignes du lecteur sur trente jours, 1 291 séances,
// 17 comptes) : route 266 ms à froid — une fois par démarrage —, 35 à 52 ms à chaud, dont
// listAccounts 10, weekSignals 9, recentSeances 12, household 17. Jellyfin, mesuré à part depuis le
// conteneur : /Devices 780–990 ms, /Users 95–185 ms, /Sessions 5–20 ms. Le temps d'ouverture était
// celui de /Devices, pas celui des journaux (DECISIONS §82).
import { describe, it, vi } from "vitest";

const BANC = process.env.ACTIVITE_BANC;
if (BANC) process.env.DATA_DIR = BANC;

vi.mock("@/lib/activity/adminOnly", () => ({ adminOnly: async () => ({ userId: "admin", userName: "admin", role: "admin" }) }));

const users: { Id: string; Name: string; Policy: Record<string, unknown> }[] = [];
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUsers: async () => users,
    getSessions: async () => [],
    getDevices: async () => [],
  },
}));

const ms = (t: number) => `${(performance.now() - t).toFixed(1)} ms`;

describe.skipIf(!BANC)("coût du panneau Activité", () => {
  it("route et parties, à froid puis à chaud", async () => {
    const { readRecords } = await import("@/lib/activity/logReader");
    const { buildSeances } = await import("@/lib/activity/seances");
    const now = Date.now();
    // Les comptes : ceux que le journal connaît, comme Jellyfin les rendrait.
    const names = new Set(buildSeances(readRecords("player", now - 30 * 864e5)).map((s) => s.user));
    for (const name of names) users.push({ Id: name, Name: name, Policy: {} });
    const { __testing } = await import("@/lib/activity/logReader");
    __testing.reset();
    const acc = await import("@/lib/activity/accounts");
    const { GET } = await import("@/app/api/admin/activity/route");
    const req = new Request("http://localhost/api/admin/activity") as unknown as Parameters<typeof GET>[0];

    let t = performance.now();
    let res = await GET(req);
    const body = await res.text();
    console.log(`route à froid : ${ms(t)} — ${(body.length / 1024).toFixed(0)} Ko, ${names.size} comptes`);
    for (let i = 0; i < 3; i++) {
      t = performance.now();
      res = await GET(req);
      await res.text();
      console.log(`route à chaud #${i + 1} : ${ms(t)}`);
    }
    t = performance.now();
    await acc.listAccounts(now, 0);
    console.log(`  listAccounts : ${ms(t)}`);
    t = performance.now();
    acc.weekSignals(now, 0);
    console.log(`  weekSignals : ${ms(t)}`);
    t = performance.now();
    acc.recentSeances(20, now, 0);
    console.log(`  recentSeances : ${ms(t)}`);
    t = performance.now();
    acc.household(now, 0);
    console.log(`  household : ${ms(t)}`);
    t = performance.now();
    const recs = readRecords("player", now - 30 * 864e5);
    console.log(`  readRecords player 30 j (cache) : ${ms(t)} — ${recs.length} lignes`);
    t = performance.now();
    const seances = buildSeances(recs);
    console.log(`  buildSeances 30 j : ${ms(t)} — ${seances.length} séances`);
    const { diagnoseTitles } = await import("@/lib/activity/diagnosis");
    t = performance.now();
    diagnoseTitles(seances, 60);
    console.log(`  diagnoseTitles : ${ms(t)}`);
    t = performance.now();
    readRecords("server", now - 7 * 864e5);
    readRecords("auth", now - 30 * 864e5);
    readRecords("notifications", now - 30 * 864e5);
    console.log(`  autres journaux (cache) : ${ms(t)}`);
  }, 120_000);
});
