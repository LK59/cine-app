import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Le cœur des liens de partage (DECISIONS.md §112) : le jeton de session, les secrets, la vie d'un
 * lien (création, entrée, prolongation, révocation, expiration), le compte Jellyfin verrouillé et la
 * limite de trois lectures. La porte du proxy est dans `share-gate.test.ts`.
 */

const account = vi.hoisted(() => ({
  created: [] as string[],
  disabled: [] as [string, boolean][],
  deleted: [] as string[],
  signIns: 0,
  failCreate: false,
}));
vi.mock("@/lib/share/jellyfinAccount", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/share/jellyfinAccount")>();
  return {
    ...real,
    describeItem: async (id: string) => (id === "a".repeat(32) ? { type: "Movie", name: "Interstellar" } : id === "b".repeat(32) ? { type: "Series", name: "Shōgun" } : null),
    createShareAccount: async () => {
      if (account.failCreate) throw new Error("Jellyfin refuse");
      const id = `${account.created.length}`.padStart(32, "f");
      account.created.push(id);
      return { id, name: `partage-${id.slice(-8)}`, password: "secret-du-compte" };
    },
    signInShareAccount: async () => {
      account.signIns += 1;
      return { userId: account.created.at(-1) ?? "f".repeat(32), token: "jeton-jellyfin", deviceId: `cine-app-${account.signIns}` };
    },
    setShareAccountDisabled: async (id: string, disabled: boolean) => {
      account.disabled.push([id, disabled]);
    },
    deleteShareAccount: async (id: string) => {
      account.deleted.push(id);
    },
  };
});
vi.mock("@/lib/jellyfinRevoke", () => ({ revokeJellyfinDevices: vi.fn(async () => undefined) }));

const MOVIE = "a".repeat(32);
const SERIES = "b".repeat(32);
const DAY = 86_400_000;

beforeEach(async () => {
  account.created = [];
  account.disabled = [];
  account.deleted = [];
  account.signIns = 0;
  account.failCreate = false;
  const { getDb } = await import("@/lib/db");
  getDb().prepare("DELETE FROM shares").run();
  getDb().prepare("DELETE FROM sessions").run();
});

async function create(days = 7, kind: "movie" | "series" = "movie") {
  const { createShare } = await import("@/lib/share/service");
  return createShare({ kind, itemId: kind === "movie" ? MOVIE : SERIES, radarrId: 12, sonarrId: 7, label: "  Paul  ", days, createdBy: "louis", creatorJfId: null });
}

describe("le jeton de session", () => {
  it("une session de partage porte son lien, et ne vit pas au-delà", async () => {
    const { createShareSessionToken, verifySessionToken } = await import("@/lib/auth");
    const exp = Date.now() + DAY;
    const { token } = await createShareSessionToken("0123456789abcdef", "partage-01234567", "f".repeat(32), "jt", exp);
    const payload = await verifySessionToken(token);
    expect(payload).toMatchObject({ role: "share", sh: "0123456789abcdef", exp, jfToken: "jt" });
  });

  it("un rôle « share » sans lien, ou un lien sur un autre rôle, est refusé", async () => {
    const { verifySessionToken } = await import("@/lib/auth");
    // Signés à la main, avec la clé du module : seul le contenu est en cause.
    const crypto = await import("node:crypto");
    const { config } = await import("@/lib/config");
    const sign = (p: object) => {
      const body = Buffer.from(JSON.stringify(p)).toString("base64url");
      const sig = crypto.createHmac("sha256", config.app.sessionSecret).update(body).digest("base64url");
      return `${body}.${sig}`;
    };
    const exp = Date.now() + DAY;
    expect(await verifySessionToken(sign({ u: "x", role: "share", exp, jti: "j" }))).toBeNull();
    expect(await verifySessionToken(sign({ u: "x", role: "user", exp, jti: "j", sh: "0123456789abcdef" }))).toBeNull();
    expect(await verifySessionToken(sign({ u: "x", role: "share", exp, jti: "j", sh: "0123456789abcdef" }))).toMatchObject({ role: "share" });
  });
});

