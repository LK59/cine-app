"use client";

import { useT } from "@/components/TranslationProvider";

export function StatusBadge({ up, label }: { up: boolean; label?: string }) {
  const t = useT();
  return (
    <span
      className={`badge ${
        up ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${up ? "bg-emerald-400" : "bg-red-400"}`} />
      {label ?? (up ? t('health.statusOnline') : t('health.statusOffline'))}
    </span>
  );
}
