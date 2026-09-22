// The remux path, assembled: file in, a playing <video> element out.
//
// Deliberately shaped like the WebCodecs engine's public surface — same track lists, same subtitle
// selection and lookup — so the player component branches once on which path was chosen and not
// again on every operation. Audio is the exception: here a change of track rebuilds the player
// (see `requestAudioTrack`), where the engine switches its own software decoder.

import { displayIsHdr, hdrLightCap } from "./hdrDisplay";
import { playerWarning, type PlayerWarning } from "./playerWarning";
import { HttpByteSource, type ByteSource } from "./byteSource";
import type { EngineTrack } from "./engine";
import { fromMatroskaTrack } from "./engineTrack";
import { keptRangeAt, type MatroskaFile, type MatroskaTrack } from "./matroska";
import { openMediaFile } from "./mediaFile";
import { MseSource } from "./mseSource";
import { choosePlaybackPath, describePath, type ChosenPath } from "./pathSelector";
import { Remuxer, setHdrLightCap, playableAudio, type TrackedCue } from "./remuxer";
import { chooseAudioTrack, type TrackPreferences } from "@/lib/trackPreferences";
import { trace, traceReset } from "./trace";

/** Cues more than this far behind the playhead are dropped: a three-hour film is a lot of lines. */
const CUE_HISTORY_SECONDS = 60;

/**
 * And this far ahead of it.
 *
 * Keeping only a window behind is not enough once seeking is involved: jump backwards and every
 * line gathered further along the film is still "ahead", so nothing is ever dropped and the list
 * grows with each seek. A window on both sides bounds it whatever the viewer does.
 */
const CUE_FUTURE_SECONDS = 120;

export interface RemuxPlaybackOptions {
  streamUrl: string;
  startSeconds: number;
  onError: (message: string, kind?: "network" | "playback") => void;
  onWarning?: (warning: PlayerWarning) => void;
  /** Play pressed and the clock not yet moving, or null once it is. See MseCallbacks. */
  onStarting?: (startedAt: number | null) => void;
  /** A playing clock that has stood still for seconds, once per stall. See MseCallbacks. */
  onStall?: (facts: Record<string, unknown>) => void;
  /**
   * Ce que le serveur sait de la plage dynamique — `"DOVI"`, `"DOVIWithHDR10"`, `"HDR10"`, `"SDR"`…
   *
   * Descendu jusqu'ici pour une seule décision, mais elle est décisive : un Dolby Vision refusé
   * par le navigateur se rattrape sur sa couche de base **quand il y en a une**, et n'a nulle part
   * où aller quand il n'y en a pas. Le conteneur seul ne suffit pas à trancher — un fichier peut
   * être en Dolby Vision sans porter d'enregistrement dans son en-tête —, alors que cette valeur
   * vient de l'analyse du flux par le serveur et ne se trompe pas.
   */
  videoRangeType?: string | null;
  /**
   * Ce que ce compte veut entendre — pour **ouvrir** dessus, et non pour y basculer ensuite.
   *
   * Le pipeline se construisait sur la piste par défaut du *fichier*, le film démarrait, puis le
   * lecteur appliquait la préférence du compte en défaisant ce qu'il venait de faire. Mesuré le
   * 20/09/2026 sur quatre films : ça arrivait à chacun d'eux, donc c'était le cas normal et non
   * l'exception. Le coût de ce geste inutile allait de 429 ms sur un fichier copié tel quel à
   * 1 784 ms sur du DTS — et jusqu'à 7,9 s sur l'appareil le plus lent du foyer.
   *
   * Absentes, tout se passe comme avant : c'est le repli quand la préférence n'est pas encore
   * chargée, et c'est aussi ce que voit le chemin WebCodecs, qui choisit sa piste autrement.
   */
  audioPreferences?: TrackPreferences | null;
  /**
   * La piste que le spectateur a choisie, quand ce pipeline en remplace un autre.
   *
   * Un pipeline reconstruit ouvrait sur la préférence du compte puis basculait vers le choix du
   * spectateur — une seconde attente après la première. Depuis la livraison par piste, c'est pire
   * qu'une attente : la reconstruction a lieu *parce que* la piste choisie n'a pas le format de
   * l'autre, et basculer ensuite serait refaire la transition qu'elle évite. On ouvre donc dessus.
   */
  audioTrackNumber?: number | null;
  /**
   * Ouvrir sans lancer la lecture : un pipeline reconstruit pour un changement de piste pendant
   * une pause. Sans cela, la garde de démarrage prenait l'élément resté à l'arrêt pour un
   * démarrage raté et le relançait d'elle-même — relevé sur iPhone le 21/09/2026.
   */
  startPaused?: boolean;
}

