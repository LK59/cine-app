import type { ReactNode, CSSProperties } from "react";

// Pure CSS horizontal scroll container.
// touch-action: manipulation on child cards removes iOS tap-delay so
// horizontal swipe is detected instantly from any touch point.
export function HorizontalCarousel({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}
