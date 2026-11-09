"use client";

import { useState } from "react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { initialsOf, personFactsLine, usePersonFacts } from "@/lib/xray/client";
import { useSofar } from "@/lib/ask/client";
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
 * Le panneau d'une personne d'« À l'écran » (DECISIONS.md §138, 10.27), de haut en bas : l'en-tête (photo,
 * acteur, personnage) ; « Jusqu'ici » (seulement avec les questions, §139 : deux phrases d'après ce qui a
 * été vu, une ligne d'attente puis le texte — rien du tout s'il ne vient pas) ; la ligne de faits (âge, lieu
 * de naissance) et une courte biographie, coupée à trois lignes (le chemin des fiches personne du cinéma) ;
 * « Dans votre bibliothèque » — deux ou trois affiches de ses autres titres, **qui ne réagissent à rien**
 * (ni bouton, ni lien, ni survol, ni menu au long appui : une information, pas une porte vers une fiche
 * pendant le film).
 *
 * Le panneau s'ouvre tout de suite avec l'en-tête ; le reste arrive quand il arrive, sans rien déplacer
 * au-dessus de lui.
 */
export function AskPersonBlock({ itemId, person, sofar, position }: { itemId: string; person: XrayPlayerPerson; sofar: boolean; position: number | null }) {
  const t = useT();
  const { locale } = useLocale();
  const facts = usePersonFacts(itemId, person.personId);
  const sofarView = useSofar(itemId, person.personId, position, sofar);
  // Lu une fois : l'horloge n'a pas sa place dans un rendu (règle du compilateur React).
  const [now] = useState(() => Date.now());
  const ok = facts?.status === "ok" ? facts : null;
  const line = ok ? personFactsLine(ok, locale, t, now) : null;
  const library = ok?.library ?? [];
  return (
    <div data-ask-person={person.personId} className="flex flex-col gap-3 pb-3">
      <div className="flex items-center gap-3">
        <PersonAvatar person={person} className="h-12 w-12 text-sm" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold leading-tight text-white">{person.name}</span>
          {person.character && <span className="truncate text-[13px] leading-tight text-white/60">{person.character}</span>}
        </div>
      </div>
      {sofar && sofarView.state !== "none" && (
        <div data-ask-sofar={sofarView.state} className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[.14em] text-white/55">{t("xray.sofar")}</span>
          {sofarView.state === "waiting" ? (
            <p className="animate-pulse text-sm leading-5 text-white/55">{t("ask.thinking")}</p>
          ) : (
            <p className="text-sm leading-5 text-white">{sofarView.text}</p>
          )}
        </div>
      )}
      {(line || ok?.bio) && (
        <div data-ask-person-facts="" className="flex flex-col gap-1">
          {line && <p className="text-[13px] leading-5 text-white/70">{line}</p>}
          {ok?.bio && <p className="line-clamp-3 text-[13px] leading-5 text-white/60">{ok.bio}</p>}
        </div>
      )}
      {library.length > 0 && (
        <div data-ask-person-library="" className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[.14em] text-white/55">{t("xray.library")}</span>
          <div className="pointer-events-none flex select-none gap-2">
            {library.map((c) => (
              <div key={`${c.mediaType}:${c.tmdbId}`} data-library-poster="" className="ask-library-poster w-16 shrink-0">
                {c.poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.poster} alt={c.title} draggable={false} loading="lazy" decoding="async" className="aspect-[2/3] w-full rounded-md object-cover" />
                ) : (
                  <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md bg-white/10 p-1 text-center text-[10px] leading-tight text-white/70">{c.title}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
