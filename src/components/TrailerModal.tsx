"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDelayedClose } from "@/lib/useDelayedClose";

export function TrailerModal({ youtubeKey, title, onClose, localTrailerUrl }: {
  youtubeKey: string;
  title: string;
  onClose: () => void;
  // A locally-downloaded file (see trailerDownload.ts) is preferred when available — instant
  // start, no iframe chrome, native <video> seeking. Falls back to the YouTube embed when null.
  localTrailerUrl?: string | null;
}) {
  // Self-contained exit animation — see the hook's own doc comment. No change needed on any of
  // this modal's callers: they still just pass onClose and it still fires eventually, just after
  // a short fade instead of instantly.
  const { closing, requestClose } = useDelayedClose(onClose, 210);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-70 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      onClick={requestClose}
    >
      <div
        className={`relative w-full max-w-4xl ${closing ? "animate-fade-out-scale" : "animate-fade-in-scale"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-medium text-white truncate pr-4">{title}</p>
          <button
            onClick={requestClose}
            className="shrink-0 rounded-lg bg-white/10 p-1.5 text-slate-300 hover:bg-white/20"
          >
            <X size={16} />
          </button>
        </div>
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10">
          {localTrailerUrl ? (
            <video
              src={localTrailerUrl}
              controls
              autoPlay
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${youtubeKey}?autoplay=1&rel=0`}
              title={title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
