"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { CircleCheck, CircleX, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";
interface Toast { id: string; message: string; type: ToastType }

const ToastContext = createContext<{
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}>({ success: () => {}, error: () => {}, info: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
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
      <div className="fixed bottom-20 right-4 z-100 flex flex-col gap-2 md:bottom-6 md:right-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium text-white shadow-2xl backdrop-blur-xs ${
              t.type === "success"
                ? "bg-emerald-600/95 ring-1 ring-emerald-500/50"
                : t.type === "info"
                  ? "bg-sky-700/95 ring-1 ring-sky-500/50"
                  : "bg-red-700/95 ring-1 ring-red-500/50"
            }`}
          >
            {t.type === "success" ? (
              <CircleCheck size={16} className="shrink-0" />
            ) : t.type === "info" ? (
              <Info size={16} className="shrink-0" />
            ) : (
              <CircleX size={16} className="shrink-0" />
            )}
            <span>{t.message}</span>
            <button
              onClick={() => remove(t.id)}
              className="ml-1 shrink-0 opacity-60 hover:opacity-100"
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
