"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

/**
 * Une capture en grand, sans quitter l'application.
 *
 * Elle s'ouvrait dans un nouvel onglet (`target="_blank"`). Dans l'application installée sur un
 * iPhone, un nouvel onglet est Safari, qui n'a pas la session de l'application : la capture
 * répondait « non authentifié ». Montrée ici, elle passe par la session de l'application ;
 * l'original reste proposé en téléchargement.
 */
export function ImageViewer({ src, originalUrl, name, onClose }: { src: string; originalUrl: string; name: string | null; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    // En capture, et avant le panneau : Échap referme la capture, pas le panneau dessous.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name ?? t("report.ui.image")}
      className="fixed inset-0 z-[80] flex flex-col bg-black pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center justify-end gap-2 p-3">
        <a
          href={originalUrl}
          download={name ?? true}
          onClick={(e) => e.stopPropagation()}
          className="btn btn-ghost px-3 py-2 text-sm"
        >
          <Download size={15} />
          {t("report.ui.original")}
        </a>
        <button type="button" onClick={onClose} aria-label={t("report.ui.closeImage")} className="btn btn-ghost px-3 py-2">
          <X size={18} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- servie par notre route, déjà réduite */}
        <img src={src} alt={name ?? ""} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
      </div>
    </div>,
    document.body
  );
}
