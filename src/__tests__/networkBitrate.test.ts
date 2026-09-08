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

  it("suit la mesure quand elle est sous le plafond de l'API", () => {
    withConnection({ effectiveType: "4g", downlink: 8 });
    expect(pickMaxBitrate()).toBe(6_000_000);
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

  // Un plafond au ras du sol ne rend aucun service : il rend la lecture impossible proprement.
  it("ne descend jamais sous le plancher, même sur une mesure minuscule", () => {
    withConnection({ effectiveType: "3g", downlink: 0.5 });
    expect(pickMaxBitrate()).toBe(1_500_000);
  });

  it("ignore une valeur de downlink inexploitable", () => {
    withConnection({ effectiveType: "4g", downlink: Number.NaN });
    expect(pickMaxBitrate()).toBeGreaterThan(HEAVIEST_LIBRARY_FILE);
  });
});
