import { useStore, useT } from "../state/store";
import { quit, resumeVisit } from "../state/actions";
import { ExperienceLogo } from "./Logo";
import { Settings } from "./Settings";
import { Salons } from "./Salons";
import { Stats } from "./Stats";

/**
 * Le menu pause : ouvert par Échap (qui rend le pointeur). « Reprendre » redemande le pointeur — le
 * clic est le geste qu'il faut pour ça.
 */
export function PauseMenu() {
  const t = useT();
  const view = useStore((s) => s.pauseView);
  const setView = useStore((s) => s.setPauseView);

  return (
    <div className="veil" data-testid="pause">
      <div className={`card pause${view !== "menu" ? " is-wide" : ""}`}>
        <ExperienceLogo lit compact />
        {view === "menu" ? (
          <nav className="pause-actions">
            <button type="button" className="btn btn-primary" onClick={resumeVisit} autoFocus data-testid="resume">
              {t("pause.resume")}
            </button>
            <button type="button" className="btn" onClick={() => setView("salons")} data-testid="open-salons">
              {t("pause.salons")}
            </button>
            <button type="button" className="btn" onClick={() => setView("stats")} data-testid="open-stats">
              {t("pause.stats")}
            </button>
            <button type="button" className="btn" onClick={() => setView("settings")} data-testid="open-settings">
              {t("pause.settings")}
            </button>
            <button type="button" className="btn btn-quiet" onClick={quit} data-testid="quit">
              {t("pause.quit")}
            </button>
          </nav>
        ) : view === "stats" ? (
          <>
            <h2 className="pause-title">{t("stats.title")}</h2>
            <Stats />
            <nav className="pause-actions">
              <button type="button" className="btn" onClick={() => setView("menu")} data-testid="stats-back">
                ← {t("panel.back")}
              </button>
            </nav>
          </>
        ) : view === "salons" ? (
          <>
            <h2 className="pause-title">{t("salons.title")}</h2>
            <Salons />
            <nav className="pause-actions">
              <button type="button" className="btn" onClick={() => setView("menu")} data-testid="salons-back">
                ← {t("panel.back")}
              </button>
            </nav>
          </>
        ) : (
          <>
            <h2 className="pause-title">{t("settings.title")}</h2>
            <Settings />
            <nav className="pause-actions">
              <button type="button" className="btn" onClick={() => setView("menu")} data-testid="settings-back">
                ← {t("panel.back")}
              </button>
            </nav>
          </>
        )}
      </div>
    </div>
  );
}
