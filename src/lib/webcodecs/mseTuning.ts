// Les réglages de `MseSource` : profondeurs, délais, seuils et bornes des reprises, chacun avec la
// raison de sa valeur. Sortis de mseSource.ts tels quels.

/** How far ahead of the playhead to keep buffered. Enough to ride out a slow read, not a download. */
export const TARGET_BUFFER_SECONDS = 30;

/** How long a clock may stand still, while playing with media ahead of it, before it is pushed. */
export const FROZEN_CLOCK_MS = 1500;

/**
 * Et combien de temps quand l'élément est encore en train de sauter.
 *
 * Un saut au milieu d'un groupe d'images se décode depuis l'image clé précédente : neuf secondes
 * de 4K avant d'arriver à la cible dans 1917, soit plus d'une seconde et demie sur un iPhone
 * comme sur un PC. Poussé à 1,5 s, le saut repartait de l'image clé, et encore, et encore
 * (22/09/2026, « une seconde de lecture pour deux de chargement »). Un saut qui ne se résout
 * vraiment jamais — celui posé pile sur le bord du média, pour lequel la poussée existe — est
 * toujours poussé, simplement plus tard.
 */
export const FROZEN_SEEKING_MS = 6000;

/**
 * Et à l'ouverture, pour la première poussée seulement : une ouverture figée sur l'instant où elle
 * a été posée ne se débloque pas seule sur Safari — 61 ouvertures depuis le début sur 186 sur
 * iPhone, poussées au bout de 1,5 s (journal relu le 10/10/2026), autant de « second chargement ».
 * La poussée les libère à coup sûr ; elle vient donc plus tôt. Les poussées suivantes gardent le délai ordinaire : un appareil
 * lent qui décode vraiment ne doit pas gravir l'échelle des reprises en une seconde.
 */
export const FROZEN_OPENING_MS = 400;

/** Ce qu'est « au bord » : l'atterrissage pose la tête 0,04 s dans le média, une poussée 0,08 s. */
export const OPENING_EDGE_SECONDS = 0.5;

/**
 * Et plus tôt encore, une fois : la position redemandée 100 ms après l'atterrissage de l'ouverture, si
 * rien n'a bougé. Le gel des départs du début tenait encore en 8.30.9 (10/10/2026, iPhone : WarGames,
 * La Flamme, Drive — ouverts en 14 à 373 ms, puis figés jusqu'à la poussée de 400 ms — que le chien
 * de garde, qui passe toutes les 250 ms, ne livrait qu'à 500). Une minuterie à part, armée à
 * l'atterrissage ; la poussée de 400 ms reste le filet, l'échelle ordinaire la suite.
 */
export const OPENING_REASSERT_MS = 100;

/**
 * Mais jamais sur un élément qui vient de repartir (10/10/2026, Mathis, iPhone, 8.32.9) : la
 * minuterie de 100 ms, retardée par le travail du fil principal (segments construits et envoyés),
 * tombait 283 à 348 ms après l'atterrissage — dans le même instant que le `playing` de Safari, qui
 * venait justement d'achever le placement. Le pas redemandé relançait le saut et refigeait l'élément :
 * « repart à 0,27 s » et « position redemandée » à la même milliseconde, puis la poussée de 400 ms,
 * puis la première image 1,1 s plus tard. Un `playing` ou un `seeked` après l'atterrissage l'annule ;
 * et la poussée de l'ouverture laisse à un élément tout juste reparti ce délai pour montrer sa
 * première image avant de le bousculer.
 */
export const OPENING_PLAYING_GRACE_MS = 600;

/** Ce qu'une seconde de média à décoder ajoute à ce délai — voir `seekingPatienceMs`. */
export const SEEKING_PATIENCE_PER_SECOND_MS = 500;

/**
 * How far it is pushed — inside the media rather than onto its edge, which is what froze it.
 *
 * Deliberately larger than the movement threshold above: a step exactly the size of it reads as
 * not having moved on the next tick, so a clock that had just been unstuck was still counted as
 * frozen and pushed again.
 */
export const FROZEN_STEP = 0.08;

