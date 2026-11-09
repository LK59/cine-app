// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

/**
 * Le panneau d'une personne d'« À l'écran » (DECISIONS.md §138–§139, 10.27) : ce qui ne dépend pas du
 * modèle (faits, courte biographie, ses titres dans la bibliothèque — des affiches qui ne réagissent à
 * rien), « Jusqu'ici » avec les questions seulement (une ligne d'attente, puis le texte ; rien du tout s'il
 * ne vient pas), une panne de question dite avec « Réessayer », et la feuille du téléphone : haute de son
 * contenu, refermée en la tirant vers le bas.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));

import { AskPanel, ASK_EXIT_MS } from "@/components/ask/AskPanel";
import { SOFAR_WAIT_FADE_MS, SOFAR_WAIT_STEP_MS } from "@/components/ask/AskPersonHeader";
import { resetSofarClientForTests, SOFAR_CLIENT_TIMEOUT_MS, SOFAR_LOADING_DELAY_MS } from "@/lib/ask/client";
import { compactPlace, personFactsLine, personQuestions } from "@/lib/xray/client";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";

const ITEM = "a".repeat(32);
const ARIADNE: XrayPlayerPerson = { personId: 2, name: "Elliot Page", character: "Ariadne", photo: null, screenTime: 30, confidence: 0.9 };
const COBB: XrayPlayerPerson = { personId: 1, name: "Leonardo DiCaprio", character: "Dom Cobb", photo: null, screenTime: 20, confidence: 0.9 };
const FACTS = {
  status: "ok",
  personId: 2,
  birthday: "1987-02-21",
  deathday: null,
  placeOfBirth: "Halifax, Nova Scotia, Canada",
  bio: "Elliot Page est un acteur canadien.",
  library: [
    { tmdbId: 1, mediaType: "movie", title: "Juno", year: 2007, poster: "https://image.tmdb.org/t/p/w185/juno.jpg" },
    { tmdbId: 2, mediaType: "tv", title: "The Umbrella Academy", year: 2019, poster: null },
  ],
};

class FakeViewport extends EventTarget {
  height = 390;
  width = 844;
  offsetTop = 0;
  set(next: Partial<{ height: number; offsetTop: number; width: number }>) {
    Object.assign(this, next);
    this.dispatchEvent(new Event("resize"));
  }
}
let vv: FakeViewport;
const fetchMock = vi.fn();
type Sofar = string[] | "error" | "rejected" | "hang";
let sofarReply: Sofar = ["Ariadne construit le labyrinthe."];
let questionReplies: unknown[][] = [];

function ndjson(lines: unknown[]) {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeEach(() => {
  resetSofarClientForTests();
  vv = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  sofarReply = ["Ariadne construit le labyrinthe."];
  questionReplies = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("?person=")) return new Response(JSON.stringify(FACTS));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { mode?: string };
      if (body.mode === "jusquici") {
        if (sofarReply === "hang") return new Promise<Response>(() => {});
        if (sofarReply === "error") return ndjson([{ t: "error", code: "erreur" }]);
        if (sofarReply === "rejected") return ndjson([{ t: "rejected" }]);
        return ndjson([...sofarReply.map((v) => ({ t: "text", v })), { t: "done" }]);
      }
      return ndjson(questionReplies.shift() ?? [{ t: "text", v: "Elle construit les rêves." }, { t: "done" }]);
    }
    return new Response(JSON.stringify({ available: true }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sofarPosts = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST" && JSON.parse(String((init as RequestInit).body)).mode === "jusquici");
const questionPosts = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST" && JSON.parse(String((init as RequestInit).body)).question);

function open(props: Partial<Parameters<typeof AskPanel>[0]> = {}) {
  const onClose = vi.fn();
  render(<AskPanel itemId={ITEM} where="lecteur" placement="player" position={() => 754} onClose={onClose} person={ARIADNE} scene={[ARIADNE, COBB]} {...props} />);
  return { onClose };
}

describe("les faits, sans le modèle", () => {
  it("le lieu court et traduit : la ville telle quelle, le pays dans la langue de qui lit", () => {
    expect(compactPlace("London, England, UK", "fr")).toBe("London, Royaume-Uni");
    expect(compactPlace("Halifax, Nova Scotia, Canada", "de")).toBe("Halifax, Kanada");
    expect(compactPlace("Paris, France", "es")).toBe("Paris, Francia");
    expect(compactPlace("Somewhere, Atlantis", "fr")).toBe("Somewhere, Atlantis");
    expect(compactPlace(null, "fr")).toBeNull();
  });
  it("« 50 ans · London, Royaume-Uni » ; l'âge au décès pour une personne disparue", () => {
    const t = (k: string, v?: Record<string, unknown>) => `${k}:${v?.n}`;
    const now = Date.parse("2026-11-09");
    expect(personFactsLine({ birthday: "1976-05-01", placeOfBirth: "London, England, UK" }, "fr", t, now)).toBe("modals.actor.age:50 · London, Royaume-Uni");
    expect(personFactsLine({ birthday: "1933-03-14", deathday: "2007-01-01" }, "fr", t, now)).toBe("xray.diedAt:73");
    expect(personFactsLine({}, "fr", t, now)).toBeNull();
  });
  it("les questions proposées (10.29.2) : seulement son lien avec les autres personnages de la scène — le plus présent d'abord, deux au plus", () => {
    const t = (k: string, v?: Record<string, unknown>) => `${k}:${JSON.stringify(v)}`;
    expect(personQuestions(ARIADNE, [ARIADNE, COBB], t)).toEqual(['xray.qLink:{"name":"Ariadne","other":"Dom"}']);
    // Seule dans la scène : aucune proposition.
    expect(personQuestions(ARIADNE, [ARIADNE], t)).toEqual([]);
    expect(personQuestions({ personId: 9, character: null }, [], t)).toBeUndefined();
    // Par temps à l'écran, pas par ordre de la scène ; un troisième ne passe pas ; un même prénom une fois.
    const scene = [
      { personId: 2, character: "Ariadne", screenTime: 50 },
      { personId: 10, character: "Saito", screenTime: 5 },
      { personId: 11, character: "Arthur", screenTime: 40 },
      { personId: 12, character: "Eames", screenTime: 20 },
      { personId: 13, character: "Arthur (jeune)", screenTime: 30 },
    ];
    expect(personQuestions(ARIADNE, scene, t)).toEqual(['xray.qLink:{"name":"Ariadne","other":"Arthur"}', 'xray.qLink:{"name":"Ariadne","other":"Eames"}']);
  });
});

describe("sans l'option des questions", () => {
  it("la personne seule : photo, acteur, personnage, faits et biographie, ses titres — ni « Jusqu'ici », ni propositions, ni champ", async () => {
    open({ ask: false });
    const panel = document.querySelector<HTMLElement>("[data-ask-person='2']")!;
    expect(panel.textContent).toContain("Elliot Page");
    expect(panel.textContent).toContain("Ariadne");
    await screen.findByText("Elliot Page est un acteur canadien.");
    expect(screen.getByText(/Halifax, Canada/)).toBeTruthy();
    // La biographie coupée à trois lignes.
    expect(screen.getByText("Elliot Page est un acteur canadien.").className).toContain("line-clamp-3");
    expect(document.querySelector("[data-ask-sofar]")).toBeNull();
    expect(document.querySelector("[data-ask-input]")).toBeNull();
    expect(document.querySelector("[data-ask-chips]")).toBeNull();
    // Rien vers le modèle : ni « Jusqu'ici », ni les dialogues demandés d'avance.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/cinema/ask/"))).toBe(false);
  });

  it("les questions sur une personne ouvertes, « Jusqu'ici » coupé (§139, 09/11/2026) : la proposition, pas la section — et jamais de champ (10.29.2)", async () => {
    open({ ask: true, sofar: false });
    await screen.findByText("Elliot Page est un acteur canadien.");
    expect(document.querySelector("[data-ask-sofar]")).toBeNull();
    expect(document.querySelector("[data-ask-input]")).toBeNull();
    expect(sofarPosts()).toHaveLength(0);
    fireEvent.click(screen.getByText('xray.qLink:{"name":"Ariadne","other":"Dom"}'));
    await screen.findByText("Elle construit les rêves.");
    // Posée depuis le panneau d'une personne : la porte de ces questions-là côté serveur.
    expect(JSON.parse(String((questionPosts()[0][1] as RequestInit).body)).about).toBe("person");
  });

  it("« Jusqu'ici » ouvert, les questions sur une personne coupées : la section, ni propositions ni champ", async () => {
    open({ ask: false, sofar: true });
    await screen.findByText("Ariadne construit le labyrinthe.");
    expect(document.querySelector("[data-ask-input]")).toBeNull();
    expect(document.querySelector("[data-ask-chips]")).toBeNull();
    expect(questionPosts()).toHaveLength(0);
  });

  it("le plafond mensuel atteint : une ligne dite à la place de la réponse (§140)", async () => {
    questionReplies = [[{ t: "error", code: "budget" }]];
    open({ ask: true, sofar: false });
    fireEvent.click(screen.getByText('xray.qLink:{"name":"Ariadne","other":"Dom"}'));
    await screen.findByText("ask.budget");
  });

  it("« Dans votre bibliothèque » : des affiches qui ne réagissent à rien", async () => {
    open({ ask: false });
    const library = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ask-person-library]");
      expect(el).toBeTruthy();
      return el!;
    });
    const posters = library.querySelectorAll<HTMLElement>("[data-library-poster]");
    expect(posters).toHaveLength(2);
    for (const p of posters) {
      expect(p.closest("button, a, [role=button], [onclick]")).toBeNull();
      expect(p.querySelector("button, a")).toBeNull();
      expect(p.closest(".pointer-events-none")).toBeTruthy();
    }
    const before = fetchMock.mock.calls.length;
    const hash = window.location.hash;
    fireEvent.click(posters[0]);
    fireEvent.pointerDown(posters[0]);
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(window.location.hash).toBe(hash);
    expect(document.querySelector("[data-ask-panel]")).toBeTruthy();
  });
});

describe("avec l'option : « Jusqu'ici »", () => {
  it("le panneau s'ouvre tout de suite, une ligne d'attente, puis les deux phrases — demandées pour la position de l'ouverture", async () => {
    sofarReply = "hang";
    open();
    expect(document.querySelector("[data-ask-person='2']")).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("waiting"));
    expect(JSON.parse(String((sofarPosts()[0][1] as RequestInit).body))).toMatchObject({ mode: "jusquici", personId: 2, positionS: 754 });
    cleanup();
    sofarReply = ["Ariadne construit le labyrinthe."];
    open();
    await screen.findByText("Ariadne construit le labyrinthe.");
    expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("done");
  });

  it("une panne, un refus ou rien à dire : la section reste, une ligne discrète (10.27.2 — elle se retirait et se lisait comme une panne)", async () => {
    for (const reply of ["error", "rejected"] as const) {
      sofarReply = reply;
      open();
      await waitFor(() => expect(sofarPosts().length).toBeGreaterThan(0));
      await screen.findByText("Elliot Page est un acteur canadien.");
      await waitFor(() => expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("little"));
      expect(document.querySelector("[data-ask-sofar-little]")?.textContent).toBe("xray.sofarLittle");
      expect(document.querySelector("[data-ask-sofar-text]")).toBeNull();
      expect(screen.queryByText("ask.error")).toBeNull();
      cleanup();
      fetchMock.mockClear();
    }
    // Une coupure réseau : pareil.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(String(url).includes("?person=") ? FACTS : { available: true }));
    });
    open();
    await screen.findByText("Elliot Page est un acteur canadien.");
    await waitFor(() => expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("little"));
  });

  it("l'option refusée à ce compte (`off`) : la section se retire, elle seule", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return ndjson([{ t: "error", code: "off" }]);
      return new Response(JSON.stringify(String(url).includes("?person=") ? FACTS : { available: true }));
    });
    open();
    await screen.findByText("Elliot Page est un acteur canadien.");
    await waitFor(() => expect(document.querySelector("[data-ask-sofar]")).toBeNull());
  });

  it("un texte déjà gardé par le serveur (réponse immédiate, tout d'un coup) : le texte à l'instant, sans ligne d'attente", async () => {
    sofarReply = ["Ariadne construit le labyrinthe.", "Elle a rejoint l'équipe de Cobb."];
    open();
    // La section est là dès l'ouverture, sans ligne d'attente avant le délai.
    expect(document.querySelector("[data-ask-sofar]")).toBeTruthy();
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeNull();
    await screen.findByText("Ariadne construit le labyrinthe. Elle a rejoint l'équipe de Cobb.");
    expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("done");
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeNull();
    // 10.28.0 : plus de fondu sur le texte — le premier mot est là à pleine lumière, rien ne le retarde.
    expect(document.querySelector("[data-ask-sofar-text]")?.className).not.toContain("ask-sofar-in");
  });

  it("une génération : la ligne d'attente passé le délai, puis les phrases à mesure — les faits n'attendent jamais", async () => {
    let push: (line: unknown) => void = () => {};
    let end: () => void = () => {};
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).mode === "jusquici") {
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            push = (l) => c.enqueue(enc.encode(JSON.stringify(l) + "\n"));
            end = () => c.close();
          },
        });
        return new Response(body);
      }
      return base(url, init);
    });
    open();
    // Les faits arrivent pendant que « Jusqu'ici » attend encore.
    await screen.findByText("Elliot Page est un acteur canadien.");
    await waitFor(() => expect(document.querySelector("[data-ask-sofar-loading]")).toBeTruthy(), { timeout: SOFAR_LOADING_DELAY_MS + 1000 });
    expect(document.querySelector("[data-ask-sofar-loading]")?.getAttribute("aria-label")).toBe("ask.thinking");
    act(() => push({ t: "text", v: "Ariadne construit le labyrinthe." }));
    await screen.findByText("Ariadne construit le labyrinthe.");
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeNull();
    act(() => {
      push({ t: "done" });
      end();
    });
    await waitFor(() => expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("done"));
  });

  /** Une réponse « Jusqu'ici » tenue ouverte : chaque ligne envoyée quand le test le dit. */
  function streamedSofar() {
    const ctl: { push: (line: unknown) => void; end: () => void } = { push: () => {}, end: () => {} };
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).mode === "jusquici") {
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              ctl.push = (l) => c.enqueue(enc.encode(JSON.stringify(l) + "\n"));
              ctl.end = () => c.close();
            },
          })
        );
      }
      return base(url, init);
    });
    return ctl;
  }
  const waitLines = () => [...document.querySelectorAll("[data-ask-sofar-wait-line]")].map((n) => n.textContent);
  const leavingLines = () => [...document.querySelectorAll("[data-ask-sofar-wait-leaving]")].map((n) => n.textContent);
  // Position 754 : la coupe tombe au début de la scène en cours, 700 s (10.30.1). Ariadne est reconnue dans deux
  // scènes avant elle ; celle qui commence à la coupe ne compte pas.
  const SCENES = {
    complete: true,
    analyzedUntil: 3000,
    scenes: [
      { start: 0, end: 300, people: [ARIADNE] },
      { start: 300, end: 450, people: [COBB] },
      { start: 450, end: 700, people: [ARIADNE, COBB] },
      { start: 700, end: 900, people: [ARIADNE] },
    ],
  };

  it("10.29.1 — une génération qui commence (`plan`) : l'attente tout de suite, une ligne vraie à la fois, en fondu croisé", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ctl = streamedSofar();
    open({ scenes: SCENES });
    await waitFor(() => expect(sofarPosts()).toHaveLength(1));
    act(() => ctl.push({ t: "plan", from: "S01E05", to: "S01E07" }));
    // Sans attendre le délai de la ligne d'attente : le serveur a dit qu'il écrit.
    await waitFor(() => expect(document.querySelector("[data-ask-sofar-loading]")).toBeTruthy(), { timeout: SOFAR_LOADING_DELAY_MS - 100 });
    expect(waitLines()).toEqual(['xray.sofarWait.scenes:{"n":2,"name":"Ariadne"}']);
    expect(leavingLines()).toEqual([]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(SOFAR_WAIT_STEP_MS)));
    // La nouvelle ligne entre à la place de l'ancienne, qui sort en même temps — rien ne s'accumule.
    expect(waitLines()).toEqual(['xray.sofarWait.episodes:{"from":"S01E05","to":"S01E07"}']);
    expect(leavingLines()).toEqual(['xray.sofarWait.scenes:{"n":2,"name":"Ariadne"}']);
    expect(document.querySelector("[data-ask-sofar-wait-leaving]")!.className).toContain("ask-wait-leaving");
    expect(document.querySelector("[data-ask-sofar-wait-line]")!.className).toContain("ask-wait-line");
    await act(async () => void (await vi.advanceTimersByTimeAsync(SOFAR_WAIT_FADE_MS + 10)));
    expect(leavingLines()).toEqual([]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(SOFAR_WAIT_STEP_MS)));
    expect(waitLines()).toEqual(["xray.sofarWait.writing"]);
    // La dernière reste, et respire (opacité seule) ; plus de reflet dans le texte.
    expect(document.querySelector("[data-ask-sofar-wait-line]")!.className).toContain("ask-wait-last");
    await act(async () => void (await vi.advanceTimersByTimeAsync(SOFAR_WAIT_STEP_MS * 3)));
    expect(waitLines()).toEqual(["xray.sofarWait.writing"]);
    expect(document.querySelectorAll(".ask-wait-shimmer")).toHaveLength(0);
    ctl.end();
  });

  it("10.28.0 — le premier mot remplace l'attente à l'instant, même au milieu de ses lignes ; les mots s'ajoutent un à un", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ctl = streamedSofar();
    open({ scenes: SCENES });
    await waitFor(() => expect(sofarPosts()).toHaveLength(1));
    act(() => ctl.push({ t: "plan", from: "S01E05", to: "S01E05" }));
    await waitFor(() => expect(waitLines()).toHaveLength(1));
    // Le premier mot arrive avant la deuxième ligne : l'attente part, aucune ligne de plus n'attend son tour.
    act(() => ctl.push({ t: "text", v: "Ariadne" }));
    await waitFor(() => expect(document.querySelector("[data-ask-sofar-text]")?.textContent).toBe("Ariadne"));
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeNull();
    act(() => ctl.push({ t: "text", v: "construit" }));
    await waitFor(() => expect(document.querySelector("[data-ask-sofar-text]")?.textContent).toBe("Ariadne construit"));
    // Un `reset` (une phrase retirée par le filet) remet le texte montré.
    act(() => ctl.push({ t: "reset", v: "" }));
    act(() => ctl.push({ t: "text", v: "Ariadne dessine." }));
    await waitFor(() => expect(document.querySelector("[data-ask-sofar-text]")?.textContent).toBe("Ariadne dessine."));
    await act(async () => void (await vi.advanceTimersByTimeAsync(SOFAR_WAIT_STEP_MS * 3)));
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeNull();
    act(() => {
      ctl.push({ t: "done" });
      ctl.end();
    });
    await waitFor(() => expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("done"));
  });

  it("10.28.0 — un texte gardé : jamais d'attente, à aucun moment (serveur ou appareil)", async () => {
    const seen: boolean[] = [];
    const observer = new MutationObserver(() => seen.push(!!document.querySelector("[data-ask-sofar-loading]")));
    observer.observe(document.body, { childList: true, subtree: true });
    open({ scenes: SCENES });
    await screen.findByText("Ariadne construit le labyrinthe.");
    cleanup();
    // Rouvert : le texte gardé sur l'appareil, sans requête.
    open({ scenes: SCENES });
    expect(screen.getByText("Ariadne construit le labyrinthe.")).toBeTruthy();
    await act(async () => void (await new Promise((r) => setTimeout(r, SOFAR_LOADING_DELAY_MS + 50))));
    observer.disconnect();
    expect(seen.some(Boolean)).toBe(false);
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeNull();
  });

  it("10.29.1 — mouvement réduit : une seule ligne, immobile — la plus avancée de ce qu'on sait", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q, addEventListener() {}, removeEventListener() {} }));
    const ctl = streamedSofar();
    open({ scenes: SCENES });
    await waitFor(() => expect(sofarPosts()).toHaveLength(1));
    act(() => ctl.push({ t: "plan", from: "S01E05", to: "S01E07" }));
    await waitFor(() => expect(waitLines()).toEqual(["xray.sofarWait.writing"]));
    const line = document.querySelector("[data-ask-sofar-wait-line]")!;
    expect(line.className).not.toContain("ask-wait-line");
    expect(leavingLines()).toEqual([]);
    ctl.end();
  });

  it("rouvert sur la même personne dans la même tranche : le texte à l'instant, sans nouvelle demande", async () => {
    open();
    await screen.findByText("Ariadne construit le labyrinthe.");
    cleanup();
    const before = sofarPosts().length;
    open({ position: () => 790 });
    expect(screen.getByText("Ariadne construit le labyrinthe.")).toBeTruthy();
    expect(sofarPosts().length).toBe(before);
  });

  it("position inconnue : la section est là quand même, demandée sans position (10.27.0 : ni section ni demande)", async () => {
    open({ position: () => null });
    expect(document.querySelector("[data-ask-sofar]")).toBeTruthy();
    await screen.findByText("Ariadne construit le labyrinthe.");
    expect(JSON.parse(String((sofarPosts()[0][1] as RequestInit).body))).toMatchObject({ mode: "jusquici", personId: 2, positionS: null });
  });

  it("rien à dire : la section reste avec la ligne discrète, le reste reste", async () => {
    sofarReply = "rejected";
    open();
    expect(document.querySelector("[data-ask-sofar]")).toBeTruthy();
    await screen.findByText("Elliot Page est un acteur canadien.");
    await waitFor(() => expect(document.querySelector("[data-ask-sofar-little]")).toBeTruthy());
    expect(document.querySelector("[data-ask-sofar-text]")).toBeNull();
  });

  it(`aucune fin en ${SOFAR_CLIENT_TIMEOUT_MS / 1000} s : la ligne discrète remplace l'attente (10.27.0 : « Un instant… » pour toujours)`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sofarReply = "hang";
    open();
    await act(async () => void (await vi.advanceTimersByTimeAsync(SOFAR_LOADING_DELAY_MS + 50)));
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(SOFAR_CLIENT_TIMEOUT_MS)));
    expect(document.querySelector("[data-ask-sofar]")?.getAttribute("data-ask-sofar")).toBe("little");
    expect(document.querySelector("[data-ask-sofar-loading]")).toBeNull();
    expect(screen.queryByText("ask.error")).toBeNull();
    expect(document.querySelector("[data-ask-person='2']")).toBeTruthy();
  });

  it("l'ordre : en-tête, « Jusqu'ici », faits, bibliothèque, propositions — sans champ (10.29.2)", async () => {
    open();
    await screen.findByText("Ariadne construit le labyrinthe.");
    await waitFor(() => expect(document.querySelector("[data-ask-person-library]")).toBeTruthy());
    const order = ["[data-ask-person='2'] span", "[data-ask-sofar]", "[data-ask-person-facts]", "[data-ask-person-library]", "[data-ask-chips]"].map(
      (sel) => document.querySelector(sel)!
    );
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('xray.qLink:{"name":"Ariadne","other":"Dom"}')).toBeTruthy();
    expect(document.querySelector("[data-ask-input]")).toBeNull();
    expect(screen.queryByText("ask.chipPlayer0")).toBeNull();
  });
});

