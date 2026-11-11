import type { PointerEvent } from "react";
import { isTouchDevice } from "../lib/capability";
import { acceptPrompt, COUNTDOWN_S, dismissPrompt } from "../media/upNext";
import { useStore, useT } from "../state/store";

/**
 * L'invite du moment, au bord de l'image : « Passer l'intro / le récap », la carte de l'épisode suivant et son
 * décompte, ou la question après trois enchaînements. Ce qui décide de la montrer vit dans `media/upNext.ts` ;
 * ce composant ne fait que la dessiner.
 *
 * Le pointeur verrouillé ne clique rien : à l'ordinateur, Entrée accepte et Retour arrière écarte (les touches
 * sont affichées) ; les boutons servent au doigt et quand la télécommande a rendu le pointeur.
 */
export function Prompts() {
  const t = useT();
  const prompt = useStore((s) => s.prompt);
  const pointerFree = useStore((s) => s.mode === "remote");
  if (!prompt) return null;
  const keys = !isTouchDevice() && !pointerFree;
  const press = (act: () => void) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    act();
  };

  if (prompt.kind === "skip") {
    return (
      <div className="prompts">
        <button type="button" className="prompt-pill" onPointerDown={press(acceptPrompt)} data-testid="prompt-skip">
          {t(prompt.what === "recap" ? "prompt.skipRecap" : "prompt.skipIntro")}
          {keys ? <kbd>{t("key.enter")}</kbd> : null}
        </button>
      </div>
    );
  }

  if (prompt.kind === "stillThere") {
    return (
      <div className="prompts">
        <div className="prompt-card" data-testid="prompt-still">
          <p className="prompt-heading">{t("prompt.stillThere")}</p>
          <p className="prompt-title">{prompt.title}</p>
          <div className="prompt-actions">
            <button type="button" className="btn btn-primary" onPointerDown={press(acceptPrompt)}>
              {t("prompt.continue")}
              {keys ? <kbd>{t("key.enter")}</kbd> : null}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prompts">
      <div className="prompt-card" data-testid="prompt-next">
        <p className="prompt-heading">
          {t("prompt.next")} · <span className="tabular" data-testid="prompt-countdown">{prompt.countdown}</span> s
        </p>
        <p className="prompt-title">{prompt.title}</p>
        <span className="prompt-meter" aria-hidden>
          <span style={{ transform: `scaleX(${prompt.countdown / COUNTDOWN_S})` }} />
        </span>
        <div className="prompt-actions">
          <button type="button" className="btn btn-primary" onPointerDown={press(acceptPrompt)} data-testid="prompt-play">
            ▶ {t("prompt.playNow")}
            {keys ? <kbd>{t("key.enter")}</kbd> : null}
          </button>
          <button type="button" className="btn btn-quiet" onPointerDown={press(dismissPrompt)} data-testid="prompt-dismiss">
            {t("prompt.watchCredits")}
            {keys ? <kbd>⌫</kbd> : null}
          </button>
        </div>
      </div>
    </div>
  );
}
