import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import { RequestHidePanel } from "@/components/gestion/RequestHidePanel";

export const dynamic = "force-dynamic";

// Jellyseerr → Masquage : les demandes cachées à un compte (`requestHide/`). Administrateur seul (la
// page est sous `/jellyseerr`, `ADMIN_ONLY_PAGES`) ; la fonction coupée, la page n'existe pas.
export default function RequestHidePage() {
  if (!config.requestHide.enabled) notFound();
  return <RequestHidePanel />;
}
