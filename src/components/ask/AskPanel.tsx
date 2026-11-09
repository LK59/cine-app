"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { useAskTitle, type AskExchange } from "@/lib/ask/client";
import { restorePageScroll, useAskPanelLayout, LINE_HEIGHT_PX } from "@/lib/ask/viewport";
import { ASK_MAX_QUESTION, type AskWhere } from "@/lib/ask/core";

/**
 * Le panneau « Poser une question » (DECISIONS.md §139) — un seul, pour le lecteur (film en pause) et
 * pour toutes les fiches de titre.
 *
 * Un panneau de verre posé à droite, le film ou la fiche visibles à gauche ; une feuille en bas sur un
 * téléphone tenu debout. Les questions proposées d'abord (aucun clavier) ; pendant la frappe, le panneau
 * se réduit à la ligne du champ, posée au-dessus du clavier (`useAskPanelLayout`) ; à l'envoi le champ
 * rend le focus et la réponse arrive dans le panneau entier. Toucher hors du panneau le referme (ou, si
 * l'on écrit, referme seulement le clavier) ; Échap le referme.
 *
 * Ce qu'il tait autour de lui : il porte `data-action-sheet`, la marque qui fait taire les touches des
 * fiches (`sheetKeyBelongsElsewhere`, §117.1) ; ses touches ne remontent pas jusqu'à la fenêtre, où
 * écoute le clavier du lecteur (espace, flèches…) ; ses appuis ne remontent pas jusqu'à la surface du
 * lecteur (qui mettrait en pause) ni au geste de la fiche (qui la tirerait vers le bas).
 *
 * `header` : la place d'un en-tête au-dessus des échanges — prévue pour les acteurs à l'écran (§138 :
 * photo, nom, personnage, deux lignes, « Jusqu'ici »). Vide aujourd'hui.
 */
export interface AskPanelProps {
  itemId: string;
  where: AskWhere;
  /** La position du film au moment de la question (lecteur seulement). */
  position?: () => number | null;
  onClose: () => void;
  header?: ReactNode;
  /**
   * `player` : dans le conteneur du lecteur (plein écran compris), en absolu ; `sheet` : un portail
   * fixe posé sur la fiche.
   */
  placement: "player" | "sheet";
}

const SUGGESTIONS = {
  lecteur: ["ask.chipPlayer0", "ask.chipPlayer1", "ask.chipPlayer2"],
  fiche: ["ask.chipSheet0", "ask.chipSheet1", "ask.chipSheet2"],
} as const;

/** Ce que le panneau dit à la place d'une réponse qui n'est pas venue. */
export function askFailureKey(exchange: Pick<AskExchange, "state" | "error">): string | null {
  if (exchange.state === "rejected") return "ask.unknown";
  if (exchange.state !== "error") return null;
  if (exchange.error === "limite") return "ask.limit";
  if (exchange.error === "indisponible") return "ask.unavailable";
  if (exchange.error === "off") return "ask.off";
  return "ask.error";
}

