"use client";

import { Loader2 } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

// Client pour lire la langue du compte : ce mot s'affiche à chaque changement de page de la
// gestion, et il était écrit en français pour tout le monde.
export default function DashboardLoading() {
  const t = useT();
  return (
    <div className="flex items-center gap-2 py-12 text-sm text-slate-400">
      <Loader2 size={18} className="animate-spin" />
      {t("common.loading")}
    </div>
  );
}
