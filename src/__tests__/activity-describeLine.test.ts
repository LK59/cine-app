import { describe, it, expect } from "vitest";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import { describeLine, fullDate, kindTone } from "@/components/activity/parts";

/**
 * Les résumés d'une ligne de journal (14/10/2026). `describeLine` est le seul endroit qui dit une
 * ligne en une phrase — la vue Journaux, la chronologie d'une séance et les journaux figés d'un
 * signalement le partagent. Les lignes ci-dessous sont recopiées des vrais journaux (agent, build et
 * identifiants retirés) : un champ renommé à l'écriture doit casser ici, pas sur l'écran de Louis.
 */
const tFr = createT(fr as Record<string, unknown>, fr as Record<string, unknown>, "fr");
const tEn = createT(en as Record<string, unknown>, fr as Record<string, unknown>, "en");

describe("describeLine — lecteur", () => {
  it("opening : chemin, première image, d'où", () => {
    const line = { kind: "opening", path: "remux", firstMoveMs: 2684, openedFrom: "appareil" };
    expect(describeLine(line, tFr)).toBe("Démarrage · remux · image en 2.7 s · depuis l'appareil");
  });

  it("start : d'où le début est venu, quand le journal le dit", () => {
    expect(describeLine({ kind: "start", at: 0, path: "remux", openedInMs: 777, openedFrom: "réseau" }, tFr)).toBe("Ouverture à 0:00 · remux · prêt en 777 ms · depuis le réseau");
  });

  it("fluidite : sonde, images, longues, pire, p95", () => {
    const line = { kind: "fluidite", probe: "movies", items: 800, frames: 442, longFrames: 31, worstMs: 76, p95Ms: 26 };
    expect(describeLine(line, tFr)).toBe("Sonde movies · 442 images, 31 longues · pire 76 ms · p95 26 ms");
  });

  it("subtitle-gen du lecteur : événement et langue cible", () => {
    expect(describeLine({ kind: "subtitle-gen", event: "première-ligne", target: "es", ms: 4487 }, tFr)).toBe("Sous-titres générés : première-ligne · es · 4.5 s");
  });

  it("network : où et pourquoi", () => {
    expect(describeLine({ kind: "network", at: 858.2, reason: "NetworkUnavailable: Failed to fetch" }, tFr)).toBe("Réseau à 14:18 : NetworkUnavailable: Failed to fetch");
  });

  it("reserve : l'erreur et l'arrêt, sans chiffres vides", () => {
    expect(describeLine({ kind: "reserve", event: "erreur", message: "Load failed", failures: 2, backoffS: 10 }, tFr)).toBe("Réserve : échec (Load failed) · essai 2, reprise dans 10 s");
    expect(describeLine({ kind: "reserve", event: "arrêt", why: "fin du pipeline", netMB: 0, bursts: 0 }, tFr)).toBe("Réserve arrêtée (fin du pipeline)");
    expect(describeLine({ kind: "reserve", event: "arrêt", why: "session partie", netMB: 152.4, bursts: 3 }, tFr)).toBe("Réserve arrêtée (session partie) · 152 Mo · 3 rafales");
  });
});

