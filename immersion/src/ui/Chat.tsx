import { useEffect, useRef, useState } from "react";
import { sendChat } from "../net/salons";
import { useStore, useT } from "../state/store";

/** Combien de temps un message reste affiché (saisie fermée). */
const SHOWN_MS = 10_000;

/**
 * Le chat du salon (DECISIONS.md §146), à la façon d'un jeu : T ouvre la saisie, Entrée envoie, Échap ou un clic
 * ailleurs referme ; les messages s'affichent en bas à gauche et s'effacent au bout de dix secondes — saisie ouverte,
 * les derniers restent. Rien hors d'un salon ; rien n'est gardé une fois le salon quitté.
 *
 * La saisie a le clavier : les touches tapées ne font ni marcher ni agir (`keyboardMouse.ts` ignore une frappe dans
 * un champ), et le regard reste à la souris.
 */
export function Chat() {
  const t = useT();
  const inRoom = useStore((s) => !!s.net.room);
  const lines = useStore((s) => s.net.chat);
  const open = useStore((s) => s.chatOpen);
  const setOpen = useStore((s) => s.setChatOpen);
  const [text, setText] = useState("");
  const [, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Les messages s'effacent d'eux-mêmes : un rendu par seconde tant qu'il y en a d'affichés.
  useEffect(() => {
    if (!lines.length) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [lines.length]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!inRoom && open) setOpen(false);
  }, [inRoom, open, setOpen]);

  if (!inRoom) return null;
  const now = Date.now();
  const shown = open ? lines.slice(-10) : lines.filter((l) => now - l.at < SHOWN_MS).slice(-6);
  return (
    <div className={`chat${open ? " is-open" : ""}`} data-testid="chat">
      <ol className="chat-lines">
        {shown.map((l, i) => (
          <li key={`${l.at}-${i}`}>
            <strong>{l.name}</strong> {l.text}
          </li>
        ))}
      </ol>
      {open ? (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            sendChat(text);
            setText("");
            setOpen(false);
          }}
        >
          <input
            ref={input}
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            onBlur={() => setOpen(false)}
            placeholder={t("chat.placeholder")}
            autoComplete="off"
            data-testid="chat-input"
          />
        </form>
      ) : null}
    </div>
  );
}
