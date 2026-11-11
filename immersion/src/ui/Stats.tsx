import { useEffect, useState } from "react";
import type { Key } from "../lib/i18n";
import { useT } from "../state/store";

interface StatsBody {
  mine: { variant: string; games: number; best: number; bestStreak: number; correct: number; total: number; wins: number }[];
  board: { name: string; best: number; games: number; you: boolean }[];
}

/** Échap → Statistiques : ses parties de « Devine le film » par variante, et le classement de la maison. */
export function Stats() {
  const t = useT();
  const [body, setBody] = useState<StatsBody | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch("/api/quiz/stats", { credentials: "same-origin", cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<StatsBody>) : Promise.reject()))
      .then(setBody, () => setFailed(true));
  }, []);
  if (failed) return <p className="salons-note">{t("panel.failed")}</p>;
  if (!body) return <p className="salons-note">{t("salons.checking")}</p>;
  return (
    <div className="stats" data-testid="stats">
      <h3 className="salons-sub">{t("stats.mine")}</h3>
      {body.mine.length ? (
        <table className="stats-table">
          <tbody>
            {body.mine.map((m) => (
              <tr key={m.variant}>
                <th>{t(`quiz.variant.${m.variant}` as Key)}</th>
                <td>
                  {m.games} {t("stats.games")}
                </td>
                <td>
                  {t("stats.best")} {m.best}
                </td>
                <td>
                  {t("stats.streak")} {m.bestStreak}
                </td>
                <td>
                  {t("stats.accuracy")} {m.total ? Math.round((100 * m.correct) / m.total) : 0} %
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="salons-note">{t("stats.none")}</p>
      )}
      <h3 className="salons-sub">{t("stats.board")}</h3>
      {body.board.length ? (
        <ol className="stats-board" data-testid="stats-board">
          {body.board.map((b, i) => (
            <li key={i} className={b.you ? "is-you" : undefined}>
              <span>{b.name}</span>
              <span className="tabular">{b.best}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="salons-note">{t("stats.none")}</p>
      )}
    </div>
  );
}