describe("describeLine — le bilan d'une séance (stop)", () => {
  // Une ligne de Lucas du 14/10/2026 : bilan perdu par iOS, renvoyé au lancement suivant.
  const lost = {
    kind: "stop", why: "lost", at: 4415.745, watched: 568, waits: 0, longestWaitMs: 0, seeks: 4,
    "diag.linkVerdict": "suffisante", "diag.reserveNetMB": 404, "diag.reserveBursts": 5,
  };

  it("le motif traduit, le temps regardé, les sauts, le lien et la réserve", () => {
    expect(describeLine(lost, tFr)).toBe("Fin (bilan perdu, renvoyé) · 9 min regardé · arrêt à 1:13:35 · 4 sauts · lien suffisant · réserve 404 Mo en 5 rafales");
    expect(describeLine(lost, tEn)).toBe("End (lost summary, resent) · 9 min watched · stopped at 1:13:35 · 4 seeks · link sufficient · reserve 404 MB in 5 bursts");
  });

  it("chaque motif connu est traduit ; un motif inconnu reste tel quel", () => {
    for (const [why, label] of [["close", "fermé"], ["next", "épisode suivant"], ["page", "page quittée"], ["unmount", "lecteur remplacé"]]) {
      expect(describeLine({ kind: "stop", why, watched: 60, at: 60 }, tFr)).toContain(`Fin (${label})`);
    }
    expect(describeLine({ kind: "stop", why: "veille", watched: 60, at: 60 }, tFr)).toContain("Fin (veille)");
  });

  it("les attentes, la version allégée et le choix de l'écran lent, seulement quand ils existent", () => {
    const slow = { kind: "stop", why: "close", watched: 300, at: 300, waits: 3, longestWaitMs: 4200, quality: "auto", lighterMbps: 1.5, slowChoice: "réessayer", "diag.linkVerdict": "trop lente" };
    expect(describeLine(slow, tFr)).toBe("Fin (fermé) · 5 min regardé · arrêt à 5:00 · 3 attentes (max 4.2 s) · lien trop lent · version allégée 1.5 Mb/s · écran « lent » : réessayer");
    // Une lecture sans histoire garde sa ligne courte : verdict « inconnue » et choix « aucun » muets.
    const quiet = { kind: "stop", why: "close", watched: 977, at: 2542, waits: 0, seeks: 0, slowChoice: "aucun", "diag.linkVerdict": "inconnue" };
    expect(describeLine(quiet, tFr)).toBe("Fin (fermé) · 16 min regardé · arrêt à 42:22");
  });

  it("les relances du lecteur serveur restent comptées", () => {
    expect(describeLine({ kind: "stop", why: "close", watched: 60, at: 60, restarts: 2 }, tFr)).toBe("Fin (fermé) · 1 min regardé · arrêt à 1:00 · 2 relances");
  });
});

