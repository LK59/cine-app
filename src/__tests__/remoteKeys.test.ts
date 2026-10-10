// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { installRemoteKeyShim, needsTranslation, normalizeKey } from "@/lib/remoteKeys";

// Les touches d'une télécommande ramenées aux noms que le cinéma lit (Fire TV, 10/10/2026).

describe("normalizeKey", () => {
  it("garde un nom moderne tel quel", () => {
    expect(normalizeKey({ key: "ArrowDown", keyCode: 40 })).toBe("ArrowDown");
    expect(normalizeKey({ key: "Enter" })).toBe("Enter");
    expect(needsTranslation({ key: "ArrowDown", keyCode: 40 })).toBeNull();
  });

  it("traduit les anciens noms", () => {
    expect(normalizeKey({ key: "Down" })).toBe("ArrowDown");
    expect(normalizeKey({ key: "Up" })).toBe("ArrowUp");
    expect(normalizeKey({ key: "Esc" })).toBe("Escape");
    expect(needsTranslation({ key: "Left" })).toBe("ArrowLeft");
  });

  it("lit le keyCode quand le nom manque ou n'est pas identifié", () => {
    expect(normalizeKey({ key: "", keyCode: 40 })).toBe("ArrowDown");
    expect(normalizeKey({ key: "Unidentified", keyCode: 37 })).toBe("ArrowLeft");
    expect(normalizeKey({ key: "", keyCode: 13 })).toBe("Enter");
    expect(normalizeKey({ key: "", keyCode: 23 })).toBe("Enter");
    expect(normalizeKey({ key: "", keyCode: 179 })).toBe("MediaPlayPause");
    expect(normalizeKey({ key: "", keyCode: 227 })).toBe("MediaRewind");
    expect(normalizeKey({ key: "", which: 228 })).toBe("MediaFastForward");
  });

  it("ne traduit pas la touche Retour de la Fire TV : Silk en fait déjà un retour d'historique", () => {
    expect(normalizeKey({ key: "", keyCode: 4 })).toBeNull();
  });
});

describe("installRemoteKeyShim", () => {
  let remove: (() => void) | null = null;
  afterEach(() => {
    remove?.();
    remove = null;
    document.body.innerHTML = "";
  });

  // La touche telle qu'une télécommande la donnerait ; jsdom ne permet pas de fixer `keyCode` au constructeur.
  function trusted(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(e, "keyCode", { value: init.keyCode });
    return e;
  }

  it("réémet une touche sans nom sous son nom moderne, et l'originale n'atteint personne", () => {
    remove = installRemoteKeyShim();
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", listener);
    document.body.dispatchEvent(trusted({ key: "", keyCode: 40 }));
    window.removeEventListener("keydown", listener);
    expect(seen).toEqual(["ArrowDown"]);
  });

  it("laisse passer une touche déjà bien nommée", () => {
    remove = installRemoteKeyShim();
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", listener);
    document.body.dispatchEvent(trusted({ key: "ArrowDown", keyCode: 40 }));
    window.removeEventListener("keydown", listener);
    expect(seen).toEqual(["ArrowDown"]);
  });

  it("un Entrée réémis que personne ne prend clique l'élément focalisé, comme l'aurait fait l'original", () => {
    remove = installRemoteKeyShim();
    const button = document.createElement("button");
    const click = vi.fn();
    button.addEventListener("click", click);
    document.body.appendChild(button);
    button.focus();
    button.dispatchEvent(trusted({ key: "", keyCode: 23 }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("un Entrée réémis pris en charge ne clique rien de plus", () => {
    remove = installRemoteKeyShim();
    const button = document.createElement("button");
    const click = vi.fn();
    button.addEventListener("click", click);
    button.addEventListener("keydown", (e) => e.preventDefault());
    document.body.appendChild(button);
    button.focus();
    button.dispatchEvent(trusted({ key: "Select" }));
    expect(click).not.toHaveBeenCalled();
  });
});