describe("le panneau s'ouvre en haut (10.27.2)", () => {
  // jsdom ne fait pas de mise en page : l'espace qui défile reçoit une hauteur de contenu plus grande que
  // la sienne, et `scrollTo` est espionné — c'est lui qui descendait le panneau à l'ouverture en 10.27.1.
  function tallScroller() {
    const calls: number[] = [];
    // jsdom n'a pas `Element.scrollTo` : posé pour le test, retiré après.
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: function (this: HTMLElement, o: ScrollToOptions) {
        if (this.hasAttribute("data-ask-scroll")) calls.push(o.top ?? 0);
      },
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-ask-scroll") ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-ask-scroll") ? 300 : 0;
    });
    return {
      calls,
      restore: () => {
        vi.restoreAllMocks();
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
      },
    };
  }

  it("faits, biographie, bibliothèque et « Jusqu'ici » qui arrivent après l'ouverture : rien ne descend", async () => {
    const scroller = tallScroller();
    try {
      open();
      await screen.findByText("Elliot Page est un acteur canadien.");
      await screen.findByText("Ariadne construit le labyrinthe.");
      await waitFor(() => expect(document.querySelector("[data-ask-person-library]")).toBeTruthy());
      await act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(null)))));
      expect(scroller.calls).toEqual([]);
    } finally {
      scroller.restore();
    }
  });

  it("une question posée : l'espace descend jusqu'à la réponse", async () => {
    const scroller = tallScroller();
    try {
      open();
      await screen.findByText("Elliot Page est un acteur canadien.");
      fireEvent.click(screen.getByText('xray.qLink:{"name":"Ariadne","other":"Dom"}'));
      await screen.findByText("Elle construit les rêves.");
      await waitFor(() => expect(scroller.calls.length).toBeGreaterThan(0));
      expect(scroller.calls.every((top) => top === 900)).toBe(true);
    } finally {
      scroller.restore();
    }
  });

  it("une question posée depuis le panneau d'une personne emporte son `personId` (ses faits réels, côté serveur)", async () => {
    open();
    await screen.findByText("Elliot Page est un acteur canadien.");
    fireEvent.click(screen.getByText('xray.qLink:{"name":"Ariadne","other":"Dom"}'));
    await screen.findByText("Elle construit les rêves.");
    expect(JSON.parse(String((questionPosts()[0][1] as RequestInit).body))).toMatchObject({ personId: 2, positionS: 754 });
  });
});