describe("describeLine — connexions, notifications, ouvertures, sous-titres générés", () => {
  it("auth : appareil, adresse, raison d'un refus", () => {
    expect(describeLine({ kind: "login", user: "mathis", ip: "172.226.208.55", device: "iPhone · Safari", role: "user" }, tFr)).toBe("Connexion · iPhone · Safari · 172.226.208.55");
    expect(describeLine({ kind: "login", user: "louis", ip: "10.0.0.2", device: "Mac · Safari", role: "admin" }, tFr)).toBe("Connexion · admin · Mac · Safari · 10.0.0.2");
    expect(describeLine({ kind: "login-failed", user: "x", ip: "172.20.0.247", device: "Linux · Chrome", reason: "mot de passe refusé" }, tFr)).toBe("Refusée · mot de passe refusé · Linux · Chrome · 172.20.0.247");
    expect(describeLine({ kind: "logout", user: "louis", ip: "172.20.0.248", device: "Linux · Chrome" }, tFr)).toBe("Déconnexion · Linux · Chrome · 172.20.0.248");
    expect(describeLine({ kind: "token-refused", user: "augustine" }, tFr)).toBe("Jeton refusé par le serveur média — session fermée");
    expect(describeLine({ kind: "closed-by-admin", user: "sarah", count: 1, by: "louis" }, tFr)).toBe("1 session fermée par louis");
    expect(describeLine({ kind: "new-account-tags", user: "nouveau", tags: ["prive"] }, tFr)).toBe("Tags posés : prive");
  });

  it("notification : le texte, les destinataires et ce qu'il en est advenu", () => {
    const line = {
      kind: "request-available", category: "request-available", title: "Disponible", body: "Le Grinch est disponible",
      recipients: [
        { user: "louis", sent: 2, failed: 0, removed: 0, muted: false },
        { user: "lucas", sent: 0, failed: 1, removed: 1, muted: false },
        { user: "sarah", sent: 0, failed: 0, removed: 0, muted: true },
      ],
    };
    expect(describeLine(line, tFr)).toBe("Le Grinch est disponible · 3 destinataires · 2 envois · 1 échec · 1 abonnement retiré · 1 en sourdine");
  });

  it("ouverture du cinéma : cache, catalogue, réseau, Reprendre, corrections, appareil", () => {
    const line = {
      kind: "ouverture", user: "louis", cacheUsed: true, cacheAgeMs: 52294761, cacheMs: 743, networkMs: 1692, bootMs: 655, idbMs: 88,
      resumeNetworkMs: 1804, resumeFromCache: true, resumeAdded: 0, resumeRemoved: 0, resumeMoved: 0, resumeProgressed: 0,
      usageMB: 129.3, resumeMB: 114.7, resumeTitles: 6,
    };
    expect(describeLine(line, tFr)).toBe("cache 15 h · catalogue 743 ms · réseau 1.7 s · Reprendre 1.8 s (depuis l'appareil) · corrigé +0 −0 ↕0 · 115 Mo sur l'appareil (6 titres)");
    const cold = { kind: "ouverture", cacheUsed: false, cacheAgeMs: null, cacheMs: null, networkMs: 2200, resumeNetworkMs: 2300, resumeProgressed: 2, resumeAdded: 1, resumeRemoved: 0, resumeMoved: 1, hiddenAtMs: 900 };
    expect(describeLine(cold, tFr)).toBe("sans cache · réseau 2.2 s · Reprendre 2.3 s · corrigé +1 −0 ↕1 (2 barres avancées) · arrière-plan à 900 ms");
    // Un cache de plus de deux jours se dit en jours.
    expect(describeLine({ kind: "ouverture", cacheUsed: true, cacheAgeMs: 3 * 864e5, cacheMs: 400 }, tFr)).toBe("cache 3 j · catalogue 400 ms");
  });

  it("télécommande et nouveautés : une ligne simple", () => {
    expect(describeLine({ kind: "télécommande", keys: [], pointerMoves: 258, wheels: 0, viewport: "960x540" }, tFr)).toBe("0 touche · 258 mouvements de curseur · 960x540");
    expect(describeLine({ kind: "nouveautés", event: "fenêtre", shownMs: 9504, closedBy: "ok" }, tFr)).toBe("Fenêtre des nouveautés · 9.5 s à l'écran · fermée : ok");
    expect(describeLine({ kind: "nouveautés", event: "voir-plus" }, tEn)).toBe('"See more"');
  });

  it("subtitle-gen.log : reconnu à son `job`, même quand son type s'appelle comme une ligne du lecteur", () => {
    const job = "ae8d89064a45ae09dc2df6c2ffa46c00";
    expect(describeLine({ kind: "start", job, title: "Le Grinch", target: "cs", model: "claude-haiku-5-5" }, tFr)).toBe("Demande · cs · claude-haiku-5-5");
    expect(describeLine({ kind: "seek", job, from: 1216, to: 957 }, tFr)).toBe("Saut 20:16 → 15:57");
    expect(describeLine({ kind: "present", job, state: "presented" }, tFr)).toBe("État · presented");
    expect(describeLine({ kind: "retry", job, cause: "drift", attempt: 2, count: 40 }, tFr)).toBe("Nouvel essai 2 · drift · 40 lignes");
    expect(describeLine({ kind: "done", job, target: "cs", total: 999, durationMs: 214547, cost: 0.03281 }, tFr)).toBe("Terminé · cs · 999 lignes · 3:34 · $0.03281");
    expect(describeLine({ kind: "inventé", job, state: "en cours", target: "de" }, tFr)).toBe("inventé · en cours · de");
  });
});

describe("kindTone — les jetons d'état du design", () => {
  it("réseau et erreur de réserve en ambre, refus de connexion et de jeton en rouge", () => {
    expect(kindTone("network")).toBe("bg-warning/15 text-warning");
    expect(kindTone("reserve", undefined, "erreur")).toBe("bg-warning/15 text-warning");
    expect(kindTone("reserve", undefined, "arrêt")).toBe("bg-white/10 text-muted");
    expect(kindTone("login-failed")).toBe("bg-danger/15 text-danger");
    expect(kindTone("token-refused")).toBe("bg-danger/15 text-danger");
    expect(kindTone("login")).not.toContain("danger");
  });
});

describe("fullDate", () => {
  it("les secondes à la demande, l'année seulement hors de l'année en cours", () => {
    const thisYear = new Date();
    thisYear.setMonth(0, 15);
    thisYear.setHours(8, 12, 50, 0);
    expect(fullDate(thisYear.getTime(), { seconds: true })).toMatch(/08:12:50/);
    expect(fullDate(thisYear.getTime())).not.toMatch(/08:12:50/);
    expect(fullDate(thisYear.getTime())).not.toContain(String(thisYear.getFullYear()));
    const lastYear = new Date(thisYear);
    lastYear.setFullYear(thisYear.getFullYear() - 1);
    expect(fullDate(lastYear.getTime())).toContain(String(lastYear.getFullYear()));
  });
});
