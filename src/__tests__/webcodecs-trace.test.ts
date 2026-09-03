import { describe, expect, it, beforeEach } from "vitest";
import { trace, traceKeepAcrossReset, traceReset, traceSteps, traceText } from "@/lib/webcodecs/trace";
import { buildReport } from "@/components/ExperimentalPlayerReport";

describe("trace", () => {
  beforeEach(() => traceReset());

  it("keeps the steps in order, with the time each happened", () => {
    trace("un");
    trace("deux");
    const steps = traceSteps();
    expect(steps.map((s) => s.step)).toEqual(["un", "deux"]);
    expect(steps[0].at).toBeGreaterThanOrEqual(0);
    expect(steps[1].at).toBeGreaterThanOrEqual(steps[0].at);
  });

  it("stops growing, so a loop cannot fill memory with its own symptoms", () => {
    for (let i = 0; i < 1000; i++) trace(`étape ${i}`);
    expect(traceSteps().length).toBeLessThanOrEqual(300);
  });

  it("forgets the previous attempt when a new one starts", () => {
    trace("de l'essai précédent");
    traceReset();
    expect(traceText()).toBe("(aucune étape enregistrée)");
  });
});

describe("buildReport", () => {
  const input = {
    error: "Le navigateur a refusé une opération sur le tampon.",
    elapsedMs: 4200,
    title: "Utopia S01E01",
    itemId: "abc",
    file: { container: "mkv", streamUrl: "https://example/Videos/abc?api_key=SECRET" },
    pathReason: "remultiplexage → lecteur natif",
    diagnostics: { "Tampon vidéo": "vide" },
  };

  it("carries the failure, the decision and the pipeline's own reading", () => {
    const text = buildReport(input, { "AAC 6 canaux": "oui" });
    expect(text).toContain("Le navigateur a refusé une opération sur le tampon.");
    expect(text).toContain("remultiplexage → lecteur natif");
    expect(text).toContain("Tampon vidéo: vide");
    expect(text).toContain("AAC 6 canaux: oui");
    expect(text).toContain("4.2 s");
  });

  it("leaves the stream URL out: this text is written to be pasted somewhere", () => {
    const text = buildReport(input, null);
    expect(text).not.toContain("SECRET");
    expect(text).toContain("container: mkv");
  });

  it("says so plainly when nothing failed and the wait simply never ended", () => {
    expect(buildReport({ ...input, error: null }, null)).toContain("le chargement n'aboutit pas");
  });
});

describe("traceKeepAcrossReset", () => {
  it("carries the record through the rebuild that follows a lost source", () => {
    // The player rebuilds itself when the platform takes the source away, and rebuilding runs the
    // probe again, which starts a new record. Without this the fault and its aftermath land in
    // different accounts and the report shows the innocent one.
    traceReset();
    trace("la source a été fermée");
    traceKeepAcrossReset();
    traceReset();
    expect(traceText()).toContain("la source a été fermée");

    // And only the once: the next fresh start is a fresh start.
    traceReset();
    expect(traceText()).toBe("(aucune étape enregistrée)");
  });
});
