"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { CircleCheck, CircleX, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";
interface Toast { id: string; message: string; type: ToastType; leaving?: boolean }

/**
 * Combien de temps un toast reste monté pour sa sortie — la durée de `animate-fade-out`
 * (globals.css). Il était retiré d'un coup, sans entrée ni sortie, et la pile sautait (23/09/2026).
 */
const TOAST_EXIT_MS = 200;

const ToastContext = createContext<{
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}>({ success: () => {}, error: () => {}, info: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Retirer, c'est d'abord faire sortir : le toast s'efface, puis quitte la pile. Une seconde
  // demande pendant la sortie (la croix, puis le minuteur) ne relance rien — le retrait, lui, ne
  // porte que sur un toast déjà sorti, et deux retraits du même n'en font qu'un.
  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id && !t.leaving ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id || !t.leaving)), TOAST_EXIT_MS);
  }, []);

  const add = useCallback((message: string, type: ToastType) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => remove(id), 4000);
  }, [remove]);

  const success = useCallback((msg: string) => add(msg, "success"), [add]);
  const error = useCallback((msg: string) => add(msg, "error"), [add]);
  const info = useCallback((msg: string) => add(msg, "info"), [add]);

  return (
    <ToastContext.Provider value={{ success, error, info }}>
      {children}
      {/* Une pilule flottante, dans le matériau de la barre du bas et du rail (26/09/2026) : des
          rectangles pleins vert, bleu ou rouge, posés à droite sans rapport avec la barre. L'état
          passe par l'icône colorée ; la pile se centre au-dessus de la barre sur téléphone, et
          reste en bas à droite sur grand écran — voir `.toast-stack`. Sur téléphone la pile fait
          toute la largeur pour se centrer : elle laisse passer les appuis, seuls les messages en
          prennent. */}
      <div className="toast-stack pointer-events-none fixed z-100 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            // Annoncé aux lecteurs d'écran : une erreur interrompt, le reste attend son tour.
            role={t.type === "error" ? "alert" : "status"}
            // Le rayon du rail, pas `rounded-full` : sur une ligne c'est une pilule, et un message
            // qui passe à la ligne reste une carte aux coins ronds au lieu d'un ovale.
            style={{ borderRadius: "1.5rem" }}
            className={`player-bar pointer-events-auto flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-3 py-3 pl-4 pr-3 text-sm font-medium text-white ${
              t.leaving ? "animate-fade-out" : "animate-fade-in-up"
            }`}
          >
            {t.type === "success" ? (
              <CircleCheck size={17} className="shrink-0 text-success" />
            ) : t.type === "info" ? (
              <Info size={17} className="shrink-0 text-accent-400" />
            ) : (
              <CircleX size={17} className="shrink-0 text-danger" />
            )}
            <span>{t.message}</span>
            <button
              onClick={() => remove(t.id)}
              className="ml-1 shrink-0 text-subtle transition-colors hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