/**
 * And how many times, before the push gives way to a real recovery.
 *
 * It used to be "before leaving an element alone with whatever it is doing" — and the counter only
 * resets when the clock moves, so a clock that three pushes did not free was never looked at
 * again: playing, media ahead, and nothing whatsoever trying to get it going.
 */
export const MAX_FROZEN_NUDGES = 3;

/**
 * The depth that is fetched no matter what the system says.
 *
 * ManagedMediaSource tells a page when to stream and when to stop, and a page that ignores it
 * gets throttled — but obeying it unconditionally means that if it says "stop" while the buffer
 * in front of the playhead is empty, nothing is ever fetched again and the player sits there
 * loading forever. Below this depth the media is needed to play at all, so it is fetched; above
 * it, the system decides.
 */
export const MIN_BUFFER_SECONDS = 8;

/** How long repeated recoveries at one spot keep counting against each other. */
export const RECOVERY_WINDOW_MS = 5000;

/** Seeks to the same spot, in a row, before that spot is given up on and the ladder climbs. */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Recoveries of any kind, anywhere, with no playback in between, before the ladder climbs anyway.
 *
 * The window above resets the count at one spot once attempts stop being rapid — right for a
 * spot that fails again a minute later, wrong for one that fails every six seconds for ever. This
 * bound does not care about spacing: only real playback clears it (`PLAYED_TO_CLEAR_SECONDS`).
 * Above the three rapid attempts plus the keyframe step, so the ordinary ladder never reaches it.
 */
export const MAX_UNPLAYED_ATTEMPTS = 8;

/** Seconds of the clock genuinely running before the ladder goes back to its first rung. */
export const PLAYED_TO_CLEAR_SECONDS = 3;

/** How far inside the next keyframe's group the keyframe step lands — inside, not on its edge. */
export const NEXT_KEYFRAME_MARGIN = 0.1;

/**
 * How long a playing clock may cover less than a second before the stall is written to the log.
 *
 * Longer than any recovery here takes to act (1.5 s for a frozen clock, 0.7 s for a playhead on
 * nothing), so a line means those did not settle it — the case nothing on the server could see.
 */
export const STALL_REPORT_MS = 5000;

/** And no second line within this long, however the clock flaps in between. */
export const STALL_REPORT_COOLDOWN_MS = 60_000;

/**
 * L'autre forme de blocage, celle où l'horloge avance : autant de secondes courues sans rien sous
 * la tête avant de l'écrire. 22/09/2026, iPhone : « le temps avance de plusieurs dizaines de
 * secondes, pas d'image, et ça ne s'arrête pas tant que je ne ressaute pas » — invisible pour la
 * ligne `stall`, qui ne voit qu'une horloge immobile.
 */
export const RUNAWAY_REPORT_SECONDS = 3;

/** How much of the trace a stall line carries: enough to hold the seek or skip that led to it. */
export const STALL_TRACE_MS = 20_000;
/** Fragments vidéo gardés pour situer la tête à un échec — voir `sentFragments`. */
export const SENT_FRAGMENTS_KEPT = 48;

/** Refused appends in a row before playback is declared broken rather than merely interrupted. */
export const MAX_APPEND_FAILURES = 3;

/**
 * Une coupure réseau ne vide le tampon que s'il n'y a plus grand-chose dedans.
 *
 * Au-dessus de cette avance, le film continue sur ce qu'il a pendant que la lecture est retentée
 * (voir `keepThroughNetworkFailure`). En dessous, rien à perdre : la reprise habituelle.
 */
export const NETWORK_KEEP_LEAD_SECONDS = 5;
/** Attentes avant chaque nouvel essai, puis la reprise habituelle — une vingtaine de secondes en tout. */
export const NETWORK_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
/** Ce que le retrait laisse au moins devant la tête — sous elle, jamais. */
export const NETWORK_TRIM_MARGIN_SECONDS = 1;