export type PathProbe = { discard: () => void } & (
  /**
   * `chosen` est porté ici aussi, et pas seulement par la variante WebCodecs.
   *
   * Le motif du choix n'existait que dans la trace, si bien que l'appelant ne pouvait pas nommer
   * le chemin *quand il marchait* : le rapport technique disait « non encore décidé » sur une
   * lecture parfaitement saine, et ne se remplissait qu'en cas de repli. Un rapport qui ne se
   * renseigne que lorsque ça se dégrade est un rapport qu'on lit à l'envers.
   */
  | { path: "remux"; start: (video: HTMLVideoElement) => Promise<RemuxPlayback>; chosen: ChosenPath }
  | { path: "webcodecs"; chosen: ChosenPath }
  /*
   * Il y avait un troisième chemin, « direct » : un MP4 remis tel quel à `<video>`. Retiré le
   * 22/09/2026 — un bon conteneur ne dit pas que tout se lit nativement. Sur les MP4 de la
   * bibliothèque, il jouait l'E-AC3 muet sur Chrome et Firefox sans erreur ni repli, n'offrait ni
   * menu de pistes ni langue du compte, n'affichait aucun sous-titre intégré, et un HEVC refusé
   * finissait en écran d'erreur. Tout fichier passe désormais par le même traitement, qui ne fait
   * rien (ou presque) quand rien n'est à faire : voir mediaFile.ts et mp4Demux.ts.
   */
);

/**
 * The audio track to open on.
 *
 * A track this path can carry comes before the file's own default, because those two disagree
 * more often than one would think: a release marks its highest-quality track as default, and
 * that is regularly DTS — which no browser decodes. Every DTS file in this library carries an
 * AC-3 or AAC track beside it, so preferring the default would refuse, on a technicality, a file
 * that plays perfectly on the track next to it. The default still decides among the ones that
 * work, and if none do the default is returned anyway so the refusal names the real codec.
 */
/** Tous les combien de secondes de lecture la zone gardée suit la tête. */
const KEEP_EVERY_SECONDS = 2;

export function preferredAudio(file: MatroskaFile, preferences?: TrackPreferences | null): MatroskaTrack | null {
  const audio = file.tracks.filter((t) => t.type === "audio");
  const playable = audio.filter(playableAudio);

  /**
   * La langue du compte d'abord, quand elle désigne une piste que ce chemin sait porter.
   *
   * Posé **avant** la règle du défaut, et seulement sur les pistes jouables : une préférence qui
   * désignerait une piste TrueHD ferait refuser le fichier entier alors qu'il joue très bien sur
   * celle d'à côté. `chooseAudioTrack` rend `null` dès que rien ne correspond — le compte réglé
   * sur « piste par défaut » compris —, et on retombe alors exactement sur ce qui suit.
   *
   * **C'est `chooseAudioTrack` et rien d'autre**, et ce n'est pas un détail d'implémentation :
   * l'écran applique la même fonction dès que le film démarre, et bascule si la piste ouverte
   * n'est pas la sienne. Ouvrir sur un autre choix — fût-il meilleur — ne supprimerait pas le
   * changement qu'on cherche à éviter, il le rendrait seulement invisible dans le code.
   *
   * `rank` départage depuis le 20/09 les pistes d'une même langue par le nombre de canaux, avant
   * le drapeau du fichier : entre une stéréo et une 5.1 anglaises, c'est la 5.1 — ici comme à
   * l'écran, puisque c'est la même fonction. (Ce paragraphe disait l'inverse, écrit avant ce
   * changement ; la règle « la plus riche » vaut aussi juste en dessous, sans préférence.)
   */
  if (preferences && playable.length > 0) {
    /**
     * Parmi les pistes jouables, et le prédicat sert à départager celles de la même langue.
     *
     * Deux règles se superposent, et elles ne disent pas la même chose :
     *
     *  * **ici**, on ouvre sur quelque chose qui joue — le film doit démarrer ;
     *  * **à l'écran**, `chooseAudioTrack` voit toutes les pistes, et si la langue demandée
     *    n'existe qu'en TrueHD il cède la place au lecteur serveur. C'est voulu : le spectateur
     *    qui demande la VO obtient la VO, fût-ce par un autre lecteur.
     *
     * Les deux tombent d'accord dans le cas qui nous occupe — deux pistes de la même langue dont
     * une seule joue, « Le Mans 66 » — et c'est là que le changement de piste disparaît.
     */
    const wanted = chooseAudioTrack(playable, preferences, playableAudio);
    if (wanted) return wanted;
  }
  // Nothing here works: the file's own default is returned so the refusal names its real codec.
  if (playable.length === 0) return audio.find((t) => t.isDefault) ?? audio[0] ?? null;

  const preferred = audio.find((t) => t.isDefault) ?? audio[0];
  const language = preferred?.language ?? null;
  // Language first, then channel count. On this library the default track is regularly DTS in one
  // language with only a stereo track beside it in another — silently switching language is a
  // worse surprise than dropping from surround to stereo, so the language is held onto and the
  // richest track in it wins. The menu still offers everything.
  const sameLanguage = playable.filter((t) => t.language === language);
  const pool = sameLanguage.length > 0 ? sameLanguage : playable;
  return pool.reduce((best, t) => ((t.audio?.channels ?? 0) > (best.audio?.channels ?? 0) ? t : best), pool[0]);
}

