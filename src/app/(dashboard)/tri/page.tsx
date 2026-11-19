import { Tri } from "@/components/gestion/Tri";

// Infrastructure → Tri de la bibliothèque (DECISIONS.md §198) : administrateur seul (`proxy.ts` range
// `/tri` dans `ADMIN_ONLY_PAGES` et ses routes dans `ADMIN_ONLY_READS` ; chaque route vérifie aussi).
export default function TriPage() {
  return <Tri />;
}
