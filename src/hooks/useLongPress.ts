import { useRef, useCallback } from "react";
import { haptic } from "@/lib/haptic";

export function useLongPress(onLongPress: () => void, delay = 480) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moved = useRef(false);
  const fired = useRef(false);

  const start = useCallback(() => {
    moved.current = false;
    fired.current = false;
    timer.current = setTimeout(() => {
      if (!moved.current) {
        fired.current = true;
        haptic(30);
        onLongPress();
      }
    }, delay);
  }, [onLongPress, delay]);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return {
    onTouchStart: start,
    onTouchEnd: cancel,
    onTouchMove: () => { moved.current = true; cancel(); },
    // Prevent Link navigation if long press already fired
    onClick: (e: React.MouseEvent) => {
      if (fired.current) { e.preventDefault(); fired.current = false; }
    },
    // Desktop: right-click
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      haptic(30);
      onLongPress();
    },
  };
}
