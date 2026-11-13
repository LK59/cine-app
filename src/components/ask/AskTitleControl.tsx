"use client";

import { useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { AskPanel } from "@/components/ask/AskPanel";
import { useAskAvailable } from "@/lib/ask/client";
import { MENU_BADGE, MENU_ROW, MENU_ROW_INACTIVE } from "@/components/cinema/detailMenu";
import { ROUND_ACTION } from "@/components/cinema/roundAction";

/**
 * « Poser une question » sur une fiche de titre (DECISIONS.md §139) — la seule pièce que les fiches
 * appellent : la fiche film et la fiche série du bureau (`row`, une ligne de leur menu), la fiche du
 * téléphone, film et série (`icon`, à côté de « À voir » et « Vu ») ; depuis 10.27, un bouton rond de la
 * rangée des fiches du bureau (`round`, `DetailIconActions`). Elle décide seule si elle existe
 * (l'option, Fire TV — `useAskAvailable`), ouvre le même panneau que le lecteur, et ne recopie rien.
 */
export function AskTitleControl({ itemId, variant }: { itemId: string | null | undefined; variant: "row" | "icon" | "round" }) {
  const t = useT();
  const available = useAskAvailable();
  const [open, setOpen] = useState(false);
  if (!available || !itemId) return null;
  const label = t("ask.title");
  return (
    <>
      {variant === "round" ? (
        // Une légende sous le rond, comme « Vu », « À voir » et « Infos » (Louis, 13/11/2026) : c'était le seul
        // rond de la rangée sans texte. Un mot court sur une ligne, caché aux lecteurs d'écran qui ont déjà
        // l'`aria-label` — la forme de `TitleToggleRound`.
        <div data-round-toggle="" className="flex min-w-14 flex-col items-center gap-1">
          <button type="button" data-detail-menu data-ask-open="" data-round-action="ask" aria-label={label} title={label} onClick={() => setOpen(true)} className={ROUND_ACTION}>
            <MessageCircleQuestion size={19} />
          </button>
          <span aria-hidden="true" data-round-caption="" className="whitespace-nowrap text-center text-[11px] leading-tight text-muted">
            {t("ask.caption")}
          </span>
        </div>
      ) :variant === "row" ? (
        <button type="button" data-detail-menu data-ask-open="" onClick={() => setOpen(true)} className={`${MENU_ROW} ${MENU_ROW_INACTIVE}`}>
          <span className={MENU_BADGE}>
            <MessageCircleQuestion size={14} />
          </span>
          <span className="text-sm font-medium">{label}</span>
        </button>
      ) : (
        <button type="button" data-ask-open="" onClick={() => setOpen(true)} data-liquid-pan="icon" className="flex w-16 flex-col items-center gap-1.5">
          <MessageCircleQuestion size={22} className="text-white" />
          <span className="text-center text-xs leading-tight text-muted">{label}</span>
        </button>
      )}
      {open && <AskPanel key={itemId} itemId={itemId} where="fiche" placement="sheet" onClose={() => setOpen(false)} />}
    </>
  );
}
