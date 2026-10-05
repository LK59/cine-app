"use client";

import { useEffect, useState } from "react";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";

/**
 * Le tout premier écran : « Bonjour » qui défile dans les langues de l'application, comme le
 * premier allumage d'un iPhone, puis le choix de la langue (demandé le 05/10/2026).
 *
 * Avant toute connexion, et avant même de savoir quelle langue parler : rien ici ne passe par les
 * dictionnaires. Chaque mot entre en fondu, flou et légèrement agrandi, puis sort — l'opacité, le
 * flou et l'échelle sur le mot lui-même, rien d'autre ne bouge. « Réduire les animations » : les
 * mots se remplacent sans mouvement.
 */
const HELLO: Record<Locale, string> = { fr: "Bonjour", en: "Hello", es: "Hola", de: "Hallo" };
const WORD_MS = 1700;

export function HelloIntro({ current, busy, onChoose }: { current: Locale; busy: Locale | null; onChoose: (locale: Locale) => void }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setIndex((i) => (i + 1) % LOCALES.length), WORD_MS);
    return () => window.clearInterval(id);
  }, []);
  const word = HELLO[LOCALES[index]];

  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative flex h-28 items-center justify-center sm:h-36" aria-live="off">
        <span
          key={index}
          lang={LOCALES[index]}
          className="hello-word font-display text-6xl font-semibold tracking-tight text-transparent sm:text-7xl"
        >
          {word}
        </span>
      </div>
      <div className="mt-10 grid w-full max-w-sm grid-cols-2 gap-2.5">
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            disabled={busy !== null}
            onClick={() => onChoose(l)}
            className={`btn justify-center py-3 ${l === current ? "btn-primary" : "btn-ghost"}`}
          >
            {LOCALE_LABELS[l]}
          </button>
        ))}
      </div>
    </div>
  );
}
