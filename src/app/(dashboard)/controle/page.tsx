import { LibraryCheck } from "@/components/gestion/LibraryCheck";

// Infrastructure → Contrôle de la bibliothèque (DECISIONS.md §90) : lecture seule, administrateur seul
// (la route le vérifie, et `proxy.ts` la range dans `ADMIN_ONLY_READS`).
export default function LibraryCheckPage() {
  return <LibraryCheck />;
}
