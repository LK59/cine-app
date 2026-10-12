import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import type { CinemaRoute } from "@/lib/cinemaRoute";
import { accountScreenOpen } from "@/lib/cinemaRoute";
import { shouldOfferNews, type NewsGateFacts } from "@/lib/news/decide";
import { VisibleStopwatch } from "@/lib/news/events";
import { continuesTitle, contentFor, joinContinuation, sanitizeByLang, sanitizeContent } from "@/lib/news/content";
import { activePanel, isOnPanel } from "@/components/player/playerNav";
import { coversGrid } from "@/lib/cinemaGridTop";

/** Les Nouveautés (DECISIONS.md §73) : la décision d'ouvrir la fenêtre, le chronomètre, le contenu. */

const HOME: CinemaRoute = {
  tab: "movies",
  film: null,
  serie: null,
  episodes: false,
  search: false,
  list: false,
  account: false,
  discover: null,
  discoverType: "movie",
  person: null,
  browse: null,
  activity: null,
  report: null,
  news: null,
};
const facts = (over: Partial<NewsGateFacts> = {}): NewsGateFacts => ({ unseen: 1, onboardingPending: false, playback: "closed", route: HOME, pathname: "/", ...over });

describe("shouldOfferNews — une seule décision pour le bureau et le téléphone", () => {
  it("ouvre la fenêtre sur l'accueil, quand une page reste à voir", () => {
    expect(shouldOfferNews(facts())).toBe(true);
    expect(shouldOfferNews(facts({ unseen: 2 }))).toBe(true);
  });

  it("rien à voir, ou pas encore su : rien", () => {
    expect(shouldOfferNews(facts({ unseen: 0 }))).toBe(false);
    expect(shouldOfferNews(facts({ unseen: null }))).toBe(false);
  });

  it("jamais pendant un film, plein écran ou réduit", () => {
    expect(shouldOfferNews(facts({ playback: "full" }))).toBe(false);
    expect(shouldOfferNews(facts({ playback: "mini" }))).toBe(false);
  });

  it.each<[string, Partial<CinemaRoute>]>([
    ["une fiche de film ouverte par lien", { film: 12 }],
    ["une fiche de série", { serie: 4, tab: "series" }],
    ["les épisodes", { serie: 4, episodes: true }],
    ["une fiche TMDB", { discover: 99 }],
    ["une personne", { person: 7 }],
    ["la recherche", { search: true }],
    ["Ma liste", { list: true }],
    ["le Compte", { account: true }],
    ["la grille complète", { browse: "*" }],
    ["l'activité", { activity: "1" }],
    ["un signalement", { report: "liste" }],
    ["Compte → Nouveautés", { news: "1" }],
  ])("jamais par-dessus %s", (_name, patch) => {
    expect(shouldOfferNews(facts({ route: { ...HOME, ...patch } }))).toBe(false);
  });

  it("ni sur l'assistant, la connexion ou la gestion", () => {
    for (const pathname of ["/setup", "/login", "/gestion", "/gestion/radarr"]) expect(shouldOfferNews(facts({ pathname }))).toBe(false);
  });

  it("jamais par-dessus l'écran d'accueil d'un compte, ni tant qu'on ne sait pas s'il en a un", () => {
    expect(shouldOfferNews(facts({ onboardingPending: true }))).toBe(false);
    expect(shouldOfferNews(facts({ onboardingPending: undefined }))).toBe(false);
  });
});

describe("accountScreenOpen — les écrans poussés depuis le Compte", () => {
  it("compte les Nouveautés comme l'activité et les signalements, partout où on le demande", () => {
    const news = { ...HOME, news: "corrections:3" };
    expect(accountScreenOpen(news)).toBe(true);
    expect(coversGrid(news)).toBe(true);
    expect(activePanel(news)).toBe("account");
    // Y retourner depuis le rail referme l'écran poussé.
    expect(isOnPanel("account", news)).toBe(false);
    expect(accountScreenOpen(HOME)).toBe(false);
  });
});

describe("VisibleStopwatch — le temps d'affichage, page visible seulement", () => {
  it("ne compte pas le temps passé en arrière-plan", () => {
    const w = new VisibleStopwatch(0, true);
    w.hide(1000);
    w.show(61_000);
    expect(w.elapsed(62_500)).toBe(2500);
  });

  it("partie cachée, elle attend d'être vue ; deux `hide` ou deux `show` ne comptent pas double", () => {
    const w = new VisibleStopwatch(0, false);
    w.show(500);
    w.show(800);
    w.hide(1500);
    w.hide(9000);
    expect(w.elapsed(20_000)).toBe(1000);
  });
});

describe("le contenu d'une page", () => {
  it("une phrase en minuscule ou après une virgule continue le titre ; une phrase pleine passe dessous", () => {
    expect(continuesTitle(", en bas à gauche.")).toBe(true);
    expect(continuesTitle("que vous touchez.")).toBe(true);
    expect(continuesTitle("Les voix passent devant la musique.")).toBe(false);
    expect(continuesTitle("¿Falta tu idioma?")).toBe(false);
    expect(continuesTitle("")).toBe(false);
    expect(joinContinuation(", en bas à gauche.")).toBe(", en bas à gauche.");
    expect(joinContinuation("que vous touchez.")).toBe(" que vous touchez.");
  });

  it("une langue vide retombe sur le français", () => {
    const byLang = sanitizeByLang({
      fr: { sections: [{ title: "Nouveau", entries: [{ icon: "tv", title: "Télé", text: "Oui." }] }] },
      en: { sections: [{ title: "New", entries: [{ icon: "tv", title: "", text: "" }] }] },
      de: { sections: [{ title: "Neu", entries: [{ icon: "tv", title: "TV", text: "Ja." }] }] },
    });
    expect(byLang.en).toBeNull();
    expect(contentFor(byLang, "en").sections[0].title).toBe("Nouveau");
    expect(contentFor(byLang, "es").sections[0].title).toBe("Nouveau");
    expect(contentFor(byLang, "de").sections[0].title).toBe("Neu");
    expect(contentFor(byLang, "xx").sections[0].title).toBe("Nouveau");
  });

  it("nettoie et borne ce qu'envoie l'éditeur : icône inconnue, entrées vides, lignes vides", () => {
    const c = sanitizeContent({
      sections: [{ title: "  Nouveau  ", entries: [{ icon: "<script>", title: "A", text: "a" }, { icon: "tv", title: " ", text: "x" }] }, { title: "Vide", entries: [] }],
      fixes: [{ title: "Lecture", items: ["Un.", "", "  ", "Deux."] }],
      fixesSummary: "x".repeat(500),
    });
    expect(c.sections).toEqual([{ title: "Nouveau", entries: [{ icon: "sparkles", title: "A", text: "a", badge: "" }] }]);
    expect(c.fixes[0].items).toEqual(["Un.", "Deux."]);
    expect(c.fixesSummary).toHaveLength(160);
  });
});

describe("les dictionnaires", () => {
  it.each(["fr", "en", "es", "de"])("%s nomme la fenêtre, sa section Améliorations et son bouton OK", (lang) => {
    const dict = JSON.parse(readFileSync(`src/locales/${lang}.json`, "utf8")) as { news: Record<string, string>; activity: { news: Record<string, unknown> } };
    for (const key of ["title", "subtitle", "improvements", "fixesTitle", "seeMore", "footer", "ok", "history", "open"]) expect(dict.news[key]).toBeTruthy();
    expect(dict.news.subtitle).toContain("{version}");
    expect(dict.activity.news.relaunchAll).toBeTruthy();
  });
});
