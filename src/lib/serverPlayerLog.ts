/**
 * Ce que le lecteur serveur écrit dans le journal du lecteur.
 *
 * Il n'écrivait rien jusqu'au 23/09/2026 : ni sa prise de main, ni une négociation refusée, ni une
 * diffusion établie. Un repli vers lui se lisait donc comme une fin de séance — la dernière ligne
 * était le `fallback` du lecteur natif —, et l'AirPlay figé du 22/09 n'a pu être compris qu'au
 * journal du relais, en cherchant des requêtes sans laissez-passer. Ces lignes disent à la place :
 * il a pris la main (par quelle voie, pour un téléviseur ou non), il n'a pas pu, le téléviseur
 * s'est connecté.
 *
 * Des fonctions pures, parce que le composant qui les appelle ne se monte pas dans un test : ce
 * qu'elles décident — les champs, et le nom du lecteur sur chaque ligne — se vérifie ici.
 */

/** Ce que toute ligne du lecteur serveur porte, pour se distinguer de celles du lecteur natif. */
export interface ServerPlayerContext {
  itemId: string;
  title: string | null | undefined;
  /** La lecture a été ouverte pour un téléviseur (AirPlay, Remote Playback). */
  cast: boolean;
  /**
   * La séance d'un banc d'essai, s'il y en a une : ses lignes vont alors dans `bench-player.log`,
   * comme celles du lecteur natif. Un film confié au lecteur serveur pendant un banc écrivait son
   * `start` dans le journal des spectateurs (23/09/2026).
   */
  bench?: string;
  /**
   * L'identifiant de séance, comme les lignes du lecteur natif, et le navigateur. Sans eux, le
   * journal reconstituait ces séances « à l'ancienne », par compte et par titre : chaque relance
   * devenait une séance, sans appareil — et, dans le diagnostic « fichier ou appareil », un
   * témoin « propre » qui innocentait le titre (relu le 24/09/2026).
   */
  session?: string;
  agent?: string;
}

/** Le lecteur serveur a obtenu son flux et le pose sur l'élément. */
export function serverStartFields(
  ctx: ServerPlayerContext,
  stream: { directPlay: boolean; nativeHls: boolean; resumeAt: number | undefined; audioStreamIndex: number | undefined }
): Record<string, unknown> {
  return {
    ...base(ctx),
    // Le même nom de champ que le lecteur natif (`remux`, `webcodecs`) : une seule question,
    // « par où cette séance est-elle passée », une seule colonne pour y répondre.
    path: "serveur",
    reason: stream.directPlay ? "fichier servi tel quel" : "transcodé par le serveur",
    hls: stream.directPlay ? "aucun" : stream.nativeHls ? "natif" : "hls.js",
    at: stream.resumeAt ?? 0,
    ...(stream.audioStreamIndex !== undefined ? { audioStreamIndex: stream.audioStreamIndex } : {}),
  };
}

/** Le lecteur serveur n'a pas pu démarrer, ou s'est arrêté sur une erreur affichée. */
export function serverFailureFields(ctx: ServerPlayerContext, reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base(ctx), path: "serveur", reason, ...extra };
}

/** Le téléviseur a pris la route : la diffusion est établie, et non seulement demandée. */
export function castEstablishedFields(ctx: ServerPlayerContext, at: number): Record<string, unknown> {
  return { ...base(ctx), path: "serveur", reason: "diffusion établie", at: Math.round(at) };
}

/**
 * Le lecteur serveur s'arrête — fermé, ou passé à l'épisode suivant.
 *
 * Il notait son démarrage et jamais sa fin : chacune de ses séances se lisait « commencée, jamais
 * finie » dans le journal, comme un lecteur disparu (relevé le 23/09/2026).
 */
export function serverStopFields(ctx: ServerPlayerContext, why: "close" | "next", at: number): Record<string, unknown> {
  return { ...base(ctx), path: "serveur", why, at: Math.round(at) };
}

function base(ctx: ServerPlayerContext): Record<string, unknown> {
  return {
    itemId: ctx.itemId,
    ...(ctx.title ? { title: ctx.title } : {}),
    player: "serveur",
    cast: ctx.cast,
    ...(ctx.bench ? { bench: ctx.bench } : {}),
    ...(ctx.session ? { session: ctx.session } : {}),
    ...(ctx.agent ? { agent: ctx.agent } : {}),
  };
}
