// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { holdsUnsavedText } from "@/lib/staleBuild";

/**
 * Un texte tapé et laissé là, le temps d'aller chercher une capture dans une autre application :
 * le rechargement du retour le perdait (25/09/2026).
 */
afterEach(() => {
  document.body.innerHTML = "";
});

function field(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("un texte non envoyé", () => {
  it("se voit dans une zone de texte ou un champ, même sans le curseur dedans", () => {
    const area = field("<textarea></textarea>") as HTMLTextAreaElement;
    area.value = "Le son décroche au bout de dix minutes";
    expect(holdsUnsavedText(area)).toBe(true);
    const input = field('<input type="text">') as HTMLInputElement;
    input.value = "Dune";
    expect(holdsUnsavedText(input)).toBe(true);
  });

  it("cesse de compter quand le formulaire se vide ou se ferme", () => {
    const area = field("<textarea></textarea>") as HTMLTextAreaElement;
    area.value = "   ";
    expect(holdsUnsavedText(area)).toBe(false);
    area.value = "envoyé";
    area.remove();
    expect(holdsUnsavedText(area)).toBe(false);
  });

  it("ne compte ni une case, ni un curseur, ni un fichier", () => {
    for (const type of ["checkbox", "range", "file"]) {
      expect(holdsUnsavedText(field(`<input type="${type}">`))).toBe(false);
    }
  });

  it("compte un texte éditable", () => {
    const editable = field('<div contenteditable="true">brouillon</div>');
    // jsdom ne calcule pas isContentEditable : on le lui dit, comme le ferait un navigateur.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(holdsUnsavedText(editable)).toBe(true);
  });
});
