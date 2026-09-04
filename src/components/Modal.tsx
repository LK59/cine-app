"use client";

import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

  const closeAnimated = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const card = cardRef.current;
    const backdrop = backdropRef.current;
    if (card) {
      card.style.transition = "transform 0.24s cubic-bezier(0.4, 0, 1, 1)";
      card.style.transform = "translateY(120%)";
    }
    if (backdrop) {
      backdrop.style.transition = "opacity 0.24s ease-out";
      backdrop.style.opacity = "0";
    }
    setTimeout(onClose, 240);
  }, [onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeAnimated();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAnimated]);

  // Native drag-to-close: card follows finger from the handle area
  useEffect(() => {
    const card = cardRef.current;
    const backdrop = backdropRef.current;
    if (!card) return;

    // The entrance animation (animate-fade-in-scale / animate-fade-in) uses
    // fill-mode "both", so its final transform/opacity value keeps overriding
    // any inline style we set afterwards (drag, programmatic close) until the
    // animation itself is dropped. Clear it once it finishes so the drag and
    // close logic below can actually move these elements.
    const dropAnimation = (e: AnimationEvent) => {
      (e.currentTarget as HTMLElement).style.animation = "none";
    };
    card.addEventListener("animationend", dropAnimation);
    backdrop?.addEventListener("animationend", dropAnimation);

    const handle = card.querySelector<HTMLElement>("[data-drag-handle]");
    if (!handle) {
      return () => {
        card.removeEventListener("animationend", dropAnimation);
        backdrop?.removeEventListener("animationend", dropAnimation);
      };
    }

    let startY = 0;
    let startTime = 0;
    let dragging = false;

    const onStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      startTime = Date.now();
      dragging = true;
      card.style.transition = "none";
      if (backdrop) backdrop.style.transition = "none";
    };

    const onMove = (e: TouchEvent) => {
      if (!dragging) return;
      e.preventDefault(); // block pull-to-refresh while on handle
      const delta = Math.max(0, e.touches[0].clientY - startY);
      card.style.transform = `translateY(${delta}px)`;
      if (backdrop) backdrop.style.opacity = String(Math.max(0, 1 - delta / 320));
    };

    const onEnd = (e: TouchEvent) => {
      if (!dragging) return;
      dragging = false;
      const dy = e.changedTouches[0].clientY - startY;
      const velocity = dy / Math.max(1, Date.now() - startTime); // px/ms

      // Close on quick flick OR large drag
      if (velocity > 0.45 || dy > 130) {
        closingRef.current = true;
        card.style.transition = "transform 0.24s cubic-bezier(0.4, 0, 1, 1)";
        card.style.transform = "translateY(120%)";
        if (backdrop) {
          backdrop.style.transition = "opacity 0.24s ease-out";
          backdrop.style.opacity = "0";
        }
        setTimeout(onClose, 240);
      } else {
        // Smooth spring-back — iOS-feel without overshoot
        card.style.transition = "transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)";
        card.style.transform = "translateY(0)";
        if (backdrop) {
          backdrop.style.transition = "opacity 0.42s cubic-bezier(0.22, 1, 0.36, 1)";
          backdrop.style.opacity = "1";
        }
      }
    };

    handle.addEventListener("touchstart", onStart, { passive: true });
    handle.addEventListener("touchmove", onMove, { passive: false });
    handle.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      handle.removeEventListener("touchstart", onStart);
      handle.removeEventListener("touchmove", onMove);
      handle.removeEventListener("touchend", onEnd);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-xs animate-fade-in sm:items-center sm:p-4"
      onClick={closeAnimated}
      style={{ touchAction: "none" }}
    >
      <div
        ref={cardRef}
        className={`card scrollbar-thin w-full animate-fade-in-scale overflow-y-auto p-5 overscroll-contain rounded-t-2xl sm:rounded-2xl
          max-h-[80dvh] sm:max-h-[85vh] ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
        style={{ touchAction: "auto" }}
      >
        {/* Drag handle — large hit area on mobile so it's easy to grab */}
        <div
          data-drag-handle
          className="mb-1 -mx-5 -mt-5 flex cursor-grab flex-col items-center pt-5 pb-4 sm:hidden"
        >
          <div className="h-1 w-14 rounded-full bg-white/30" />
        </div>

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button onClick={closeAnimated} className="btn btn-ghost btn-icon p-1">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