describe("l'espace qui défile n'est pas masqué (10.27.1)", () => {
  it("`.ask-scroll` rogne par `contain: paint`, jamais par un `clip-path` — le panneau restait figé sur l'iPhone", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/app/globals.css`, "utf8");
    const rule = css.match(/\.ask-scroll\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("contain: paint");
    expect(rule).not.toContain("clip-path");
  });
});

describe("une question en panne", () => {
  it("dite proprement, avec « Réessayer » qui repose la même question à sa place", async () => {
    questionReplies = [[{ t: "error", code: "erreur" }], [{ t: "text", v: "Elle construit les rêves." }, { t: "done" }]];
    open();
    fireEvent.click(screen.getByText('xray.qLink:{"name":"Ariadne","other":"Dom"}'));
    const retry = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ask-retry]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(screen.getByText("ask.error")).toBeTruthy();
    fireEvent.click(retry);
    await screen.findByText("Elle construit les rêves.");
    expect(questionPosts()).toHaveLength(2);
    expect(JSON.parse(String((questionPosts()[1][1] as RequestInit).body)).question).toBe('xray.qLink:{"name":"Ariadne","other":"Dom"}');
    expect(document.querySelectorAll("[data-ask-exchange]")).toHaveLength(1);
    expect(document.querySelector("[data-ask-retry]")).toBeNull();
  });

  it("un flux coupé sans sa fin : la même ligne, jamais un écran cassé", async () => {
    questionReplies = [[{ t: "text", v: "Elle" }]];
    open();
    fireEvent.click(screen.getByText('xray.qLink:{"name":"Ariadne","other":"Dom"}'));
    await waitFor(() => expect(document.querySelector("[data-ask-retry]")).toBeTruthy());
  });
});

describe("la feuille du téléphone debout", () => {
  function portrait() {
    vv.width = 390;
    vv.height = 844;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  }

  it("haute de son contenu : posée par le bas, une hauteur au plus — jamais une hauteur fixe ; propositions côte à côte", () => {
    portrait();
    open({ placement: "sheet", where: "fiche", person: undefined, scene: undefined });
    const section = document.querySelector<HTMLElement>("[data-ask-panel]")!;
    expect(section.dataset.mode).toBe("sheet");
    expect(section.style.height).toBe("");
    expect(section.style.bottom).toBe("calc(100% - 844px)");
    expect(section.style.maxHeight).not.toBe("");
    expect(document.querySelector("[data-ask-chips]")!.className).toContain("flex-wrap");
  });

  it("tirée vers le bas par sa poignée, elle se referme ; un petit glissé la remet en place", async () => {
    portrait();
    const { onClose } = open({ placement: "sheet", where: "fiche" });
    const handle = document.querySelector<HTMLElement>("[data-ask-handle]")!;
    expect(handle).toBeTruthy();
    // Un petit glissé lent : elle revient.
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientY: 410, pointerId: 1 });
    await act(async () => new Promise((r) => setTimeout(r, 120)));
    fireEvent.pointerUp(handle, { clientY: 410, pointerId: 1 });
    await act(async () => new Promise((r) => setTimeout(r, ASK_EXIT_MS + 50)));
    expect(onClose).not.toHaveBeenCalled();
    // Tirée loin : refermée, par le même geste que les fiches.
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientY: 450, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 700, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 700, pointerId: 1 });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it("la croix est dans la poignée sans en faire partie : un appui sur elle ne démarre pas le geste", async () => {
    portrait();
    const { onClose } = open({ placement: "sheet", where: "fiche" });
    const close = document.querySelector<HTMLElement>("[data-ask-close]")!;
    fireEvent.pointerDown(close, { clientY: 400, pointerId: 1, button: 0 });
    fireEvent.click(close);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("couché ou au bureau, pas de poignée : la colonne de droite ne se tire pas", () => {
    open();
    expect(document.querySelector("[data-ask-panel]")!.getAttribute("data-mode")).toBe("side");
    expect(document.querySelector("[data-ask-handle]")).toBeNull();
  });
});

describe("10.29.1 — le relevé `xray-ui` du panneau : ce qu'il montre 300 ms après, et par quoi il se referme", () => {
  type Line = { event: string } & Record<string, unknown>;
  function diagSpy() {
    const lines: Line[] = [];
    return { lines, diag: (event: string, fields: Record<string, unknown>) => void lines.push({ event, ...fields }) };
  }

  it("300 ms après l'ouverture : la boîte, l'opacité calculée, et ce qui est dessus au centre", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { lines, diag } = diagSpy();
    // jsdom ne fait pas de mise en page : le centre du panneau est posé à la main, et ce qui y est trouvé aussi.
    const rect = { left: 500, top: 20, width: 330, height: 350, right: 830, bottom: 370, x: 500, y: 20, toJSON() {} } as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    let hit: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    open({ diag, ask: false });
    hit = document.querySelector("[data-ask-backdrop]");
    expect(lines).toEqual([]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(310)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "open", personId: 2, panel: { x: 500, y: 20, w: 330, h: 350 }, panelOpacity: 1, panelVisibility: "visible", top: "fond" });
    spy.mockRestore();
  });

  it("un toucher sur le fond : `close` avec la raison `fond` et la durée ; la croix : `croix` ; Échap : `échap`", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const [how, reason] of [
      [() => fireEvent.click(document.querySelector("[data-ask-backdrop]")!), "fond"],
      [() => fireEvent.click(document.querySelector("[data-ask-close]")!), "croix"],
      [() => fireEvent.keyDown(window, { key: "Escape" }), "échap"],
    ] as const) {
      const { lines, diag } = diagSpy();
      const onClose = vi.fn();
      const { unmount } = render(<AskPanel itemId={ITEM} where="lecteur" placement="player" position={() => 754} onClose={onClose} person={ARIADNE} ask={false} diag={diag} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
      act(() => how());
      await act(async () => void (await vi.advanceTimersByTimeAsync(ASK_EXIT_MS + 10)));
      expect(onClose).toHaveBeenCalledTimes(1);
      // Le parent démonte le panneau à `onClose`.
      unmount();
      const close = lines.find((l) => l.event === "close")!;
      expect(close).toMatchObject({ personId: 2, reason });
      expect(close.openMs).toBeGreaterThanOrEqual(400);
      expect(lines.filter((l) => l.event === "open")).toHaveLength(1);
      cleanup();
    }
  });

  it("démonté par le lecteur avant 300 ms (commandes cachées) : la mesure tout de suite, marquée `early`, puis `démonté`", () => {
    const { lines, diag } = diagSpy();
    const { unmount } = render(<AskPanel itemId={ITEM} where="lecteur" placement="player" position={() => 754} onClose={() => {}} person={ARIADNE} ask={false} diag={diag} />);
    unmount();
    expect(lines.map((l) => l.event)).toEqual(["open", "close"]);
    expect(lines[0]).toMatchObject({ early: true });
    expect(lines[1]).toMatchObject({ reason: "démonté" });
  });

  it("10.29.2 — l'opacité **effective** : le cadre à demi transparent au-dessus du panneau se lit dans `panelEffOpacity`", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { lines, diag } = diagSpy();
    // Un ancêtre (ici le corps de la page) à 0 : le panneau, lui, à 1 — c'est ce que disaient les lignes du banc.
    document.body.style.opacity = "0";
    try {
      const { unmount } = render(<AskPanel itemId={ITEM} where="lecteur" placement="player" position={() => 754} onClose={() => {}} person={ARIADNE} ask={false} diag={diag} />);
      await act(async () => void (await vi.advanceTimersByTimeAsync(310)));
      expect(lines[0]).toMatchObject({ event: "open", panelOpacity: 1, panelEffOpacity: 0 });
      unmount();
    } finally {
      document.body.style.opacity = "";
    }
  });

  it("sans relevé (une fiche) : rien", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open({ ask: false });
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/viewport-diag")).toBe(false);
  });
});
