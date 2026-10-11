import { describe, it, expect } from "vitest";
import { RetryLedger, positionBucket, retryMotif, retrySignature, PROGRESS_PROOF_SECONDS } from "@/lib/retryLedger";
import { SessionTally } from "@/lib/playerSessionTally";

// Le registre des tentatives (DECISIONS §67), en observation : il compte les tentatives qui en
// rejouent une déjà échouée sans que le film ait joué entre-temps.

describe("signatures", () => {
  it("le motif sans ses numéros d'essai ni son détail, la configuration triée", () => {
    expect(retryMotif("la source a été perdue (2), au-delà de 123.4 s qui vient d'échouer")).toBe("la source a été perdue");
    expect(retryMotif("copie AAC à PCE refusée — Le navigateur a refusé")).toBe("copie AAC à PCE refusée");
    expect(retrySignature("élément : code 4", { pos: 120, codecs: "-", transcode: false })).toBe("élément : code 4|codecs=-|pos=120|transcode=false");
    expect(retrySignature("x", { a: undefined, b: 1 })).toBe("x|b=1");
  });

  it("la position par dizaine de secondes", () => {
    expect(positionBucket(0)).toBe(0);
    expect(positionBucket(129.9)).toBe(120);
    expect(positionBucket(130)).toBe(130);
    expect(positionBucket(undefined)).toBeNull();
    expect(positionBucket(Number.NaN)).toBeNull();
  });
});

describe("le registre", () => {
  it("une tentative identique est comptée, une différente non", () => {
    const ledger = new RetryLedger();
    const a = retrySignature("élément : code 4", { pos: 120 });
    const b = retrySignature("élément : code 4", { pos: 130 });
    expect(ledger.mayRetry(a)).toBe(true);
    expect(ledger.noteFailure(a)).toBe(1);
    expect(ledger.mayRetry(a)).toBe(false);
    expect(ledger.noteFailure(b)).toBe(1);
    expect(ledger.noteFailure(a)).toBe(2);
    expect(ledger.summary()).toEqual({ identicalRetries: 1, retryMotif: "élément : code 4" });
  });

  it("trois secondes jouées en continu effacent les échecs ; un saut ne prouve rien", () => {
    const ledger = new RetryLedger();
    const a = retrySignature("hls.js : média", { pos: 10 });
    ledger.noteFailure(a);
    ledger.notePosition(10);
    ledger.notePosition(500); // un saut : rien de joué
    expect(ledger.mayRetry(a)).toBe(false);
    for (let t = 500.5; t <= 500 + PROGRESS_PROOF_SECONDS + 0.5; t += 0.5) ledger.notePosition(t);
    expect(ledger.mayRetry(a)).toBe(true);
    // Le décompte des répétitions passées reste au bilan.
    ledger.noteFailure(a);
    expect(ledger.summary()).toEqual({});
  });

  it("rien au bilan tant que rien ne s'est répété — le stop garde son budget de champs", () => {
    const tally = new SessionTally();
    expect(tally.summary(0)).not.toHaveProperty("identicalRetries");
    tally.retries.noteFailure("m|pos=0");
    tally.retries.noteFailure("m|pos=0");
    expect(tally.summary(0)).toMatchObject({ identicalRetries: 1, retryMotif: "m" });
  });
});
