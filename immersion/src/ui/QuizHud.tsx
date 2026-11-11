import type { PointerEvent } from "react";
import type { Key } from "../lib/i18n";
import { answerQuiz, startQuiz, stopQuiz } from "../game/quiz";
import { isTouchDevice } from "../lib/capability";
import { useStore, useT } from "../state/store";

/**
 * Les quatre réponses de « Devine le film », sur l'écran de chacun (la question est sur la télévision) : touches 1 à
 * 4 au clavier — sans libérer le curseur, on continue de marcher —, boutons au doigt ou à la souris quand le pointeur
 * est libre. Après la manche : bonne réponse ou non, et les points ; à la fin : son rang, rejouer, fermer.
 */
export function QuizHud() {
  const t = useT();
  const quiz = useStore((s) => s.quiz);
  if (!quiz) return null;
  const { view, choice, you } = quiz;
  const me = view.players.find((p) => p.id === you);
  const keys = !isTouchDevice();
  const press = (act: () => void) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    act();
  };

  if (view.phase === "end") {
    const rank = view.players.findIndex((p) => p.id === you) + 1;
    return (
      <div className="quiz-hud" data-testid="quiz-end">
        <p className="quiz-status">
          {t("quiz.end")} · {me?.score ?? 0} {t("quiz.points")}
          {view.players.length > 1 && rank ? ` · ${rank}/${view.players.length}` : ""}
          {quiz.recorded ? ` · ${t("quiz.recorded")}` : ""}
        </p>
        <div className="quiz-actions">
          <button type="button" className="btn btn-primary" onPointerDown={press(() => void startQuiz(view.variant))} data-testid="quiz-again">
            {t("quiz.again")}
          </button>
          <button type="button" className="btn" onPointerDown={press(stopQuiz)} data-testid="quiz-close">
            {t("quiz.close")}
          </button>
        </div>
      </div>
    );
  }
  if (view.phase === "intro" || !view.clue) {
    return (
      <div className="quiz-hud" data-testid="quiz-hud">
        <p className="quiz-status">
          {t("quiz.title")} · {t(`quiz.variant.${view.variant}` as Key)}
        </p>
      </div>
    );
  }
  const answer = view.answer;
  const gain = view.gains?.[you] ?? 0;
  const status =
    view.phase === "reveal"
      ? choice === answer
        ? `${t("quiz.right")} +${gain}`
        : `${choice === null ? t("quiz.timeout") : t("quiz.wrong")} ${view.clue.choices[answer ?? 0]}`
      : choice !== null
        ? t("quiz.sent")
        : keys
          ? t("quiz.keys")
          : "";
  return (
    <div className="quiz-hud" data-testid="quiz-hud">
      <div className="quiz-choices">
        {view.clue.choices.map((title, i) => (
          <button
            key={i}
            type="button"
            className={`quiz-choice${choice === i ? " is-mine" : ""}${answer === i ? " is-right" : ""}`}
            disabled={view.phase !== "question" || choice !== null}
            onPointerDown={press(() => answerQuiz(i))}
            data-testid={`quiz-choice-${i + 1}`}
          >
            <kbd>{i + 1}</kbd> {title}
          </button>
        ))}
      </div>
      <p className="quiz-status" data-testid="quiz-status">
        {status}
        {me ? ` · ${me.score} ${t("quiz.points")}` : ""}
      </p>
    </div>
  );
}