export function AskPanel({ itemId, where, position, onClose, header, placement }: AskPanelProps) {
  const t = useT();
  const { exchanges, ask, busy, full } = useAskTitle({ itemId, where, position });
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const layout = useAskPanelLayout(focused);
  const layerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Où était la page à l'ouverture : remise après chaque clavier refermé, et au départ du panneau.
  const pageAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    pageAt.current = { x: window.scrollX, y: window.scrollY };
    return () => {
      if (pageAt.current) restorePageScroll(window, pageAt.current);
    };
  }, []);

  // Échap referme — à la capture, avant les écouteurs de la fiche et du lecteur, et arrêtée là.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Rien derrière ne défile au doigt : seul l'espace des réponses défile, et seulement s'il déborde.
  // Un écouteur natif, non passif : React pose les siens passifs, et iOS n'écoute qu'un `preventDefault`
  // fait avant de commencer à faire glisser la page.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    function onTouchMove(e: TouchEvent) {
      const scroller = scrollRef.current;
      if (scroller && e.target instanceof Node && scroller.contains(e.target) && scroller.scrollHeight > scroller.clientHeight) return;
      e.preventDefault();
    }
    layer.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => layer.removeEventListener("touchmove", onTouchMove);
  }, []);

  // Une réponse qui arrive se lit sans chercher : l'espace des réponses descend avec elle.
  const last = exchanges[exchanges.length - 1];
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && typeof scroller.scrollTo === "function") scroller.scrollTo({ top: scroller.scrollHeight });
  }, [exchanges.length, last?.answer, last?.state]);

  function submit(question: string) {
    if (!question.trim() || busy || full) return;
    void ask(question);
    setValue("");
    // Le clavier se referme : la réponse se lit dans le panneau entier, film visible.
    inputRef.current?.blur();
  }

  function onBlur() {
    setFocused(false);
    // Le clavier a fini de partir avant qu'on remette la page à sa place (iOS la laisse parfois décalée).
    window.setTimeout(() => {
      if (pageAt.current) restorePageScroll(window, pageAt.current);
    }, 350);
  }

  const line = layout.mode === "line";
  const asked = new Set(exchanges.map((e) => e.question));
  const chips = SUGGESTIONS[where].map((k) => t(k)).filter((q) => !asked.has(q));
  const style: React.CSSProperties = line
    ? { top: layout.top, height: LINE_HEIGHT_PX }
    : { top: layout.top, height: layout.height };

  const layer = (
    <div
      ref={layerRef}
      data-ask-layer=""
      data-action-sheet=""
      data-player-surface-ignore=""
      className={`${placement === "player" ? "absolute" : "fixed"} inset-0 select-text overscroll-none`}
      // En style et non en classe arbitraire (la note de `DesktopSheetShell`) : au-dessus des fiches (≤ 49)
      // et sous le lecteur (80) ; dans le lecteur, au-dessus de ses commandes et de ses invites (≤ 30).
      style={{ zIndex: placement === "player" ? 40 : 70 }}
      // Ni pause du lecteur, ni geste de la fiche, ni plein écran au double-clic : rien ne remonte.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Les touches du panneau sont à lui : l'espace écrit ou active une proposition, les flèches
        // bougent le curseur — jamais lecture, pause ni saut.
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      {/* Le film (ou la fiche) visible autour : le toucher referme — ou, pendant la frappe, referme le clavier. */}
      <div
        aria-hidden
        data-ask-backdrop=""
        className="absolute inset-0"
        onClick={() => {
          if (focused) inputRef.current?.blur();
          else onClose();
        }}
      />
      <section
        role="dialog"
        aria-label={t("ask.title")}
        data-ask-panel=""
        data-mode={line ? "line" : layout.sheet ? "sheet" : "side"}
        className={`ask-panel absolute flex flex-col overflow-hidden text-white ${
          line ? "ask-panel-line" : layout.sheet ? "ask-panel-sheet" : "ask-panel-side"
        }`}
        style={style}
      >
        {/* L'en-tête : le titre et la croix. Caché pendant la frappe (la ligne seule tient au-dessus du clavier). */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-4" hidden={line}>
          <h2 className="text-[15px] font-semibold">{t("ask.title")}</h2>
          <button
            type="button"
            data-ask-close=""
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/20"
          >
            <X size={18} />
          </button>
        </div>
        {header && (
          <div data-ask-header="" className="shrink-0 px-5" hidden={line}>
            {header}
          </div>
        )}
        <div ref={scrollRef} data-ask-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-3" hidden={line}>
          {exchanges.length === 0 ? (
            <p className="pt-1 text-sm leading-6 text-white/70">{t("ask.hint")}</p>
          ) : (
            <ol className="flex flex-col gap-4 pt-1" aria-live="polite">
              {exchanges.map((ex) => {
                const failure = askFailureKey(ex);
                return (
                  <li key={ex.id} data-ask-exchange={ex.state} className="flex flex-col gap-2">
                    <p className="ml-10 self-end rounded-2xl rounded-br-md bg-white/14 px-3 py-1.5 text-[13px] leading-5 text-white/90">{ex.question}</p>
                    {failure ? (
                      <p className="text-sm leading-6 text-white/70">{t(failure)}</p>
                    ) : ex.state === "waiting" ? (
                      <p className="animate-pulse text-sm leading-6 text-white/60">{t("ask.thinking")}</p>
                    ) : (
                      <p className="text-[15px] leading-6 text-white">{ex.answer}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {full && !busy && <p className="pt-4 text-xs leading-5 text-white/55">{t("ask.maxReached")}</p>}
        </div>
        {!full && chips.length > 0 && (
          <div data-ask-chips="" className="flex shrink-0 flex-wrap gap-2 px-5 pb-3" hidden={line}>
            {chips.map((q) => (
              <button
                key={q}
                type="button"
                disabled={busy}
                onClick={() => submit(q)}
                className="rounded-full bg-white/12 px-3 py-1.5 text-left text-[13px] leading-5 text-white transition-colors hover:bg-white/20 disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {/* Le champ reste le même nœud dans les deux formes : en changer ferait perdre le focus, et le
            clavier se refermerait aussitôt ouvert. */}
        <form
          className={`flex shrink-0 items-center gap-2 ${line ? "h-full px-2" : "px-4 pb-4"}`}
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <input
            ref={inputRef}
            data-ask-input=""
            type="text"
            value={value}
            maxLength={ASK_MAX_QUESTION}
            disabled={full}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={onBlur}
            placeholder={t("ask.placeholder")}
            aria-label={t("ask.placeholder")}
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="on"
            // 16 px au moins : en dessous, Safari agrandit la page au focus — et rien ne la remet.
            className="h-11 min-w-0 flex-1 rounded-full bg-white/12 px-4 text-base text-white placeholder:text-white/50 focus:bg-white/16 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            data-ask-send=""
            aria-label={t("ask.send")}
            disabled={!value.trim() || busy || full}
            // Appuyé, le bouton ne prend pas le focus : le champ le garderait sinon perdu avant l'envoi.
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-black transition-opacity disabled:opacity-40"
          >
            <ArrowUp size={20} strokeWidth={2.4} />
          </button>
        </form>
      </section>
    </div>
  );

  if (placement === "sheet") return typeof document === "undefined" ? null : createPortal(layer, document.body);
  return layer;
}
