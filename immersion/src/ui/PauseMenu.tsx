import { useStore, useT } from "../state/store";
import { lockPointer } from "../world/Controls";
import { ExperienceLogo } from "./Logo";
import { Settings } from "./Settings";

/**
 * Le menu pause : ouvert par Échap (qui rend le pointeur). « Reprendre » redemande le pointeur — le
 * clic est le geste qu'il faut pour ça.
 */
export function PauseMenu({ onQuit }: { onQuit: () => void }) {
  const t = useT();
  const view = useStore((s) => s.pauseView);
  const setView = useStore((s) => s.setPauseView);

  return (
    <div className="veil" data-testid="pause">
      <div className={`card pause${view === "settings" ? " is-wide" : ""}`}>
        <ExperienceLogo lit compact />
        {view === "menu" ? (
          <nav className="pause-actions">
            <button type="button" className="btn btn-primary" onClick={lockPointer} autoFocus data-testid="resume">
              {t("pause.resume")}
            </button>
            <button type="button" className="btn" onClick={() => setView("settings")} data-testid="open-settings">
              {t("pause.settings")}
            </button>
            <button type="button" className="btn btn-quiet" onClick={onQuit} data-testid="quit">
              {t("pause.quit")}
            </button>
          </nav>
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
