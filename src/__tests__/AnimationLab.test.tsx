// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, render, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

// Le catalogue : vide — la page doit se dessiner sans image, sur son dégradé de secours.
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));

import { AnimationLab } from "@/components/animlab/AnimationLab";
import { SheetOpenLot, sheetMotionForTests } from "@/components/animlab/IntroLots";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

// jsdom n'a ni Web Animations ni ResizeObserver : des doublures minimales, qui rendent une
// animation déjà finie — la page ne doit dépendre de rien d'autre pour se monter.
beforeAll(() => {
  const finished = () => ({ id: "", playState: "finished", finished: Promise.resolve(), cancel() {} });
  Object.assign(Element.prototype, { animate: finished, getAnimations: () => [] });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("la page Tests animations", () => {
  it("monte chacun de ses huit lots", () => {
    render(<AnimationLab />);
    for (const name of ["Gestes d'appui", "Matières", "Apparition du flou", "Groupes et métamorphoses", "Défilement sous verre", "Lecteur simulé", "Lancement de la lecture", "Ouverture de fiche"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
      expect(screen.getAllByRole("button").length).toBeGreaterThan(5);
    }
  });

  it("ouvre le menu des sous-titres depuis sa pilule, puis le referme au choix d'une piste", async () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lecteur simulé/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sous-titres" }));
    expect(screen.getByText("Suomi")).toBeTruthy();
    fireEvent.click(screen.getByText("English"));
    // Rendue à la pilule une fois le ressort revenu près de sa forme, puis après un court fondu.
    await waitFor(() => expect(screen.queryByText("Suomi")).toBeNull(), { timeout: 3000 });
    // Un sous-titre choisi : le point sous l'icône.
    expect(screen.getByRole("button", { name: "Sous-titres" }).hasAttribute("data-active")).toBe(true);
  });

  it("ouvre aussi le menu vitesse depuis la pilule", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lecteur simulé/ }));
    fireEvent.click(screen.getByRole("button", { name: "Vitesse" }));
    expect(screen.getByText("1,25×")).toBeTruthy();
  });

  it("garde sa zone de toucher élargie sur les pilules du geste liquide", () => {
    const { container } = render(<AnimationLab />);
    const pills = container.querySelectorAll(".alab-sim .alab-pill");
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) expect(pill.classList.contains("alab-slop")).toBe(true);
  });

  it("propose les réglages des deux prototypes du 10/10 : ouverture de la lecture et affiche qui se déploie", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lancement de la lecture/ }));
    expect(screen.getByText("Délai simulé")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lueur sur le logo/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ouverture de fiche/ }));
    expect(screen.getByRole("button", { name: /^Apple — ressort/ })).toBeTruthy();
  });

  it("deuxième passe : fonds de qualité pour la lecture, maquette fidèle aux fiches pour l'ouverture", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lancement de la lecture/ }));
    // Le fond par défaut est net, en 1 280 px (le flou se voyait) ; l'ancien reste pour comparer.
    expect(screen.getByRole("button", { name: "Net" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Ancien/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ouverture de fiche/ }));
    expect(screen.getByRole("button", { name: "Téléphone" })).toBeTruthy();
    // D'un bloc par défaut depuis la cinquième passe ; la cascade reste à comparer.
    expect(screen.getByRole("button", { name: "Cascade du contenu" }).getAttribute("aria-pressed")).toBe("false");
    // Sans catalogue, pas de maquette à ouvrir.
    expect((screen.getByRole("button", { name: /Chargement du catalogue/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("troisième passe : la luminosité du fond se règle, et part du voile d'origine", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Lancement de la lecture/ }));
    const slider = screen.getByLabelText(/Luminosité du fond/) as HTMLInputElement;
    expect(slider.value).toBe("0");
    expect(screen.getByText(/voile d'origine/)).toBeTruthy();
    fireEvent.change(slider, { target: { value: "20" } });
    expect(screen.getByText(/Luminosité du fond \+20 %/)).toBeTruthy();
  });

  it("sixième passe : le ressort d'Apple par défaut, les durées fixes à comparer, le moteur et le profil", () => {
    render(<AnimationLab />);
    fireEvent.click(screen.getByRole("button", { name: /Ouverture de fiche/ }));
    expect(screen.getByRole("button", { name: /^Apple — ressort/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Transform \(compositeur\)/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Auto \(détecté/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/amorti critique/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View Transitions/ })).toBeNull();
    // Les durées fixes : la fermeture plus vive que l'ouverture, les courbes expliquées.
    fireEvent.click(screen.getByRole("button", { name: "Durée fixe" }));
    expect((screen.getByLabelText(/^Ouverture 260 ms/) as HTMLInputElement).min).toBe("150");
    expect(screen.getByLabelText(/^Fermeture 210 ms/)).toBeTruthy();
    expect(screen.getByText(/cubic-bezier\(0\.2, 0, 0, 1\)/)).toBeTruthy();
  });

  describe("sixième passe : le ressort amorti critique d'UIKit", () => {
    const { criticalSpring, appleResponse, closeMotion, openMotion, releaseVelocity, sampleMotion } = sheetMotionForTests;
    const stage = { W: 390, H: 844 };
    const pace = (profile: "phone" | "ipad" | "desktop") =>
      ({ mode: "apple", ease: "spring", openMs: 260, closeMs: 210, engine: "transform", profile }) as const;

    it("se pose sans rebond, l'essentiel du trajet dans les premiers 40 %, à 0,5 px près à la fin", () => {
      const m = criticalSpring(0.4, 0, 600);
      let prev = 0;
      for (let t = 0; t <= m.duration; t += 5) {
        const q = m.q(t);
        expect(q).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(q).toBeLessThanOrEqual(1);
        prev = q;
      }
      expect(m.q(m.duration * 0.4)).toBeGreaterThan(0.85);
      expect(m.q(m.duration)).toBe(1);
      expect((1 - m.q(m.duration - 2)) * 600).toBeLessThan(0.6);
      expect((1 - m.q(m.duration - 60)) * 600).toBeGreaterThan(0.5);
    });

    it("part à la vitesse qu'on lui donne — celle du doigt, ou de l'ouverture interrompue", () => {
      expect(criticalSpring(0.4, 6, 600).v(0)).toBeCloseTo(6, 6);
      expect(criticalSpring(0.4, 0, 600).v(0)).toBe(0);
    });

    it("règle sa réponse sur la distance rapportée à l'écran, plus vive sur un ordinateur, plus vive encore à la fermeture", () => {
      const near = { x: 0, y: 0, w: 100, h: 150 };
      const far = { x: 0, y: 600, w: 100, h: 150 };
      const short = appleResponse(near, { ...near, y: 20 }, stage, "phone");
      const long = appleResponse(near, far, stage, "phone");
      expect(short).toBeGreaterThanOrEqual(0.32);
      expect(long).toBeGreaterThan(short);
      expect(long).toBeLessThanOrEqual(0.5);
      // La même fraction de l'écran, sur un écran deux fois plus grand : la même réponse.
      const big = { W: stage.W * 2, H: stage.H * 2 };
      const scaled = (b: typeof near) => ({ x: b.x * 2, y: b.y * 2, w: b.w * 2, h: b.h * 2 });
      expect(appleResponse(scaled(near), scaled(far), big, "phone")).toBeCloseTo(long, 6);
      expect(appleResponse(near, far, stage, "desktop")).toBeCloseTo(long * 0.8, 6);
      expect(appleResponse(near, far, stage, "ipad")).toBeCloseTo(long, 6);
      const open = openMotion(pace("phone"), near, far, stage);
      const close = closeMotion(pace("phone"), far, near, stage, 0);
      expect(close.duration).toBeLessThan(open.duration);
    });

    it("échantillonne au moins 60 images clés, la dernière exactement à l'arrivée", () => {
      const s = sampleMotion(criticalSpring(0.35, 0, 400));
      expect(s.length).toBeGreaterThanOrEqual(61);
      expect(s[s.length - 1]).toEqual({ offset: 1, q: 1 });
    });

    it("lit la vitesse du doigt sur ses 100 dernières millisecondes", () => {
      expect(releaseVelocity([{ t: 0, y: 0 }, { t: 400, y: 100 }, { t: 450, y: 150 }, { t: 500, y: 200 }])).toBeCloseTo(1000, 6);
      expect(releaseVelocity([{ t: 0, y: 0 }])).toBe(0);
    });
  });

  it("quatrième passe : au téléphone, la bannière de la fiche se tire vers le bas comme la vraie", () => {
    const movie = (id: number): CinemaMovie =>
      ({
        radarrId: id, title: `Film ${id}`, year: 2020, genres: [], quality: null, runtimeMinutes: 100, overview: "",
        posterUrl: `/p${id}.jpg`, backdropUrl: `/b${id}.jpg`, logoUrl: `/l${id}.png`,
      }) as unknown as CinemaMovie;
    render(<SheetOpenLot movies={[movie(1), movie(2), movie(3), movie(4)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Téléphone" }));
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir la maquette/ }));
    fireEvent.click(screen.getAllByRole("img", { name: "Film 4" })[0].closest("button")!);
    // La poignée : la bannière, rendue au geste (`touch-action: none`), la croix tenue à part.
    const handle = document.querySelector<HTMLElement>('[style*="touch-action: none"]');
    expect(handle).toBeTruthy();
    expect(handle!.querySelector('[aria-label="Fermer la fiche"]')).toBeTruthy();
    const sheet = handle!.parentElement!;
    fireEvent.pointerDown(handle!, { clientY: 100, pointerId: 1, button: 0, pointerType: "touch" });
    fireEvent.pointerMove(handle!, { clientY: 120, pointerId: 1, pointerType: "touch" });
    expect(sheet.style.transform).toBe("translateY(20px)");
    // Relâchée en deçà du seuil (et trop courte pour un lancer), elle revient en place.
    fireEvent.pointerUp(handle!, { clientY: 120, pointerId: 1, pointerType: "touch" });
    expect(sheet.style.transform).toBe("");
    // Au-delà : elle se ferme depuis là où le doigt l'a laissée, sans filer d'abord au bas de l'écran.
    fireEvent.pointerDown(handle!, { clientY: 100, pointerId: 1, button: 0, pointerType: "touch" });
    fireEvent.pointerMove(handle!, { clientY: 400, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(handle!, { clientY: 400, pointerId: 1, pointerType: "touch" });
    expect(sheet.style.transform).toBe("translateY(300px)");
    expect(sheet.style.pointerEvents).toBe("none");
  });

  describe("cinquième passe : contenu d'un bloc, fermeture sans clignotement, fiches en cascade", () => {
    type Recorded = { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> };
    let recorded: Recorded[] = [];
    const movie = (id: number): CinemaMovie =>
      ({
        radarrId: id, title: `Film ${id}`, year: 2020, genres: [], quality: null, runtimeMinutes: 100, overview: `Résumé ${id}`,
        posterUrl: `/p${id}.jpg`, backdropUrl: `/b${id}.jpg`, logoUrl: `/l${id}.png`,
      }) as unknown as CinemaMovie;
    const openDesktopMock = () => {
      render(<SheetOpenLot movies={[1, 2, 3, 4, 5].map(movie)} />);
      fireEvent.click(screen.getByRole("button", { name: "Bureau" }));
      fireEvent.click(screen.getByRole("button", { name: /Ouvrir la maquette/ }));
    };
    const sheets = () => Array.from(document.querySelectorAll<HTMLElement>("[data-alab-sheet]"));
    const openFromHome = (id: number) => fireEvent.click(screen.getAllByRole("img", { name: `Film ${id}` })[0].closest("button")!);

    beforeEach(() => {
      recorded = [];
      vi.spyOn(Element.prototype, "animate").mockImplementation(function (this: Element, frames, opts) {
        const cancel = vi.fn();
        recorded.push({ el: this, frames: frames as Keyframe[], opts: (typeof opts === "number" ? { duration: opts } : opts) ?? {}, cancel });
        return {
          id: "", playState: "finished", finished: Promise.resolve(), cancel,
          set onfinish(fn: () => void) {
            queueMicrotask(fn);
          },
        } as unknown as Animation;
      });
    });
    afterEach(() => vi.restoreAllMocks());

    it("fait paraître tout le contenu d'un bloc, au même instant, avec la bannière", () => {
      openDesktopMock();
      openFromHome(3);
      const lines = recorded.filter((r) => r.el.hasAttribute("data-alab-stagger") && r.frames[r.frames.length - 1].opacity === 1);
      expect(lines.length).toBeGreaterThan(3);
      expect(new Set(lines.map((r) => r.opts.delay)).size).toBe(1);
      expect(lines[0].opts.duration).toBe(220);
    });

    it("annule la révélation à la fermeture : aucune ligne ne reprend d'opacité après", async () => {
      openDesktopMock();
      openFromHome(3);
      const reveal = recorded.filter((r) => r.el.hasAttribute("data-alab-stagger"));
      expect(reveal.length).toBeGreaterThan(0);
      const before = recorded.length;
      fireEvent.keyDown(window, { key: "Escape" });
      for (const r of reveal) expect(r.cancel).toHaveBeenCalled();
      // Tout ce que la fermeture anime sur le contenu finit à 0.
      const after = recorded.slice(before).filter((x) => x.el.hasAttribute("data-alab-stagger"));
      expect(after.length).toBeGreaterThan(0);
      for (const r of after) expect(r.frames[r.frames.length - 1].opacity).toBe(0);
      await waitFor(() => expect(sheets()).toHaveLength(0));
    });

    it("empile les fiches et ne ferme que celle du dessus, à n'importe quelle profondeur", async () => {
      openDesktopMock();
      openFromHome(3);
      expect(sheets()).toHaveLength(1);
      // Une affiche de « Dans la même saga » : une deuxième fiche par-dessus, la première inerte.
      fireEvent.click(sheets()[0].querySelector<HTMLElement>('img[alt="Film 4"]')!.closest("button")!);
      expect(sheets()).toHaveLength(2);
      expect(sheets()[0].style.pointerEvents).toBe("none");
      // Puis la distribution : la fiche d'une personne, troisième niveau.
      fireEvent.click(within(sheets()[1]).getByRole("button", { name: "Distribution (exemple)" }));
      expect(sheets()).toHaveLength(3);
      // Échap ne ferme que celle du dessus, une à la fois.
      // Entre deux, les effets de la fiche redevenue celle du dessus (son écoute d'Échap) sont
      // vidés : sous charge, l'appui suivant tombait avant qu'elle écoute.
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(sheets()).toHaveLength(2));
      await act(async () => {});
      expect(sheets()[1].style.pointerEvents).toBe("");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(sheets()).toHaveLength(1));
      await act(async () => {});
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(sheets()).toHaveLength(0));
    });

    it("sixième passe : le trajet n'anime que des transformations et des opacités, sur au moins 60 images clés", () => {
      openDesktopMock();
      openFromHome(3);
      const morph = recorded.filter((r) => r.frames.length >= 61);
      expect(morph.length).toBeGreaterThanOrEqual(5);
      for (const r of recorded) {
        for (const f of r.frames) {
          expect(f).not.toHaveProperty("clipPath");
          expect(f).not.toHaveProperty("width");
          expect(f).not.toHaveProperty("height");
          // Le rayon des coins vit sur sa propre piste : il ne doit pas écarter la transformation du compositeur.
          if ("borderRadius" in f) expect(f).not.toHaveProperty("transform");
        }
      }
    });

    it("sixième passe : l'ancien moteur reste à comparer, par la découpe", () => {
      render(<SheetOpenLot movies={[1, 2, 3, 4, 5].map(movie)} />);
      fireEvent.click(screen.getByRole("button", { name: /clip-path \(ancien\)/ }));
      fireEvent.click(screen.getByRole("button", { name: "Bureau" }));
      fireEvent.click(screen.getByRole("button", { name: /Ouvrir la maquette/ }));
      openFromHome(3);
      expect(recorded.some((r) => r.frames.some((f) => "clipPath" in f))).toBe(true);
    });

    it("sixième passe : Échap rend le focus à l'affiche d'où la fiche est partie", async () => {
      openDesktopMock();
      const source = screen.getAllByRole("img", { name: "Film 3" })[0].closest("button")!;
      source.focus();
      fireEvent.click(source);
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(sheets()).toHaveLength(0));
      expect(document.activeElement).toBe(source);
    });

    it("sixième passe : quitter la maquette au milieu d'une fermeture ne rappelle rien de démonté", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      openDesktopMock();
      openFromHome(3);
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: /Quitter la maquette/ }));
      await act(async () => {
        await new Promise((ok) => setTimeout(ok, 300));
      });
      expect(sheets()).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
    });

    it("sixième passe : à l'iPad, la fiche large se tire par sa poignée ; à l'ordinateur, aucune", () => {
      render(<SheetOpenLot movies={[1, 2, 3, 4, 5].map(movie)} />);
      fireEvent.click(screen.getByRole("button", { name: "iPad" }));
      fireEvent.click(screen.getByRole("button", { name: "Bureau" }));
      fireEvent.click(screen.getByRole("button", { name: /Ouvrir la maquette/ }));
      openFromHome(3);
      const sheet = sheets()[0];
      const grip = sheet.querySelector<HTMLElement>('[style*="touch-action: none"]');
      expect(grip).toBeTruthy();
      fireEvent.pointerDown(grip!, { clientY: 100, pointerId: 1, button: 0, pointerType: "touch" });
      fireEvent.pointerMove(grip!, { clientY: 140, pointerId: 1, pointerType: "touch" });
      expect(sheet.style.transform).toBe("translateY(40px)");
      cleanup();
      render(<SheetOpenLot movies={[1, 2, 3, 4, 5].map(movie)} />);
      fireEvent.click(screen.getByRole("button", { name: "Ordinateur" }));
      fireEvent.click(screen.getByRole("button", { name: "Bureau" }));
      fireEvent.click(screen.getByRole("button", { name: /Ouvrir la maquette/ }));
      openFromHome(3);
      expect(sheets()[0].querySelector('[style*="touch-action: none"]')).toBeNull();
    });

    it("septième passe : le contenu ne part qu'une fois l'image en place, et se pose avec la fin du ressort", () => {
      // À 60 % (sixième passe), la colonne se posait pendant que l'image volait encore : avec le
      // ressort amorti, 60 % du trajet est couvert en ~100 ms.
      const { criticalSpring, sampleMotion, timeAt, REVEAL_AT } = sheetMotionForTests;
      expect(REVEAL_AT).toBeGreaterThanOrEqual(0.9);
      const m = criticalSpring(0.4, 0, 600);
      const at = timeAt(sampleMotion(m), m.duration, REVEAL_AT);
      expect(m.q(at)).toBeGreaterThanOrEqual(0.89);
      expect(at).toBeGreaterThan(timeAt(sampleMotion(m), m.duration, 0.6) + 50);
      // Le bloc de 220 ms finit avec le ressort, pas après lui.
      expect(at + 220).toBeLessThanOrEqual(m.duration + 60);
    });

    it("septième passe : au bureau, la saga loge sous la première page, comme dans la vraie fiche", () => {
      // Dans la colonne calée en bas, elle la faisait grandir et poussait le logo sous « Retour ».
      openDesktopMock();
      openFromHome(3);
      const sheet = sheets()[0];
      const label = within(sheet).getByText("Dans la même saga");
      const section = label.closest<HTMLElement>("[class*='snap-start']")!;
      expect(section.className).toContain("pt-[calc(5rem+env(safe-area-inset-top))]");
      // Et la colonne de la première page ne la contient plus.
      const column = within(sheet).getByText(/^Film 3$|Lire/, { selector: "span" }).closest("[class*='justify-end']");
      expect(column?.contains(label)).toBe(false);
    });

    it("septième passe : au téléphone, la ligne des mesures loge dans la pilule « Quitter », jamais sur la fiche", () => {
      render(<SheetOpenLot movies={[1, 2, 3, 4, 5].map(movie)} />);
      fireEvent.click(screen.getByRole("button", { name: "Téléphone" }));
      fireEvent.click(screen.getByRole("button", { name: /Ouvrir la maquette/ }));
      const readouts = document.querySelectorAll("[data-alab-readout]");
      expect(readouts).toHaveLength(1);
      expect(readouts[0].closest("button")?.textContent).toContain("Quitter la maquette");
      expect(readouts[0].textContent).not.toContain("Profil :");
    });

    it("ne propose pas, dans une fiche, sa propre affiche ; la variante hors bibliothèque est marquée", () => {
      openDesktopMock();
      openFromHome(3);
      // Le logo porte le nom du titre : seules les affiches de la rangée comptent.
      expect(sheets()[0].querySelector('section button img[alt="Film 3"]')).toBeNull();
      expect(sheets()[0].querySelectorAll("button img").length).toBeGreaterThan(0);
      expect(within(sheets()[0]).getAllByRole("button").some((b) => b.querySelector("span.text-accent-400"))).toBe(true);
    });
  });
});
