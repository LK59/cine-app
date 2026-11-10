import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, useT } from "../state/store";
import { episodesOf, forgetLibrary, library, search, type Continue, type Episode, type Library, type Title } from "../media/library";
import { play, stop } from "../media/playback";
import { closePanel } from "../world/panel";
import { ExperienceLogo } from "./Logo";
import { ErrorBoundary } from "./ErrorBoundary";

const clock = (minutes: number | null) => (minutes ? (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}` : `${minutes} min`) : null);

function Poster({ title, onOpen }: { title: Title; onOpen: () => void }) {
  return (
    <button type="button" className="poster" onClick={onOpen} title={title.title}>
      <span className="poster-art">{title.poster ? <img src={title.poster} alt="" loading="lazy" decoding="async" /> : <span className="poster-blank">{title.title}</span>}</span>
      <span className="poster-name">{title.title}</span>
      <span className="poster-year">{title.year ?? " "}</span>
    </button>
  );
}

function ContinueCard({ item, onPlay }: { item: Continue; onPlay: () => void }) {
  return (
    <button type="button" className="poster" onClick={onPlay} title={item.title}>
      <span className="poster-art">
        {item.image ? <img src={item.image} alt="" loading="lazy" decoding="async" /> : <span className="poster-blank">{item.title}</span>}
        <span className="poster-play" aria-hidden>
          ▶
        </span>
        {item.progress > 0 ? (
          <span className="poster-progress">
            <span style={{ width: `${item.progress}%` }} />
          </span>
        ) : null}
      </span>
      <span className="poster-name">{item.title}</span>
      <span className="poster-year">{item.subtitle ?? " "}</span>
    </button>
  );
}

/** La fiche d'un titre : l'essentiel, et le bouton Lecture. Pour une série, ses épisodes. */
function Detail({ title, onBack, onPlay }: { title: Title; onBack: () => void; onPlay: (itemId: string, name: string, from: number | null) => void }) {
  const t = useT();
  const [episodes, setEpisodes] = useState<{ list: Episode[]; next: string | null } | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (title.kind !== "series") return;
    let alive = true;
    episodesOf(title.itemId).then(
      (data) => {
        if (!alive) return;
        setEpisodes({ list: data.episodes, next: data.next });
        const upcoming = data.episodes.find((e) => e.itemId === data.next);
        setSeason(upcoming?.season ?? data.episodes[0]?.season ?? null);
      },
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, [title]);

  const seasons = useMemo(() => [...new Set((episodes?.list ?? []).map((e) => e.season))].sort((a, b) => a - b), [episodes]);
  const next = episodes?.list.find((e) => e.itemId === episodes.next) ?? episodes?.list[0] ?? null;
  const facts = [title.year, title.kind === "movie" ? clock(title.minutes) : title.seasons ? `${title.seasons} ${t("panel.season").toLowerCase()}${title.seasons > 1 ? "s" : ""}` : null, title.rating ? `★ ${title.rating.toFixed(1)}` : null].filter(Boolean);
  const episodeName = (e: Episode) => `${title.title} — S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")} · ${e.title}`;

  return (
    <div className="detail">
      {title.backdrop ? <img className="detail-backdrop" src={title.backdrop} alt="" /> : null}
      <div className="detail-shade" />
      <div className="detail-body">
        <button type="button" className="chip" onClick={onBack}>
          ← {t("panel.back")}
        </button>
        <div className="detail-main">
          {title.poster ? <img className="detail-poster" src={title.poster} alt="" /> : null}
          <div className="detail-text">
            <h2>{title.title}</h2>
            <p className="detail-facts">{facts.join(" · ")}</p>
            {title.tagline ? <p className="detail-tagline">{title.tagline}</p> : null}
            {title.overview ? <p className="detail-overview">{title.overview}</p> : null}
            {title.cast.length ? <p className="detail-cast">{title.cast.slice(0, 4).join(", ")}</p> : null}
            <div className="detail-actions">
              {title.kind === "movie" ? (
                <>
                  <button type="button" className="btn btn-primary" onClick={() => onPlay(title.itemId, title.title, null)} autoFocus data-testid="play">
                    ▶ {t("panel.play")}
                  </button>
                  <button type="button" className="btn" onClick={() => onPlay(title.itemId, title.title, 0)}>
                    {t("panel.restart")}
                  </button>
                </>
              ) : next ? (
                <button type="button" className="btn btn-primary" onClick={() => onPlay(next.itemId, episodeName(next), null)} autoFocus data-testid="play">
                  ▶ {next.resume > 0 ? t("panel.resume") : t("panel.play")} · S{String(next.season).padStart(2, "0")}E{String(next.episode).padStart(2, "0")}
                </button>
              ) : failed ? (
                <p className="panel-note">{t("panel.failed")}</p>
              ) : null}
            </div>
          </div>
        </div>
        {title.kind === "series" && episodes ? (
          <div className="episodes">
            {seasons.length > 1 ? (
              <div className="chips">
                {seasons.map((n) => (
                  <button key={n} type="button" className={n === season ? "chip chip-on" : "chip"} onClick={() => setSeason(n)}>
                    {t("panel.season")} {n}
                  </button>
                ))}
              </div>
            ) : null}
            <ol className="episode-list">
              {episodes.list
                .filter((e) => e.season === season)
                .map((e) => (
                  <li key={e.itemId}>
                    <button type="button" className="episode" onClick={() => onPlay(e.itemId, episodeName(e), null)}>
                      <span className="episode-number">{e.episode}</span>
                      <span className="episode-title">{e.title}</span>
                      <span className="episode-meta">
                        {e.watched ? "✓ " : ""}
                        {clock(e.minutes) ?? ""}
                      </span>
                    </button>
                  </li>
                ))}
            </ol>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Laterna, dans le chalet : reprendre une lecture, voir ce qui vient d'arriver, chercher un titre,
 * ouvrir sa fiche, le lancer sur la télévision.
 */
export function Panel() {
  const t = useT();
  const playback = useStore((s) => s.playback);
  const [lib, setLib] = useState<Library | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"movies" | "series">("movies");
  const [opened, setOpened] = useState<Title | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    library().then(
      (data) => alive && setLib(data),
      () => alive && setFailed(true)
    );
    return () => {
      alive = false;
    };
  }, []);

  // Échap : un cran en arrière — la fiche, puis la recherche, puis le panneau.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (opened) setOpened(null);
      else if (query) setQuery("");
      else closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opened, query]);

  const results = useMemo(() => (lib && query.trim() ? search(lib, query) : null), [lib, query]);
  const browse = useMemo(() => (lib ? [...(tab === "movies" ? lib.movies : lib.series)].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 240) : []), [lib, tab]);

  function launch(itemId: string, name: string, from: number | null) {
    // « Reprendre » aura changé après cette lecture.
    forgetLibrary();
    void play({ id: itemId, title: name }, from);
    closePanel();
  }

  const active = playback.status === "playing" || playback.status === "paused" || playback.status === "loading";

  return (
    <div className="panel" ref={root} data-testid="panel" onWheel={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <ExperienceLogo lit compact />
        <input className="panel-search" type="search" value={query} onChange={(e) => { setQuery(e.target.value); setOpened(null); }} placeholder={t("panel.search")} autoComplete="off" spellCheck={false} data-testid="panel-search" />
        <button type="button" className="chip" onClick={closePanel} data-testid="panel-close">
          {t("panel.close")} <kbd>{t("key.esc")}</kbd>
        </button>
      </header>

      {opened ? (
        // Une fiche qui ne se dessine pas (une donnée inattendue) ne doit pas emporter le panneau.
        <ErrorBoundary key={opened.key} fallback={<p className="panel-note panel-pad">{t("panel.failed")}</p>}>
          <Detail title={opened} onBack={() => setOpened(null)} onPlay={launch} />
        </ErrorBoundary>
      ) : (
        <div className="panel-scroll">
          {active ? (
            <section className="now">
              <span className="now-label">{t("panel.nowPlaying")}</span>
              <span className="now-title">{playback.title}</span>
              <button type="button" className="chip" onClick={stop}>
                ■ {t("panel.stop")}
              </button>
            </section>
          ) : null}
          {failed ? <p className="panel-note">{t("panel.failed")}</p> : null}
          {!lib && !failed ? <p className="panel-note">{t("panel.loading")}…</p> : null}
          {lib && results ? (
            <section>
              <h3>{t("panel.results")}</h3>
              {results.length ? (
                <div className="grid">
                  {results.map((title) => (
                    <Poster key={title.key} title={title} onOpen={() => setOpened(title)} />
                  ))}
                </div>
              ) : (
                <p className="panel-note">{t("panel.noResults")}</p>
              )}
            </section>
          ) : null}
          {lib && !results ? (
            <>
              {lib.continues.length ? (
                <section>
                  <h3>{t("panel.continue")}</h3>
                  <div className="row">
                    {lib.continues.map((item) => (
                      <ContinueCard key={item.itemId} item={item} onPlay={() => launch(item.itemId, item.subtitle && item.kind === "episode" ? `${item.title} — ${item.subtitle}` : item.title, null)} />
                    ))}
                  </div>
                </section>
              ) : null}
              <section>
                <h3>{t("panel.recent")}</h3>
                <div className="row">
                  {lib.recent.map((title) => (
                    <Poster key={title.key} title={title} onOpen={() => setOpened(title)} />
                  ))}
                </div>
              </section>
              <section>
                <div className="chips">
                  <button type="button" className={tab === "movies" ? "chip chip-on" : "chip"} onClick={() => setTab("movies")}>
                    {t("panel.movies")} <span className="count">{lib.movies.length}</span>
                  </button>
                  <button type="button" className={tab === "series" ? "chip chip-on" : "chip"} onClick={() => setTab("series")}>
                    {t("panel.series")} <span className="count">{lib.series.length}</span>
                  </button>
                </div>
                <div className="grid">
                  {browse.map((title) => (
                    <Poster key={title.key} title={title} onOpen={() => setOpened(title)} />
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
