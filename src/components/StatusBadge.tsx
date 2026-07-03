export function StatusBadge({ up, label }: { up: boolean; label?: string }) {
  return (
    <span
      className={`badge ${
        up ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${up ? "bg-emerald-400" : "bg-red-400"}`} />
      {label ?? (up ? "En ligne" : "Hors ligne")}
    </span>
  );
}
