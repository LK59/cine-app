import { useMemo, useState, type MouseEvent } from "react";
import type { Key } from "../lib/i18n";
import { startQuiz, stopQuiz } from "../game/quiz";
import { QUIZ_VARIANTS, type QuizVariant } from "../../../salons/src/quiz";
import { useStore, useT } from "../state/store";
import { useTrackLabels } from "./trackLabels";
import { dispatch } from "../media/commands";
import { episodeName as nameOf, search, type Continue, type Episode, type Title } from "../media/library";
import { closePanel, launch, openTitle, panelBack, setPanelQuery, setPanelSeason, setPanelTab, stopPlayback } from "../state/actions";
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
function Detail({ title }: { title: Title }) {
  const t = useT();
  const episodes = useStore((s) => s.panel.episodes);
  const season = useStore((s) => s.panel.season);
  const failed = useStore((s) => s.panel.episodesFailed);
  const onPlay = launch;

  const seasons = useMemo(() => [...new Set((episodes?.list ?? []).map((e) => e.season))].sort((a, b) => a - b), [episodes]);
  const next = episodes?.list.find((e) => e.itemId === episodes.next) ?? episodes?.list[0] ?? null;
  const facts = [title.year, title.kind === "movie" ? clock(title.minutes) : title.seasons ? `${title.seasons} ${t("panel.season").toLowerCase()}${title.seasons > 1 ? "s" : ""}` : null, title.rating ? `★ ${title.rating.toFixed(1)}` : null].filter(Boolean);
  const episodeName = (e: Episode) => nameOf(title.title, e);

  return (
    <div className="detail">
      {title.backdrop ? <img className="detail-backdrop" src={title.backdrop} alt="" /> : null}
      <div className="detail-shade" />
      <div className="detail-body">
        <button type="button" className="chip" onClick={panelBack}>
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
                  <button key={n} type="button" className={n === season ? "chip chip-on" : "chip"} onClick={() => setPanelSeason(n)}>
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

const stamp = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
};

/**
 * Ce qui joue sur les télévisions, et de quoi le commander à la souris : lecture ou pause, reculer,
 * avancer, aller à un instant en cliquant la barre, le son. Le clavier faisait déjà tout cela (Espace,
 * flèches, M) — mais rien ne le disait une fois le panneau ouvert, où il n'y avait qu'« Arrêter ».
 * Tout passe par les commandes (`media/commands.ts`), comme le clavier.
 */
function NowPlaying() {
  const t = useT();
  const playback = useStore((s) => s.playback);
  const volume = useStore((s) => s.settings.volume);
  const update = useStore((s) => s.updateSettings);
  const live = playback.status === "playing" || playback.status === "paused";
  const { audio: audioLabels, subtitles: subtitleLabels } = useTrackLabels();
  const ratio = playback.duration > 0 ? Math.min(1, playback.position / playback.duration) : 0;
  const seekTo = (e: MouseEvent<HTMLButtonElement>) => {
    // Activée au clavier (Espace, Entrée sur la barre focalisée), le clic n'a pas de position : il menait au début.
    if (e.detail === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0 && playback.duration > 0) dispatch({ type: "seek", to: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * playback.duration });
  };
  return (
    <section className="now" data-testid="now">
      <div className="now-head">
        <span className="now-label">{t("panel.nowPlaying")}</span>
        <span className="now-title">{playback.title}</span>
        <button type="button" className="chip" onClick={stopPlayback}>
          ■ {t("panel.stop")}
        </button>
      </div>
      {live ? (
        <>
          <div className="now-progress">
            <span className="tabular">{stamp(playback.position)}</span>
            <button type="button" className="now-bar" onClick={seekTo} aria-label={t("panel.seek")} data-testid="now-bar">
              <span style={{ transform: `scaleX(${ratio})` }} />
            </button>
            <span className="tabular">{playback.duration > 0 ? stamp(playback.duration) : ""}</span>
          </div>
          <div className="now-controls">
            <button type="button" className="chip" onClick={() => dispatch({ type: "seekBy", delta: -10 })} aria-label={t("panel.back10")}>
              −10 s
            </button>
            <button type="button" className="chip chip-on" onClick={() => dispatch({ type: "toggle" })} data-testid="now-toggle">
              {playback.wantPaused ? `▶ ${t("panel.play")}` : `❚❚ ${t("panel.pause")}`}
            </button>
            <button type="button" className="chip" onClick={() => dispatch({ type: "seekBy", delta: 30 })} aria-label={t("panel.forward30")}>
              +30 s
            </button>
            <span className="now-space" />
            <button type="button" className={playback.muted ? "chip chip-on" : "chip"} onClick={() => dispatch({ type: "mute" })} data-testid="now-mute">
              {playback.muted ? t("panel.unmute") : t("panel.mute")}
            </button>
            <label className="now-volume">
              <span className="sr-only">{t("settings.volume")}</span>
              <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => update({ volume: Number(e.target.value) })} data-testid="now-volume" />
            </label>
          </div>
          {audioLabels.length > 1 || subtitleLabels.length > 0 ? (
            <div className="now-tracks">
              {audioLabels.length > 1 ? (
                <label className="now-track">
                  <span>{t("panel.audio")}</span>
                  <select
                    value={playback.audioIndex ?? playback.audioTracks.find((track) => track.isDefault)?.index ?? playback.audioTracks[0]?.index ?? ""}
                    onChange={(e) => dispatch({ type: "audio", index: Number(e.target.value) })}
                    data-testid="now-audio"
                  >
                    {audioLabels.map((track) => (
                      <option key={track.number} value={track.number}>
                        {track.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {subtitleLabels.length > 0 ? (
                <label className="now-track">
                  <span>{t("panel.subtitles")}</span>
                  <select value={playback.subtitleIndex ?? ""} onChange={(e) => dispatch({ type: "subtitle", index: e.target.value === "" ? null : Number(e.target.value) })} data-testid="now-subtitles">
                    <option value="">{t("panel.subtitles.none")}</option>
                    {subtitleLabels.map((track) => (
                      <option key={track.number} value={track.number}>
                        {track.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Dans un salon, une ligne sous l'en-tête : son nom, combien on est, et que ce qui se lance ici passe chez tout le
 * monde (`net/tv.ts`). Sans elle, rien ne disait que la télévision était commune — un film lancé chez soi y arrivait
 * chez les autres sans qu'on l'ait su.
 */
function RoomBar() {
  const t = useT();
  const room = useStore((s) => s.net.room);
  if (!room) return null;
  const count = room.members.filter((m) => !m.away).length;
  return (
    <p className="panel-room" data-testid="panel-room">
      {t("panel.room").replace("{name}", room.name).replace("{count}", String(count))}
    </p>
  );
}

/**
 * Les jeux de la télévision : « Devine le film », en trois variantes. Dans un salon, la partie est pour tous les
 * présents ; seul, elle tourne dans la page (`game/quiz.ts`). Lancer referme le panneau : la télévision montre le jeu.
 */
function Games() {
  const t = useT();
  const quiz = useStore((s) => s.quiz);
  const inRoom = useStore((s) => !!s.net.room);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const launch = async (variant: QuizVariant) => {
    setBusy(true);
    setError(null);
    const failure = await startQuiz(variant);
    setBusy(false);
    if (failure) setError(t(`quiz.err.${failure}` as Key));
    else closePanel();
  };
  return (
    <section className="games" data-testid="games">
      <h3>{t("quiz.title")}</h3>
      <p className="panel-note">{inRoom ? t("quiz.inRoom") : t("quiz.solo")}</p>
      {quiz && quiz.view.phase !== "end" ? (
        <button type="button" className="chip" onClick={stopQuiz} data-testid="quiz-stop">
          ■ {t("quiz.stop")}
        </button>
      ) : (
        <div className="chips">
          {QUIZ_VARIANTS.map((variant) => (
            <button key={variant} type="button" className="chip" disabled={busy} onClick={() => void launch(variant)} data-testid={`quiz-start-${variant}`}>
              ▶ {t(`quiz.variant.${variant}` as Key)}
            </button>
          ))}
        </div>
      )}
      {error ? <p className="panel-note" data-testid="quiz-error">{error}</p> : null}
    </section>
  );
}

/**
 * Laterna, dans le chalet : reprendre une lecture, voir ce qui vient d'arriver, chercher un titre,
 * ouvrir sa fiche, le lancer sur les télévisions.
 *
 * Ce composant ne décide de rien et ne retient rien : il dessine l'état du panneau (`state/store.ts`)
 * et appelle les actions (`state/actions.ts`). C'est le rendu HTML ; un autre rendu — en 3D, pour un
 * casque — se brancherait sur le même état et les mêmes actions.
 */
export function Panel() {
  const t = useT();
  const playback = useStore((s) => s.playback);
  const { library: lib, libraryFailed: failed, query, tab, opened } = useStore((s) => s.panel);

  const results = useMemo(() => (lib && query.trim() ? search(lib, query) : null), [lib, query]);
  const browse = useMemo(() => (lib ? [...(tab === "movies" ? lib.movies : lib.series)].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 240) : []), [lib, tab]);
  const active = playback.status === "playing" || playback.status === "paused" || playback.status === "loading";

  return (
    <div className="panel" data-testid="panel" onWheel={(e) => e.stopPropagation()}>
      <header className="panel-head">
        <ExperienceLogo lit compact />
        <input className="panel-search" type="search" value={query} onChange={(e) => setPanelQuery(e.target.value)} placeholder={t("panel.search")} autoComplete="off" spellCheck={false} data-testid="panel-search" />
        <button type="button" className="chip" onClick={closePanel} data-testid="panel-close">
          {t("panel.close")} <kbd>{t("key.esc")}</kbd>
        </button>
      </header>
      <RoomBar />

      {opened ? (
        // Une fiche qui ne se dessine pas (une donnée inattendue) ne doit pas emporter le panneau.
        <ErrorBoundary key={opened.key} fallback={<p className="panel-note panel-pad">{t("panel.failed")}</p>}>
          <Detail title={opened} />
        </ErrorBoundary>
      ) : (
        <div className="panel-scroll">
          {active ? (
            <NowPlaying />
          ) : null}
          <Games />
          {failed ? <p className="panel-note">{t("panel.failed")}</p> : null}
          {!lib && !failed ? <p className="panel-note">{t("panel.loading")}…</p> : null}
          {lib && results ? (
            <section>
              <h3>{t("panel.results")}</h3>
              {results.length ? (
                <div className="grid">
                  {results.map((title) => (
                    <Poster key={title.key} title={title} onOpen={() => openTitle(title)} />
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
                    <Poster key={title.key} title={title} onOpen={() => openTitle(title)} />
                  ))}
                </div>
              </section>
              <section>
                <div className="chips">
                  <button type="button" className={tab === "movies" ? "chip chip-on" : "chip"} onClick={() => setPanelTab("movies")}>
                    {t("panel.movies")} <span className="count">{lib.movies.length}</span>
                  </button>
                  <button type="button" className={tab === "series" ? "chip chip-on" : "chip"} onClick={() => setPanelTab("series")}>
                    {t("panel.series")} <span className="count">{lib.series.length}</span>
                  </button>
                </div>
                <div className="grid">
                  {browse.map((title) => (
                    <Poster key={title.key} title={title} onOpen={() => openTitle(title)} />
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