describe("les secrets du lien", () => {
  it("code et mot de passe : l'alphabet sans signes ambigus, le mot de passe tolère tirets, espaces et majuscules", async () => {
    const { newShareCode, newSharePassword, hashSharePassword, verifySharePassword, isShareCode } = await import("@/lib/share/store");
    for (let i = 0; i < 50; i++) {
      const code = newShareCode();
      expect(isShareCode(code)).toBe(true);
      expect(code).not.toMatch(/[01ilo]/);
      expect(newSharePassword()).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    }
    const pw = newSharePassword();
    const hash = hashSharePassword(pw);
    expect(hash).not.toContain(pw);
    expect(verifySharePassword(pw.toUpperCase().replace(/-/g, " "), hash)).toBe(true);
    expect(verifySharePassword("aaaa-aaaa-aaaa", hash)).toBe(false);
  });
});

describe("la vie d'un lien", () => {
  it("création : le compte Jellyfin, le nom nettoyé, le mot de passe haché, le compte du lien gardé chiffré", async () => {
    const { share, password } = await create();
    expect(share).toMatchObject({ kind: "movie", itemId: MOVIE, title: "Interstellar", label: "Paul", radarrId: 12, sonarrId: null, maxStreams: 3 });
    expect(share.expiresAt - share.createdAt).toBe(7 * DAY);
    const { getDb } = await import("@/lib/db");
    const row = getDb().prepare("SELECT password_hash, jf_password FROM shares WHERE id = ?").get(share.id) as { password_hash: string; jf_password: string };
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(password);
    expect(row.jf_password).toMatch(/^v1:/);
    expect(row.jf_password).not.toContain("secret-du-compte");
  });

  it("refuse un titre absent, un mauvais type, une durée ou un nom invalides — sans créer de compte", async () => {
    const { createShare, ShareError } = await import("@/lib/share/service");
    const base = { kind: "movie" as const, itemId: MOVIE, radarrId: null, sonarrId: null, label: "Paul", days: 7, createdBy: "louis", creatorJfId: null };
    await expect(createShare({ ...base, itemId: "c".repeat(32) })).rejects.toBeInstanceOf(ShareError);
    await expect(createShare({ ...base, kind: "series" })).rejects.toBeInstanceOf(ShareError);
    await expect(createShare({ ...base, days: 0 })).rejects.toBeInstanceOf(ShareError);
    await expect(createShare({ ...base, days: 400 })).rejects.toBeInstanceOf(ShareError);
    await expect(createShare({ ...base, label: " \n " })).rejects.toBeInstanceOf(ShareError);
    expect(account.created).toEqual([]);
  });

  it("entrée : le bon mot de passe ouvre une session `share` ; un mauvais, un code inconnu ou un lien fini, rien", async () => {
    const { share, password } = await create();
    const { redeemShare, revokeShare } = await import("@/lib/share/service");
    const { verifySessionFull } = await import("@/lib/session");
    const ctx = { ip: "1.2.3.4", device: "iPhone · Safari" };
    expect(await redeemShare(share.code, "aaaa-aaaa-aaaa", ctx)).toBeNull();
    expect(await redeemShare("zzzzzzzzzz", password, ctx)).toBeNull();
    const ok = await redeemShare(share.code, password, ctx);
    expect(ok).not.toBeNull();
    const session = await verifySessionFull(ok!.token);
    expect(session).toMatchObject({ role: "share", sh: share.id, exp: share.expiresAt, jfToken: "jeton-jellyfin" });

    // Révoqué : la session tombe à la requête suivante, et l'entrée est refusée.
    await revokeShare(share.id, "louis");
    expect(await verifySessionFull(ok!.token)).toBeNull();
    expect(await redeemShare(share.code, password, ctx)).toBeNull();
    expect(account.disabled).toEqual([[share.jfUserId, true]]);
  });

  it("un lien passé : session refusée, entrée refusée", async () => {
    const { share, password } = await create(1);
    const { redeemShare } = await import("@/lib/share/service");
    expect(await redeemShare(share.code, password, { ip: null, device: null }, share.expiresAt + 1)).toBeNull();
  });

  it("prolonger repart de la fin à venir, ou de maintenant ; rouvre le compte désactivé", async () => {
    const { share } = await create(1);
    const { extendShare, sweepShares } = await import("@/lib/share/service");
    const later = share.expiresAt + DAY;
    await sweepShares(later);
    expect(account.disabled).toEqual([[share.jfUserId, true]]);
    const extended = await extendShare(share.id, 7, "louis", later);
    expect(extended.expiresAt).toBe(later + 7 * DAY);
    expect(account.disabled.at(-1)).toEqual([share.jfUserId, false]);
    expect(extended.jfDisabledAt).toBeNull();
  });

  it("un lien révoqué ne se prolonge pas", async () => {
    const { share } = await create();
    const { extendShare, revokeShare, ShareError } = await import("@/lib/share/service");
    await revokeShare(share.id, "louis");
    await expect(extendShare(share.id, 7, "louis")).rejects.toBeInstanceOf(ShareError);
  });

  it("le passage régulier : désactivé à la fin, effacé un mois plus tard, jamais avant", async () => {
    const { share } = await create(1);
    const { sweepShares } = await import("@/lib/share/service");
    const { sharesDb } = await import("@/lib/share/store");
    await sweepShares(share.expiresAt - 1);
    expect(account.disabled).toEqual([]);
    await sweepShares(share.expiresAt + 1);
    expect(account.disabled).toEqual([[share.jfUserId, true]]);
    await sweepShares(share.expiresAt + 10 * DAY);
    expect(account.deleted).toEqual([]);
    await sweepShares(share.expiresAt + 31 * DAY);
    expect(account.deleted).toEqual([share.jfUserId]);
    expect(sharesDb.get(share.id)?.jfDeletedAt).not.toBeNull();
  });

  it("supprimer efface le compte et la ligne", async () => {
    const { share } = await create();
    const { deleteShare } = await import("@/lib/share/service");
    const { sharesDb } = await import("@/lib/share/store");
    expect(await deleteShare(share.id, "louis")).toBe(true);
    expect(account.deleted).toEqual([share.jfUserId]);
    expect(sharesDb.get(share.id)).toBeNull();
  });
});

