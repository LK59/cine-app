"use client";

import { Loader2, AlertTriangle, Inbox, WifiOff } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

export function LoadingState({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 py-12 text-sm text-slate-400">
      <Loader2 size={18} className="animate-spin" />
      {label ?? t('common.loading')}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="card flex items-center gap-3 p-4 text-sm text-red-400">
      <AlertTriangle size={18} />
      {message}
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-sm text-slate-500">
      <Inbox size={24} />
      {label}
    </div>
  );
}

/**
 * ServiceDownBanner — inline non-blocking notice when a service is unreachable.
 * Does not prevent the rest of the page from rendering.
 */
export function ServiceDownBanner({ service, error }: { service: string; error?: string | null }) {
  const t = useT();
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-400">
      <WifiOff size={14} className="shrink-0" />
      <span>
        {t('common.serviceDown', { service })}
        {error ? ` — ${error}` : ""}
      </span>
    </div>
  );
}