/**
 * La piste sur laquelle ouvrir : celle que le spectateur a choisie si ce pipeline en remplace un
 * autre et qu'elle joue par ce chemin, sinon celle que le compte préfère (`preferredAudio`).
 */
export function openingAudio(
  file: MatroskaFile,
  preferences?: TrackPreferences | null,
  chosen?: number | null
): MatroskaTrack | null {
  if (chosen !== null && chosen !== undefined) {
    const track = file.tracks.find((t) => t.type === "audio" && t.number === chosen);
    if (track && playableAudio(track)) return track;
  }
  return preferredAudio(file, preferences);
}

/**
 * Works out how this file should be played, without committing to it.
 *
 * The header is read here and, on the WebCodecs path, read again by the engine. That is a handful
 * of ranged requests against a cache, paid only on the path that is already the slower of the
 * two — much cheaper than reshaping the engine to accept a file someone else parsed, which is a
 * thousand lines of working code this has no business destabilising.
 */
export async function probePlaybackPath(options: RemuxPlaybackOptions): Promise<PathProbe> {
  traceReset();
  // Avant tout remultiplexage : le plafond de lumière HDR choisi sur cet appareil, s'il y en a
  // un — voir `hdrDisplay.ts`.
  const displayHdr = displayIsHdr();
  const lightCap = hdrLightCap();
  setHdrLightCap(lightCap);
  trace("ouverture du flux");
  trace(
    `écran HDR : ${displayHdr === null ? "inconnu" : displayHdr ? "oui" : "non"}` +
      (lightCap !== null ? ` — lumière HDR annoncée plafonnée à ${lightCap} nits (choix de l'appareil)` : "")
  );
  const source = await HttpByteSource.open(options.streamUrl);
  trace(`flux ouvert — ${source.size} octets`);

  // Named by its URL, so opening the same file again — or rebuilding after the platform closed
  // the source — does not pay for its header and index a second time. Matroska or MP4, told
  // apart by the file's own first bytes.
  const headerAt = Date.now();
  let file: MatroskaFile;
  try {
    file = await openMediaFile(source, options.streamUrl);
  } catch (error) {
    // Un en-tête illisible — un MP4 fragmenté, que ce lecteur refuse — part au lecteur serveur
    // par l'appelant (`fallToStable`) ; la connexion, elle, n'a plus d'usage.
    source.close();
    throw error;
  }
  const headerMs = Date.now() - headerAt;
  trace(
    `en-tête ${headerMs < 15 ? "déjà connu" : "lu"} en ${headerMs} ms — ` +
      `${file.tracks.length} pistes, ${file.cues.length} points d'index, ` +
      file.tracks.map((t) => `${t.number}:${t.type}:${t.codecId}${t.language ? `/${t.language}` : ""}`).join(" ")
  );

  const videoTrack = file.tracks.find((t) => t.type === "video");
  if (!videoTrack) throw new Error("Ce fichier ne contient aucune piste vidéo.");
  const audioTrack = openingAudio(file, options.audioPreferences, options.audioTrackNumber);
  trace(`piste audio retenue : ${audioTrack ? `${audioTrack.codecId} ${audioTrack.audio?.channels ?? "?"}ch ${audioTrack.language ?? "?"}` : "aucune"}`);

  const chosen = await choosePlaybackPath({
    source,
    file,
    videoTrack,
    audioTrack,
    dimensions: { width: videoTrack.video?.width ?? 1920, height: videoTrack.video?.height ?? 1080 },
    videoRangeType: options.videoRangeType,
    startSeconds: options.startSeconds,
  });

  trace(`chemin choisi : ${describePath(chosen)}`);
  if (chosen.path !== "remux" || !chosen.remuxer || !chosen.plan) {
    source.close();
    return { path: "webcodecs", chosen, discard: () => {} };
  }

  return {
    path: "remux",
    chosen,
    start: (video) => RemuxPlayback.start(video, source, file, videoTrack, audioTrack, chosen, options),
    // For a caller that asked and then changed its mind: the remuxer holds the software decoder
    // and the encoder, and the source holds the connection.
    discard: () => {
      chosen.remuxer?.close();
      source.close();
    },
  };
}

