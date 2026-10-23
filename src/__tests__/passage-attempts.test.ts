import { describe, it, expect, beforeEach } from "vitest";
import {
  PASSAGE_CODE_FAILURES_GLOBAL,
  PASSAGE_FAILURES_PER_ADDRESS,
  notePassageFailure,
  passageBlocked,
  resetPassageAttempts,
} from "@/lib/passage/attempts";
import { rateKey } from "@/lib/rateLimiter";

/**
 * Le frein de l'entrée du passage (DECISIONS.md §119), relu le 23/10/2026 : à cent échecs globaux,
 * un anonyme fermait l'entrée par code au foyer entier ; et une IPv6 comptée par /64 laissait à un
 * abonné d'un /48 65 536 adresses neuves.
 */
beforeEach(() => resetPassageAttempts());

const NOW = 1_800_000_000_000;

describe("plafond global des codes", () => {
  it("vaut 2 000 échecs en quinze minutes : le 1 999e ne bloque pas, le 2 000e oui — les jetons jamais", () => {
    expect(PASSAGE_CODE_FAILURES_GLOBAL).toBe(2000);
    // Des adresses toutes différentes : seul le plafond global peut jouer.
    for (let i = 0; i < 1999; i++) notePassageFailure(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, "code", NOW);
    expect(passageBlocked("192.0.2.1", "code", NOW)).toBe(false);
    notePassageFailure("10.200.0.1", "code", NOW);
    expect(passageBlocked("192.0.2.1", "code", NOW)).toBe(true);
    expect(passageBlocked("192.0.2.1", "token", NOW)).toBe(false);
    // Et la fenêtre passée, l'entrée rouvre.
    expect(passageBlocked("192.0.2.1", "code", NOW + 15 * 60_000)).toBe(false);
  });
});

describe("limite par adresse", () => {
  it("une IPv6 compte par son /48 : changer de /64 dans le même /48 ne remet pas le compteur à zéro", () => {
    expect(rateKey("2001:db8:1:2::1", 48)).toBe("2001:db8:1::/48");
    expect(rateKey("2001:db8:1:ffff::9", 48)).toBe(rateKey("2001:db8:1:2::1", 48));
    expect(rateKey("2001:db8:2::1", 48)).not.toBe(rateKey("2001:db8:1::1", 48));
    for (let i = 0; i < PASSAGE_FAILURES_PER_ADDRESS; i++) notePassageFailure(`2001:db8:1:${i.toString(16)}::1`, "token", NOW);
    expect(passageBlocked("2001:db8:1:abcd::7", "token", NOW)).toBe(true);
    expect(passageBlocked("2001:db8:2::7", "token", NOW)).toBe(false);
  });

  it("une IPv4 reste comptée telle quelle", () => {
    for (let i = 0; i < PASSAGE_FAILURES_PER_ADDRESS; i++) notePassageFailure("192.0.2.7", "code", NOW);
    expect(passageBlocked("192.0.2.7", "code", NOW)).toBe(true);
    expect(passageBlocked("192.0.2.8", "code", NOW)).toBe(false);
  });
});
