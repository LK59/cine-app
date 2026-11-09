"use client";

import { useEffect, useState } from "react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { initialsOf, personFactsLine, usePersonFacts } from "@/lib/xray/client";
import { useSofar, type SofarView } from "@/lib/ask/client";
import { sofarCut, type SofarScenes } from "@/lib/ask/sofarCut";
import { usePrefersReducedMotion } from "@/lib/reducedMotion";
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

/** L'écart entre deux lignes de l'attente : le temps de lire la précédente, jamais une attente imposée. */
export const SOFAR_WAIT_STEP_MS = 900;

/**
 * Les scènes où la personne est reconnue avant la coupe — ce que « Jusqu'ici » relit d'elle. Lu des scènes
 * que le lecteur a déjà (aucune requête) ; `null` sans scènes nommées.
 */
export function sofarSceneCount(scenes: SofarScenes | null | undefined, personId: number, position: number | null): number | null {
  if (!scenes?.scenes.length) return null;
  const cut = sofarCut(position, scenes);
  let n = 0;
  for (const s of scenes.scenes as readonly { start: number; people?: readonly { personId?: number }[] }[]) {
    if (s.start < cut && s.people?.some((p) => p.personId === personId)) n++;
  }
  return n;
}

/**
 * Les lignes de l'attente (10.28.0, consigne du propriétaire) : **rien d'inventé**, seulement ce qui part
 * vraiment au modèle — les scènes de la personne avant la coupe (lues localement), la fenêtre des résumés
 * (dite par le serveur dans `plan`), puis l'écriture, une fois la génération lancée. Aucun appel au modèle.
 */
export function sofarWaitLines(t: (key: string, vars?: Record<string, string | number>) => string, name: string, sceneCount: number | null, plan: SofarView["plan"]): string[] {
  const lines = [sceneCount && sceneCount > 0 ? t("xray.sofarWait.scenes", { n: sceneCount, name }) : t("xray.sofarWait.reading")];
  if (plan?.from) lines.push(plan.to && plan.to !== plan.from ? t("xray.sofarWait.episodes", { from: plan.from, to: plan.to }) : t("xray.sofarWait.episode", { code: plan.from }));
  if (plan) lines.push(t("xray.sofarWait.writing"));
  return lines;
}

/**
 * L'attente de « Jusqu'ici » (10.28.0) : des lignes gris clair qui paraissent l'une après l'autre, la dernière
 * parcourue d'un reflet discret. Elle ne retarde jamais rien : aucune durée minimale — le premier mot la
 * remplace à l'instant, au milieu d'une ligne s'il le faut (le parent cesse de la monter). Mouvement réduit :
 * les lignes connues toutes ensemble, immobiles.
 */
function SofarWaiting({ lines }: { lines: string[] }) {
  const t = useT();
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(1);
  useEffect(() => {
    if (reduced || count >= lines.length) return;
    const id = window.setTimeout(() => setCount((c) => c + 1), SOFAR_WAIT_STEP_MS);
    return () => window.clearTimeout(id);
  }, [count, lines.length, reduced]);
  const visible = reduced ? lines : lines.slice(0, count);
  return (
    <div data-ask-sofar-loading="" role="status" aria-label={t("ask.thinking")} className="flex flex-col gap-0.5 py-0.5">
      {visible.map((line, i) => (
        <p key={i} data-ask-sofar-wait-line="" className={`ask-sofar-in text-[12px] leading-5 text-white/45 ${i === visible.length - 1 ? "ask-wait-shimmer" : ""}`}>
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * « Jusqu'ici » (DECISIONS.md §139, 10.27.1) : un composant à lui, qui ne retient rien du reste du panneau.
 * Avec l'option pour cette séance, la section est toujours là en haut dès l'ouverture : son titre, l'attente
 * (`SofarWaiting`, 10.28.0 — des lignes vraies sur ce qui part au modèle ; un texte gardé n'en montre pas),
 * puis le texte, **mot par mot** à mesure qu'il est vérifié. Rien à dire, une panne ou le délai : une ligne
 * discrète, « Encore trop peu vu pour en dire plus. » (`little`, 10.27.2) — jamais une section qui disparaît
 * (`useSofar`).
 */
export function AskPersonSofar({
  itemId,
  personId,
  position,
  scenes,
  name = "",
}: {
  itemId: string;
  personId: number;
  position: number | null;
  scenes?: SofarScenes | null;
  /** Le personnage (sinon l'acteur), tel que l'attente le nomme. */
  name?: string;
}) {
  const t = useT();
  const view = useSofar(itemId, personId, position, true, scenes);
  if (view.state === "none") return null;
  const ready = view.state !== "waiting";
  return (
    <div data-ask-sofar={view.state} className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-[.14em] text-white/55">{t("xray.sofar")}</span>
      {view.state === "little" ? (
        <p data-ask-sofar-little="" className="ask-sofar-in text-[13px] leading-5 text-white/55">
          {t("xray.sofarLittle")}
        </p>
      ) : ready ? (
        <p data-ask-sofar-text="" className="text-sm leading-5 text-white">
          {view.text}
        </p>
      ) : view.loading ? (
        <SofarWaiting lines={sofarWaitLines(t, name, sofarSceneCount(scenes, personId, position), view.plan)} />
      ) : null}
    </div>
  );
}

/**
 * Le panneau d'une personne d'« À l'écran » (DECISIONS.md §138, 10.27), de haut en bas : l'en-tête (photo,
 * acteur, personnage) ; « Jusqu'ici » (seulement avec les questions, §139 — `AskPersonSofar`) ; la ligne de
 * faits (âge, lieu de naissance) et une courte biographie, coupée à trois lignes (le chemin des fiches
 * personne du cinéma) ; « Dans votre bibliothèque » — deux ou trois affiches de ses autres titres, **qui ne
 * réagissent à rien** (ni bouton, ni lien, ni survol, ni menu au long appui : une information, pas une porte
 * vers une fiche pendant le film).
 *
 * Le panneau s'ouvre tout de suite avec l'en-tête ; les faits et « Jusqu'ici » arrivent chacun de leur côté,
 * jamais l'un en attente de l'autre (10.27.1).
 */
export function AskPersonBlock({
  itemId,
  person,
  sofar,
  position,
  scenes,
}: {
  itemId: string;
  person: XrayPlayerPerson;
  sofar: boolean;
  position: number | null;
  /** Les scènes du lecteur : la coupe de « Jusqu'ici » tombe sur un début de scène (`sofarCut`, 10.27.2). */
  scenes?: SofarScenes | null;
}) {
  const t = useT();
  const { locale } = useLocale();
  const facts = usePersonFacts(itemId, person.personId);
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
      {sofar && (
        <AskPersonSofar
          key={`${itemId}:${person.personId}`}
          itemId={itemId}
          personId={person.personId}
          position={position}
          scenes={scenes}
          name={person.character || person.name || ""}
        />
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
