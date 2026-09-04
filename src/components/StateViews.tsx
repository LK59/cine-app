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

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="card flex flex-col items-start gap-3 p-4 text-sm text-red-400 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <AlertTriangle size={18} className="shrink-0" />
        {message}
      </div>
      <button onClick={onRetry ?? (() => window.location.reload())} className="btn-ghost shrink-0">
        {t('common.retry')}
      </button>
    </div>
  );
}

/**
 * Rien à montrer — et une phrase pour dire pourquoi.
 *
 * Cinq écrans n'en avaient aucun : quand il n'y avait rien, il n'y avait *rien*. Un calendrier
 * sans sortie à venir ressemblait à un calendrier cassé. `hint` porte la raison, et `action`
 * la sortie quand il y en a une.
 */
export function EmptyState({
  label,
  hint,
  icon,
  action,
}: {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-center text-sm text-slate-500">
      <span className="text-slate-600">{icon ?? <Inbox size={24} />}</span>
      <p className="text-slate-400">{label}</p>
      {hint && <p className="max-w-sm text-xs leading-5 text-slate-600">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
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