/**
 * La borne d'une coupure en pleine lecture (DECISIONS.md §97) : la tête à court de média et le réseau
 * muet depuis ce temps sous une demande (`networkSilentMs`), la main passe à l'hôte — l'écran
 * « connexion perdue », qui relance seul au retour du réseau. 48 s, celle du lecteur serveur
 * (`NETWORK_OUTAGE_GIVE_UP_MS`, PlayerHost). Avant le 15/10/2026, une coupure passait par l'échelle des
 * envois refusés (`appendFailures` / `recover`), chaque reprise relançant la patience d'une minute par
 * lecture : quatre minutes et plus d'image figée, sans un mot, avant cet écran.
 */
export { NETWORK_OUTAGE_GIVE_UP_MS } from "@/lib/networkOutage";
/** « À court » : moins que cela devant la tête, ou l'élément qui n'a plus de quoi avancer. */
export const OUTAGE_STARVED_LEAD_SECONDS = 0.5;

/** How long a playhead with no media under it is tolerated before a seek is forced to reach it. */
export const STALL_TIMEOUT_MS = 700;

/** How often that is checked. Often enough that a recovery is not itself the thing you notice. */
export const WATCHDOG_MS = 250;

/**
 * Combien de relectures, par minute, de ce que le navigateur a retiré devant la tête — voir
 * `refillEvicted`. Au-delà, un système qui manque de mémoire retirerait à mesure qu'on relit : le
 * remplissage ordinaire et le chien de garde reprennent la main, comme avant.
 */
export const EVICTION_REFILLS_PER_MINUTE = 3;
/** Voir `open` : l'attente de `sourceopen` ne peut pas durer toujours. */
export const SOURCE_OPEN_TIMEOUT_MS = 15_000;

/**
 * How far the media being read may sit from the playhead before the reader is judged misplaced.
 *
 * Comfortably more than a segment, so ordinary reading ahead is never mistaken for it, and far
 * less than the distance any real seek covers.
 */
export const MISPLACED_SECONDS = 10;

/**
 * Segments that change nothing before the reading is called pointless.
 *
 * Enough that an ordinary stretch of eviction or an odd boundary is never mistaken for it, few
 * enough that a browser silently dropping everything is caught in a second or two rather than
 * after the whole file has gone past.
 */
export const FRUITLESS_APPENDS = 8;
/**
 * Jusqu'où avant sa cible un saut peut légitimement commencer à lire : trois reculs de douze
 * secondes quand l'index ment (`Remuxer.backUp`), plus le groupe d'images où il retombe. Du média
 * plus lointain que cela n'est pas une lecture d'avance, et la garde « rien retenu » le compte.
 */
export const PRE_ROLL_SECONDS = 40;

/** Only the opening handful of segments is recorded: after that the record says nothing new. */
export const TRACED_APPENDS = 4;

/** Envois tracés après chaque saut : de quoi voir la tête rejoindre le média, pas davantage. */
export const TRACED_APPENDS_PER_SEEK = 6;

/** How much already-played media to keep before evicting, so a short step back does not re-fetch. */
export const KEEP_BEHIND_SECONDS = 30;

/**
 * De combien le début d'un tampon peut dépasser ce qu'on garde derrière avant qu'on le retire :
 * sans cette marge, chaque envoi serait suivi d'un retrait d'une fraction de seconde.
 */
export const TRIM_SLACK_SECONDS = 2;

/**
 * Ce qu'un retrait derrière la tête laisse avant l'image clé de son groupe : les instants du tampon
 * sont arrondis à l'échelle de temps du fMP4, et une clé lue un rien plus tôt que l'index ferait
 * partir le groupe entier.
 */
export const KEYFRAME_TRIM_MARGIN = 0.05;

/**
 * La marge avant une zone illisible (§93) : le relais se fait une demi-seconde avant la fin de ce
 * qui est sûr, pour qu'aucune image touchée n'arrive au décodeur.
 */
export const ZONE_MARGIN_SECONDS = 0.5;

/**
 * Une image, au plus lent du cinéma (24 images/s) : l'écart qu'un saut peut avoir avec le début de
 * ce qui est chargé et être posé dessus plutôt que tout relire — voir `MseSource.onSeeking`.
 */
export const ONE_FRAME_S = 1 / 24;
