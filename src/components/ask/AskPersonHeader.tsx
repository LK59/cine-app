"use client";

import { useState } from "react";
import { useT } from "@/components/TranslationProvider";
import { initialsOf } from "@/lib/xray/client";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";

/**
 * La photo ronde d'une personne à l'écran (DECISIONS.md §138) — dans la rangée « À l'écran » et en tête du
 * panneau des questions. Une photo absente, ou qui ne charge pas, laisse les initiales : jamais d'image
 * cassée. `className` donne la taille.
 */
export function PersonAvatar({ person, className }: { person: Pick<XrayPlayerPerson, "name" | "photo">; className: string }) {
  const t = useT();
  // L'adresse qui a échoué, pas un booléen : une autre personne au même endroit retente sa photo.
  const [failed, setFailed] = useState<string | null>(null);
  const showPhoto = !!person.photo && failed !== person.photo;
  return (
    <span className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/15 text-[11px] font-semibold text-white/80 ${className}`}>
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={person.photo ?? undefined}
          alt={t("xray.photo", { name: person.name ?? "" })}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(person.photo)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden data-avatar-initials="">{initialsOf(person.name)}</span>
      )}
    </span>
  );
}

/**
 * L'en-tête du panneau « Poser une question » ouvert depuis une personne d'« À l'écran » : sa photo, le nom
 * de l'acteur, son personnage. La place en dessous (`data-ask-person-more`) est gardée pour ce qui viendra
 * — la biographie résumée de TMDB et « Jusqu'ici » (ce que le personnage a fait dans ce qui a été vu) —,
 * vide aujourd'hui.
 */
export function AskPersonHeader({ person }: { person: XrayPlayerPerson }) {
  return (
    <div data-ask-person={person.personId} className="flex flex-col gap-2 pb-3">
      <div className="flex items-center gap-3">
        <PersonAvatar person={person} className="h-12 w-12 text-sm" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold leading-tight text-white">{person.name}</span>
          {person.character && <span className="truncate text-[13px] leading-tight text-white/60">{person.character}</span>}
        </div>
      </div>
      <div data-ask-person-more="" hidden />
    </div>
  );
}
