/**
 * Ce qu'un client a le droit de faire entrer dans une URL Jellyfin.
 *
 * Plusieurs routes construisent une URL amont en y concaténant un identifiant ou un segment de
 * chemin venu du client, et signent la requête avec la clé d'administration. Un `..` glissé dans
 * l'un de ces morceaux remonte alors la hiérarchie — `fetch` normalise les segments avant de
 * partir, dans le mauvais sens pour nous : `/videos/{id}/../../Users` devient `/Users`, servi
 * avec les droits de l'administrateur. Les valeurs peuvent porter le séparateur sans jamais
 * l'avoir écrit : sur une route attrape-tout, `%2F` est décodé dans le paramètre de route, et
 * `path.join("/")` reconstitue la traversée quel que soit le moment où Next a décodé.
 *
 * D'où une seule et même liste d'autorisation, ici plutôt que recopiée en tête de chaque route :
 * une regex dupliquée dérive, et il a suffi qu'elle manque à cinq endroits.
 */

/** Un identifiant Jellyfin : 32 chiffres hexadécimaux, jamais autre chose. */
const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * Un segment de chemin de flux. Le point est autorisé — ces noms portent une extension
 * (`master.m3u8`, `main.m3u8`, `hls1/main/0.mp4`, `stream.mkv`) — mais ni `/`, ni `\`, ni `%`,
 * ni `?` ne sont dans la classe, et un segment réduit à `.` ou `..` est refusé plus bas.
 */
const STREAM_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Les formes légitimes n'en comptent jamais plus de trois ; quatre laisse de la marge. */
const MAX_STREAM_SEGMENTS = 4;

export function isJellyfinId(value: unknown): value is string {
  return typeof value === "string" && JELLYFIN_ID_RE.test(value);
}

/** L'index d'une piste de sous-titres : un entier, tel que Jellyfin le numérote. */
export function isSubtitleStreamIndex(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,4}$/.test(value);
}

export function isStreamPathSegment(value: unknown): value is string {
  return (
    typeof value === "string" && value !== "." && value !== ".." && STREAM_SEGMENT_RE.test(value)
  );
}

/** Le chemin attrape-tout complet : chaque segment valide, et pas d'empilement suspect. */
export function isStreamPath(segments: unknown): segments is string[] {
  return (
    Array.isArray(segments) &&
    segments.length > 0 &&
    segments.length <= MAX_STREAM_SEGMENTS &&
    segments.every(isStreamPathSegment)
  );
}

/**
 * Ceinture et bretelles : l'URL réellement construite commence-t-elle bien là où on croit.
 *
 * La comparaison porte sur l'URL **normalisée**, pas sur la chaîne assemblée : c'est `fetch` qui
 * résout les `..`, donc un `target` brut commence toujours par son propre préfixe, traversée
 * comprise. Normaliser d'abord, comparer ensuite, c'est poser la question que `fetch` posera.
 * La validation par segment devrait suffire ; cette vérification-là est celle qui tient encore
 * si une forme d'échappement nous a échappé, parce qu'elle porte sur ce qui part vraiment.
 *
 * **Les deux côtés sont normalisés, et la comparaison porte sur les composants.** Une première
 * version normalisait le `target` puis le comparait, en chaîne, à un préfixe brut — or ce préfixe
 * sort de `JELLYFIN_URL`, une variable d'environnement dont la forme ne nous appartient pas.
 * `new URL().href` réécrit ce que la concaténation avait laissé tel quel : `http://JELLYFIN:8096`
 * devient minuscule, `http://jellyfin:80` perd son port, et la garde refusait alors, en 400, des
 * requêtes parfaitement légitimes. Cela ne se voyait pas parce que la valeur servie ici est
 * `http://jellyfin:8096` — port explicite et non par défaut, minuscules — que la normalisation
 * laisse intact. Une garde qui ne tient que par une coïncidence de configuration ne tient pas.
 *
 * D'où : `origin` comparé à `origin` (c'est lui qui porte le schéma, l'hôte et le port, tous trois
 * normalisés de la même façon des deux côtés) et `pathname` comparé à `pathname`. Le chemin, lui,
 * n'est *pas* normalisé par `URL` au-delà de la résolution des `..` — c'est exactement ce qu'on
 * veut : les deux côtés sortent de la même chaîne littérale, donc une éventuelle bizarrerie
 * (`JELLYFIN_URL` avec un slash final, qui donne `//videos/…`) est la même des deux côtés et ne
 * fait pas échouer la comparaison, tandis qu'une traversée, elle, a disparu du `pathname` du
 * `target` et ne peut plus y correspondre.
 *
 * Le préfixe est ramené à une frontière de segment : sans cela, `…/videos/{id}` couvrirait
 * `…/videos/{id}anything`.
 */
export function isUnderJellyfinPrefix(target: string, prefix: string): boolean {
  let targetUrl: URL;
  let prefixUrl: URL;
  try {
    targetUrl = new URL(target);
    prefixUrl = new URL(prefix);
  } catch {
    // Un préfixe illisible veut dire une configuration illisible : on refuse, on ne devine pas.
    return false;
  }

  if (targetUrl.origin !== prefixUrl.origin) return false;

  const prefixPath = prefixUrl.pathname.endsWith("/") ? prefixUrl.pathname : `${prefixUrl.pathname}/`;
  return targetUrl.pathname.startsWith(prefixPath);
}
