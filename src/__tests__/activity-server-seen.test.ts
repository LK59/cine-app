import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: {} }));

import { serverSeenAt } from "@/lib/activity/accounts";

/**
 * « Jellyfin ne le voit plus » (07/10/2026) : Jellyfin ne bouge la dernière activité d'un compte qu'à
 * une connexion ou une lecture ; le dernier usage d'un appareil, lui, à chaque requête de son jeton.
 */
describe("la dernière fois que Jellyfin a vu un compte", () => {
  const charlotte = { Id: "u1", Name: "charlotte", LastActivityDate: "2026-09-29T14:03:00Z" } as never;

  it("prend le dernier usage de son appareil CineApp, plus récent que sa dernière lecture", () => {
    const devices = [
      { Id: "d1", AppName: "CineApp", LastUserId: "u1", DateLastActivity: "2026-10-07T07:03:00Z" },
      { Id: "d2", AppName: "CineApp", LastUserId: "autre", DateLastActivity: "2026-10-07T09:00:00Z" },
    ];
    expect(serverSeenAt(charlotte, devices)).toBe(Date.parse("2026-10-07T07:03:00Z"));
  });

  it("retombe sur la date du compte sans appareils connus", () => {
    expect(serverSeenAt(charlotte, null)).toBe(Date.parse("2026-09-29T14:03:00Z"));
  });
});
