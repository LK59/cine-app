// Simple wrapper kept for potential future use — pull-to-refresh is now
// handled natively by Safari. The actor modal and Plus sheet block it
// locally via their own gesture handlers.
export function MainScroll({ children, className }: { children: React.ReactNode; className: string }) {
  return <main className={className}>{children}</main>;
}