export class RemuxPlayback {
  private mse: MseSource | null = null;
  private cues: TrackedCue[] = [];
  private currentSubtitle: number | null = null;
  private destroyed = false;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: ByteSource,
    private readonly file: MatroskaFile,
    private readonly videoTrack: MatroskaTrack,
    private audioTrack: MatroskaTrack | null,
    private remuxer: Remuxer,
    private readonly chosen: ChosenPath,
    private readonly options: RemuxPlaybackOptions
  ) {}

  static async start(
    video: HTMLVideoElement,
    source: ByteSource,
    file: MatroskaFile,
    videoTrack: MatroskaTrack,
    audioTrack: MatroskaTrack | null,
    chosen: ChosenPath,
    options: RemuxPlaybackOptions
  ): Promise<RemuxPlayback> {
    const playback = new RemuxPlayback(video, source, file, videoTrack, audioTrack, chosen.remuxer!, chosen, options);
    // The instance is only handed back once it is attached, so a rejection here leaves an object
    // nobody can free: it holds the remuxer — hence an AudioDecoder and an AudioEncoder, of which
    // the browser allows a fixed number at a time — the byte source and its connection. Firefox on
    // Windows reaches this path for real: `MediaSource.isTypeSupported` claims a codec it then
    // refuses as a SourceBuffer (see codecSupport.ts), and `addSourceBuffer` throws inside attach.
    // Releasing it here rather than in the caller: nothing else ever held a reference to it.
    try {
      await playback.attach(chosen.plan!, options.startSeconds);
    } catch (error) {
      // `destroy()` tolerates a half-built instance — `mse` is still null, `Remuxer.close()` and
      // `AudioTranscoder.close()` are both guarded and idempotent — so it cannot replace the
      // error that names the real reason on screen and in the technical report.
      playback.destroy();
      throw error;
    }
    return playback;
  }

  /** Où la zone gardée a été posée pour la dernière fois, en secondes du lecteur. */
  private keptAt = -Infinity;

  /**
   * Garde en mémoire les octets autour de la tête de lecture — voir `MAX_KEPT_CHUNKS` dans
   * byteSource.ts. C'est ce qu'un changement de piste relit, et ce que la lecture en avance
   * chassait du cache. Toutes les deux secondes de lecture, et à chaque saut : un calcul sur
   * l'index déjà en mémoire, rien de plus.
   */
  private readonly keepAroundHead = (event?: Event) => {
    if (this.destroyed || !this.source.keep) return;
    const now = this.video.currentTime;
    if (event?.type === "timeupdate" && Math.abs(now - this.keptAt) < KEEP_EVERY_SECONDS) return;
    this.keptAt = now;
    const range = keptRangeAt(this.file, Math.max(0, now - (this.mse?.presentationDelay ?? 0)), this.videoTrack.number);
    if (range) this.source.keep(range.from, range.to);
  };

  private async attach(plan: Parameters<typeof MseSource.attach>[2], startSeconds: number): Promise<void> {
    trace(`attachement de MediaSource — ${plan.videoMimeType} + ${plan.audioMimeType ?? "aucun audio"}`);
    this.mse = await MseSource.attach(
      this.video,
      this.remuxer,
      plan,
      {
        onError: this.options.onError,
        onWarning: this.options.onWarning,
        onStarting: this.options.onStarting,
        onStall: this.options.onStall,
        onSubtitles: (cues) => this.collect(cues),
      },
      // Handed in rather than seeked to afterwards, so the first read happens where the viewer
      // is resuming instead of at the beginning of the file.
      startSeconds,
      this.options.startPaused ?? false
    );
    this.video.addEventListener("timeupdate", this.keepAroundHead);
    this.video.addEventListener("seeked", this.keepAroundHead);
  }

  private collect(cues: TrackedCue[]): void {
    this.cues.push(...cues);
    if (this.cues.length <= 600) return;
    const now = this.video.currentTime;
    this.cues = this.cues.filter(
      (cue) => cue.endSeconds >= now - CUE_HISTORY_SECONDS && cue.startSeconds <= now + CUE_FUTURE_SECONDS
    );
  }

  get audioTracks(): EngineTrack[] {
    return this.remuxer.audioTracks().map(fromMatroskaTrack);
  }

  get subtitleTracks(): EngineTrack[] {
    return this.remuxer.subtitleTracks().map(fromMatroskaTrack);
  }

  get currentAudioTrack(): number | null {
    return this.audioTrack?.number ?? null;
  }

  /**
   * Ce que demande le passage à cette piste : `"rebuild"`, `"refused"`, ou `null` s'il n'y a rien
   * à faire (piste inconnue, déjà jouée, lecteur détruit).
   *
   * **Il n'y a plus qu'une façon de changer de piste : reconstruire le lecteur**, à la même
   * position, directement sur la nouvelle piste — l'appelant s'en charge. Il y en avait une
   * seconde jusqu'au 22/09/2026, « dans le tampon » : vider le son et le relire en gardant
   * l'image. Mesurée sur les trois moteurs, elle était plus lente (0,4 à 3,1 s en médiane, avec
   * des queues de plusieurs secondes, contre 0,05 à 0,35 s pour la reconstruction) et laissait sur
   * WebKit un décalage durable entre le son et l'image ; elle a été retirée.
   *
   * Refusé — un avertissement, la piste d'avant continue — sur un fichier sans index en cours de
   * film : voir `switchNeedsIndex`. Une demande, et non une question : c'est ici que le refus
   * est dit au spectateur, comme un saut refusé l'est par la source.
   */
  requestAudioTrack(trackNumber: number): "rebuild" | "refused" | null {
    const track = this.file.tracks.find((t) => t.number === trackNumber && t.type === "audio");
    if (!track || this.destroyed || track.number === this.audioTrack?.number) return null;
    if (this.switchNeedsIndex) {
      this.options.onWarning?.(playerWarning("noIndexAudio"));
      return "refused";
    }
    return "rebuild";
  }

  /**
   * Un changement de piste ici relirait le fichier depuis son début.
   *
   * La reconstruction rouvre à la position courante *par l'index*. Un fichier sans index n'a pas
   * de grappe à désigner — `clusterOffsetForTime` retombe sur la première —, et le film
   * reprendrait à zéro. Au tout début du film, en revanche, lire depuis le début *est* la bonne
   * réponse : même seuil qu'un saut refusé.
   */
  private get switchNeedsIndex(): boolean {
    return !this.remuxer.seekable && this.video.currentTime > 1;
  }

  /**
   * Whether this path could carry that track's sound at all — asked *before* anything is touched.
   *
   * A codec this path cannot carry will not be carried on the next attempt either, so the caller
   * steps aside to a player that *can* carry it instead of rebuilding this one onto a refusal, or
   * telling the viewer their language is unavailable.
   */
  canCarryAudio(trackNumber: number): boolean {
    const track = this.file.tracks.find((t) => t.number === trackNumber && t.type === "audio");
    // An unknown number is not a codec refusal: let the usual path answer it.
    return track ? playableAudio(track) : true;
  }

  get currentSubtitleTrack(): number | null {
    return this.currentSubtitle;
  }

  /**
   * Scanned in place, on purpose.
   *
   * This is asked several times a second while a film plays. Filtering to the chosen track first
   * allocated a fresh array of every line held, every time — and handed it to a helper that
   * prunes its argument as it goes, so the pruning was thrown away with the copy. A direct scan
   * allocates nothing and does not care that seeking leaves the lines out of order.
   */
  subtitleAt(seconds: number): string | null {
    const track = this.currentSubtitle;
    if (track === null) return null;
    for (const cue of this.cues) {
      if (cue.track === track && cue.startSeconds <= seconds && seconds <= cue.endSeconds) return cue.text;
    }
    return null;
  }

  /**
   * Changing subtitles is a change of filter and nothing else.
   *
   * Every text track's lines are already in hand, so there is nothing to fetch and nothing to
   * disturb. Re-reading the file for the newly chosen track — which is what this did first —
   * meant re-appending media the browser had already played, and it catches that up at speed:
   * choosing a subtitle came with a second of fast-forward before playback settled.
   */
  selectSubtitleTrack(trackNumber: number | null): void {
    this.currentSubtitle = trackNumber;
  }

  /** See MseSource.lost: the platform took the source, and only a rebuild brings it back. */
  get lost(): boolean {
    return this.mse?.lost ?? false;
  }

  get position(): number {
    return this.mse?.position ?? 0;
  }

  seek(seconds: number): Promise<void> {
    return this.mse?.seek(seconds) ?? Promise.resolve();
  }

  /** Le pire écart d'horloge du son ré-encodé, `null` quand le son est copié — voir `Remuxer.audioTiming`. */
  /** Reprises, poussées et barreaux gravis sur la séance, pour la ligne `stop` — voir `MseSource.recoveryFacts`. */
  recoveryFacts(): { recoveries: number; frozenNudges: number; escalations: number } | null {
    return this.mse?.recoveryFacts ?? null;
  }

  audioTiming(): { sourceMs: number; encoderMs: number } | null {
    return this.remuxer.audioTiming();
  }

  get diagnostics(): Record<string, string> {
    const remux = this.remuxer.diagnostics();
    return {
      Chemin: describePath(this.chosen),
      Décodage: "matériel, par le navigateur",
      Vidéo: `${this.videoTrack.codecId} ${this.videoTrack.video?.width ?? "?"}×${this.videoTrack.video?.height ?? "?"}`,
      Audio: this.audioTrack ? `${this.audioTrack.codecId} ${this.audioTrack.audio?.channels ?? "?"} canaux` : "aucune",
      // Worth stating plainly: on this path the sound is the one thing that may not be the
      // file's own bytes, and knowing which of the two is happening explains everything else.
      // A codec string is what the container says; a name is what a reader needs.
      "Traitement audio": remux.transcodedCodec
        ? `décodé puis ré-encodé en ${remux.transcodedCodec.startsWith("mp4a") ? "AAC" : remux.transcodedCodec === "opus" ? "Opus" : remux.transcodedCodec}`
        : "copié tel quel",
      "Décalage de présentation": `${(remux.presentationDelaySeconds * 1000).toFixed(0)} ms`,
      "Images recalées": String(remux.clampedSamples),
      Index: `${this.remuxer.videoCuePoints} points vidéo / ${this.file.cues.length}`,
      // The spans themselves, not one number derived from them. A single figure hid which range
      // it was measured against, and read as a large negative number while the player was in
      // fact working correctly on a range it had not been told about.
      ...(this.mse?.debug ?? {}),
      "Sous-titres en mémoire": String(this.cues.length),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.video.removeEventListener("timeupdate", this.keepAroundHead);
    this.video.removeEventListener("seeked", this.keepAroundHead);
    this.mse?.destroy();
    this.mse = null;
    // Releases the software decoder and the encoder, when the sound was going through both.
    this.remuxer.close();
    this.source.close();
  }
}
