import { Loader2 } from "lucide-react";

export default function DashboardLoading() {
  return (
    <div className="flex items-center gap-2 py-12 text-sm text-slate-400">
      <Loader2 size={18} className="animate-spin" />
      Chargement...
    </div>
  );
}
