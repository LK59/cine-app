import { describe, it, expect, vi } from "vitest";
import { CastProgressRelay } from "@/lib/castProgress";

// Chasse aux bugs zone 1 (11/10/2026) — relais de reprise du serveur (§64). Ces tests ÉCHOUENT sur le
// code actuel : chacun décrit un défaut prouvé, à corriger avant de les garder.

const JF = "jf-louis";
const ITEM = "a".repeat(32);
const S = 1000;

function segment(index: number, startSeconds: number) {
  return {
    jfId: JF,
    user: "louis",
    itemId: ITEM,
    restPath: `hls1/main/${index}.mp4`,
    search: new URLSearchParams(`runtimeTicks=${Math.round(startSeconds * 10_000_000)}&castToken=t`),
  };
}

function relay() {
  const save = vi.fn(async (..._args: unknown[]) => "position");
  const log = vi.fn();
  return { r: new CastProgressRelay({ save, log }), save, log };
}

describe("bughunt zone 1 — la cadence de pause de la page n'est pas « page muette »", () => {
  it("une page en pause bat toutes les 60–70 s (usePlaybackSession) : le relais ne doit jamais parler entre deux battements", () => {
    // Le lecteur serveur dans la page charge `castUrl` (PlayerHost : `data.castUrl ?? data.manifestUrl`),
    // donc chaque segment qu'il demande porte un laissez-passer et passe par `noteCastSegment` — même
    // sans aucune diffusion. En pause, `usePlaybackSession` ne rapporte qu'une fois la minute, sur un
    // minuteur de 10 s : 60 à 70 s entre deux battements, alors que PAGE_FRESH_MS vaut 60 s.
    const { r, save } = relay();
    r.notePageReport(JF, ITEM, 0); // passage en pause, rapporté aussitôt
    // Safari (ou le récepteur) continue de remplir son tampon après la pause.
    r.noteCastSegment(segment(40, 160), 62 * S); // 62 s : le battement suivant n'est pas encore parti
    r.notePageReport(JF, ITEM, 70 * S); // battement de pause, à 70 s
    expect(save).not.toHaveBeenCalled();
  });

  it("une page restée ouverte en pause, tampon plein : aucun « arrêt » ne doit être rapporté à Jellyfin", () => {
    const { r, save } = relay();
    // Diffusion en cours, page vivante (rapports toutes les 10 s)…
    for (let t = 0; t <= 100; t += 10) r.notePageReport(JF, ITEM, t * S);
    r.noteCastSegment(segment(30, 120), 61 * S + 100 * S); // un segment pendant une fenêtre de battement
    // …puis la pause : battements de pause à 160 et 230 s (le suivant partira vers 296–300 s) ;
    // plus aucun segment (tampon plein).
    r.notePageReport(JF, ITEM, 160 * S);
    r.notePageReport(JF, ITEM, 230 * S);
    // Ménage à 296 s : dernier battement à 230 s (66 s), dernier segment à 161 s (135 s).
    r.sweep(296 * S);
    expect(save.mock.calls.filter((c) => c[2] === "stop")).toEqual([]);
  });
});

describe("bughunt zone 1 — un arrêt périmé après le retour de la page", () => {
  it("relais lancé, puis la page reprend la main et lit en local : son arrêt ne doit pas être écrasé par la vieille position du téléviseur", () => {
    const { r, save } = relay();
    // iPhone verrouillé pendant AirPlay : la page se tait, le téléviseur lit de 0 à 200 s.
    for (let t = 0; t <= 200; t += 4) r.noteCastSegment(segment(t / 4, t + 30), t * S);
    expect(save).toHaveBeenCalled(); // le relais a pris le relais (normal)
    save.mockClear();
    // Déverrouillé : « Reprendre sur cet appareil », le film continue en local de 200 s à 500 s,
    // la page rapporte toutes les 10 s ; le téléviseur ne demande plus rien.
    for (let t = 205; t <= 500; t += 10) r.notePageReport(JF, ITEM, t * S);
    // La page ferme à 500 s (son arrêt, avec la bonne position, est parti par la route `stop`).
    r.notePageReport(JF, ITEM, 500 * S);
    // Le ménage suivant, une minute plus tard : le relais rapporte un « arrêt » à ~200 s.
    r.sweep(561 * S);
    expect(save.mock.calls.filter((c) => c[2] === "stop")).toEqual([]);
  });
});
