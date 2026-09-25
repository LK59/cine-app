import { describe, it, expect, vi, beforeEach } from "vitest";
import { sessionSecretProblem, adminPasswordProblem } from "@/lib/sessionSecret";

/**
 * Relevé par l'audit de la documentation (22/09/2026) : le démarrage ne refusait que la valeur par
 * défaut du code, et le modèle `.env.example` en publiait une autre, acceptée — un serveur signé
 * d'un secret que tout le monde peut lire.
 */
describe("sessionSecretProblem", () => {
  it.each([
    ["", "vide"],
    ["   ", "vide"],
    ["change-me-in-production", "exemple"],
    ["generate-a-long-random-string", "exemple"],
    ["court-mais-pas-vide", null],
  ])("« %s »", (secret, attendu) => {
    const problem = sessionSecretProblem(secret);
    if (attendu === null) expect(problem).toBeNull();
    else expect(problem).toContain(attendu);
  });

  it("refuse moins de seize caractères, accepte à partir de seize", () => {
    expect(sessionSecretProblem("a".repeat(15))).toContain("16");
    expect(sessionSecretProblem("a".repeat(16))).toBeNull();
    // L'installation de référence a vingt caractères : elle doit continuer de démarrer.
    expect(sessionSecretProblem("x".repeat(20))).toBeNull();
  });
});

describe("adminPasswordProblem", () => {
  it("refuse le mot de passe d'exemple, laisse le vide désactiver le compte local", () => {
    expect(adminPasswordProblem("change-me")).toContain("exemple");
    expect(adminPasswordProblem("")).toBeNull();
    expect(adminPasswordProblem("un-vrai-mot-de-passe")).toBeNull();
  });
});

describe("le démarrage", () => {
  beforeEach(() => vi.resetModules());

  async function boot(env: { secret: string; password?: string }) {
    vi.doMock("@/lib/config", () => ({
      config: { app: { sessionSecret: env.secret, adminPassword: env.password ?? "" } },
    }));
    vi.doMock("@/lib/notificationJobs", () => ({ startNotificationCron: vi.fn() }));
    vi.doMock("@/lib/torrentWatch", () => ({ startTorrentWatch: vi.fn() }));
    vi.doMock("@/lib/statusCron", () => ({ startStatusCron: vi.fn() }));
    vi.doMock("@/lib/dbBackup", () => ({ startDbBackupCron: vi.fn() }));
    vi.doMock("@/lib/posterPrewarm", () => ({ startPosterPrewarm: vi.fn() }));
    vi.doMock("@/lib/server-cache", () => ({ cachedMovies: vi.fn(async () => {}), cachedSeries: vi.fn(async () => {}) }));
    const previous = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      const { register } = await import("@/instrumentation");
      await register();
    } finally {
      process.env.NEXT_RUNTIME = previous;
    }
  }

  it("refuse le secret du modèle publié", async () => {
    await expect(boot({ secret: "generate-a-long-random-string" })).rejects.toThrow(/exemple publiée/);
  });

  it("refuse un secret vide", async () => {
    await expect(boot({ secret: "" })).rejects.toThrow(/vide/);
  });

  it("refuse le mot de passe administrateur d'exemple", async () => {
    await expect(boot({ secret: "x".repeat(32), password: "change-me" })).rejects.toThrow(/APP_ADMIN_PASSWORD/);
  });

  it("démarre avec un vrai secret", async () => {
    await expect(boot({ secret: "x".repeat(20), password: "" })).resolves.toBeUndefined();
  });
});
