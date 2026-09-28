import { describe, it, expect } from "vitest";
import { CastResume } from "@/lib/castResume";
import { castEstablishedFields, castResumeFields } from "@/lib/serverPlayerLog";

/**
 * La reprise reposée sur le téléviseur (28/09/2026) : *Ted Lasso* S01E05, relais demandé à 1246 s,
 * diffusion établie avant que l'élément n'ait pris sa reprise, télé repartie du début.
 */
describe("CastResume", () => {
  it("rend la cible quand la télé est repartie d'ailleurs, une seule fois", () => {
    const resume = new CastResume();
    resume.planned(1246);
    expect(resume.pending).toBe(1246);
    expect(resume.take(0.4)).toBe(1246);
    expect(resume.take(0.4)).toBeNull();
  });

  it("n'y touche pas quand la reprise a tenu", () => {
    const resume = new CastResume();
    resume.planned(586);
    // L'élément se montre à la reprise (loadeddata l'a posée) : oubliée.
    resume.observed(587.2);
    expect(resume.pending).toBeNull();
    expect(resume.take(620)).toBeNull();
    // Posée au moment même où la télé joue : rien à refaire non plus.
    resume.planned(586);
    expect(resume.take(586.1)).toBeNull();
  });

  it("rien à surveiller pour une lecture depuis le début", () => {
    const resume = new CastResume();
    resume.planned(0);
    expect(resume.pending).toBeNull();
    resume.planned(undefined);
    expect(resume.take(0)).toBeNull();
  });

  it("une position loin de la cible ne l'efface pas", () => {
    const resume = new CastResume();
    resume.planned(1246);
    resume.observed(0);
    expect(resume.pending).toBe(1246);
  });
});

describe("les lignes de diffusion", () => {
  const ctx = { itemId: "x", title: "Ted Lasso", session: "s1" } as never;
  it("disent la reprise encore attendue, et celle reposée", () => {
    expect(castEstablishedFields(ctx, 0, 1246.1)).toMatchObject({ reason: "diffusion établie", at: 0, resumeAt: 1246 });
    expect(castEstablishedFields(ctx, 622)).not.toHaveProperty("resumeAt");
    expect(castResumeFields(ctx, 3.2, 1246.1)).toMatchObject({ cast: true, reason: "reprise reposée sur le téléviseur", at: 3, resumeAt: 1246 });
  });
});
