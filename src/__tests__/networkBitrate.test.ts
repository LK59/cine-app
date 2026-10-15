import { describe, it, expect, afterEach } from "vitest";
import { pickMaxBitrate } from "@/lib/networkBitrate";

const original = globalThis.navigator;

function withConnection(connection: { effectiveType?: string; downlink?: number } | undefined) {
  Object.defineProperty(globalThis, "navigator", {
    value: connection === undefined ? {} : { connection },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { value: original, configurable: true, writable: true });
});

/**
 * Le fichier le plus lourd de la bibliothèque, relevé sur les 499 sources réelles. C'est lui qui
 * définit ce que « le plafond ne refuse rien » veut dire : au-dessus, plus aucun fichier existant
 * ne peut être écarté du DirectPlay sur son seul débit.
 */
const HEAVIEST_LIBRARY_FILE = 38_400_000;

describe("pickMaxBitrate", () => {
  // Safari n'expose pas navigator.connection : tous les iPhone et iPad du foyer passent par là,
  // et l'absence d'information ne doit jamais être lue comme une information de lenteur.
  it("ne bride rien quand le navigateur ne dit rien du réseau", () => {
    withConnection(undefined);
    expect(pickMaxBitrate()).toBeGreaterThan(HEAVIEST_LIBRARY_FILE);
  });

  // Le défaut corrigé : un téléphone sur le wifi recevait le même plafond qu'en 4G, parce que
  // seule la largeur de son écran était consultée.
  it("ne bride rien sur un lien rapide, quelle que soit la taille de l'écran", () => {
    withConnection({ effectiveType: "4g", downlink: 10 });
    expect(pickMaxBitrate()).toBeGreaterThan(HEAVIEST_LIBRARY_FILE);
  });

  // `downlink` sature à 10 : au plafond de l'API, c'est « au moins dix », pas une mesure.
  it("lit downlink = 10 comme une saturation, pas comme une mesure", () => {
    withConnection({ effectiveType: "4g", downlink: 10 });
    expect(pickMaxBitrate()).toBeGreaterThan(10_000_000);
  });

  // LECTEUR-10 (15/10/2026) : 22 % des séances Chrome/Edge/Android annonçaient un `downlink` sous 10
  // (1,45 ; 1,55 ; 4,8…) sur des liens que le lecteur natif mesurait à 15–110 Mb/s. Lu comme une
  // mesure, il bridait un fichier de 2,5 Mb/s à 1,5 Mb/s en 720p. `downlink` n'est plus jamais lu.
  it("ne lit jamais downlink comme une mesure, même sous la saturation", () => {
    for (const downlink of [8, 4.8, 1.55, 1.45, 0.5]) {
      withConnection({ effectiveType: "4g", downlink });
      expect(pickMaxBitrate()).toBeGreaterThan(HEAVIEST_LIBRARY_FILE);
    }
  });

  // La médiane de la bibliothèque : la moitié des films passe intacte sur un lien de cette classe.
  it("retombe sur la médiane de la bibliothèque en 3g sans mesure", () => {
    withConnection({ effectiveType: "3g" });
    expect(pickMaxBitrate()).toBe(6_400_000);
  });

  it("descend sous tout ce que contient la bibliothèque en 2g", () => {
    withConnection({ effectiveType: "2g", downlink: 0.4 });
    expect(pickMaxBitrate()).toBe(1_500_000);
    withConnection({ effectiveType: "slow-2g", downlink: 0.05 });
    expect(pickMaxBitrate()).toBe(1_500_000);
  });

  // Seule la classe compte : un `downlink` minuscule ne fait pas descendre un lien « 3g » sous sa classe.
  it("garde la classe 3g quel que soit downlink", () => {
    withConnection({ effectiveType: "3g", downlink: 0.5 });
    expect(pickMaxBitrate()).toBe(6_400_000);
  });

  it("ignore une valeur de downlink inexploitable", () => {
    withConnection({ effectiveType: "4g", downlink: Number.NaN });
    expect(pickMaxBitrate()).toBeGreaterThan(HEAVIEST_LIBRARY_FILE);
  });
});