describe("le compte Jellyfin du lien", () => {
  it("verrouillé : caché, une bibliothèque, sans téléchargement ni gestion, lecture et transcodage comme le foyer", async () => {
    const { sharePolicy } = await vi.importActual<typeof import("@/lib/share/jellyfinAccount")>("@/lib/share/jellyfinAccount");
    const policy = sharePolicy({ IsAdministrator: true, EnableAllFolders: true, EnableContentDownloading: true, BlockedTags: ["prive"], AuthenticationProviderId: "x" }, ["lib1"]);
    expect(policy).toMatchObject({
      IsAdministrator: false,
      IsHidden: true,
      EnableAllFolders: false,
      EnabledFolders: ["lib1"],
      EnableContentDownloading: false,
      EnableSubtitleManagement: false,
      EnablePublicSharing: false,
      EnableRemoteControlOfOtherUsers: false,
      EnableMediaPlayback: true,
      EnableVideoPlaybackTranscoding: true,
      AuthenticationProviderId: "x",
    });
  });

  it("n'apparaît dans aucune liste de comptes du foyer", async () => {
    const { share } = await create();
    const { withoutShareAccounts } = await import("@/lib/share/accounts");
    const kept = withoutShareAccounts([{ Id: share.jfUserId, Name: "renommé" }, { Id: "1".repeat(32), Name: "partage-0a1b2c3d" }, { Id: "2".repeat(32), Name: "augustine" }]);
    expect(kept.map((u) => u.Name)).toEqual(["augustine"]);
  });
});

describe("trois lectures en même temps", () => {
  it("la quatrième ouverture est refusée ; une reprise sur un appareil qui joue passe toujours", async () => {
    const { share } = await create();
    const { recordPlaybackBeat, __testing } = await import("@/lib/activity/presence");
    const { shareStreamRefusal } = await import("@/lib/share/guard");
    __testing.reset();
    const user = share.jfUserName!;
    const now = Date.now();
    for (const jti of ["a", "b", "c"]) recordPlaybackBeat(jti, { user, jfId: null, at: now, visible: true, itemId: MOVIE, device: null });
    const session = { role: "share" as const, sh: share.id, jfUser: user, u: user };
    expect(shareStreamRefusal({ ...session, jti: "d" }, now)?.status).toBe(429);
    expect(shareStreamRefusal({ ...session, jti: "a" }, now)).toBeNull();
    // Deux minutes et demie sans battement : ces lectures ne comptent plus.
    expect(shareStreamRefusal({ ...session, jti: "d" }, now + 151_000)).toBeNull();
    // Un compte du foyer ne passe jamais par là.
    expect(shareStreamRefusal({ role: "user", jti: "z", u: "louis" }, now)).toBeNull();
  });
});
