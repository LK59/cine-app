import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/config", () => ({ config: { app: { sessionSecret: "un-secret-de-test" } } }));

import { signCastToken, verifyCastToken, castPassFor, withCastPass, CAST_TOKEN_PARAM } from "@/lib/castToken";

// Ce jeton est la seule chose qui ouvre un flux sans session. Ce qui est vérifié ici n'est pas
// qu'il marche — c'est tout ce qu'il doit refuser.

const ITEM = "ac7396d6fe1d5beb0c8608982c04a974";
const AUTRE = "a2aa7c752cbb8120a6af1149d3e3dd91";

describe("le laissez-passer de diffusion", () => {
  it("ouvre le titre pour lequel il a été signé", async () => {
    const token = await signCastToken(ITEM, "louis");
    expect(await verifyCastToken(token, ITEM)).toBe("louis");
  });

  it("n'ouvre aucun autre titre", async () => {
    // Le cœur de la portée : un laissez-passer pour un film, présenté sur le chemin d'un autre,
    // ne vaut rien. L'identifiant est signé *dans* le jeton, pas seulement porté par l'adresse.
    const token = await signCastToken(ITEM, "louis");
    expect(await verifyCastToken(token, AUTRE)).toBeNull();
  });

  it("expire", async () => {
    const token = await signCastToken(ITEM, "louis", 0);
    // Juste avant la fin des six heures, puis juste après.
    expect(await verifyCastToken(token, ITEM, 6 * 60 * 60 * 1000 - 1)).toBe("louis");
    expect(await verifyCastToken(token, ITEM, 6 * 60 * 60 * 1000 + 1)).toBeNull();
  });

  it("refuse une signature modifiée", async () => {
    const token = await signCastToken(ITEM, "louis");
    const [payload, signature] = token.split(".");
    // **Pas le dernier caractère.** Une signature HMAC-SHA256 fait 32 octets, soit 43 caractères
    // base64url dont le dernier ne porte que 4 bits utiles : deux caractères différents y
    // décodent vers les mêmes octets, et « modifier » la signature ne la modifie pas. Une version
    // antérieure de ce test faisait exactement ça et passait selon le caractère tiré — un test de
    // sécurité intermittent, ce qui est pire que pas de test.
    const altere = signature.slice(0, 5) + (signature[5] === "A" ? "B" : "A") + signature.slice(6);
    const octets = (v: string) => Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    // La garantie que ce test teste quelque chose : les octets doivent vraiment différer.
    expect(octets(altere).equals(octets(signature))).toBe(false);

    expect(await verifyCastToken(`${payload}.${altere}`, ITEM)).toBeNull();
  });

  it("refuse une charge utile modifiée", async () => {
    // Réécrire la durée de validité ou le titre sans refaire la signature ne doit rien donner.
    const token = await signCastToken(ITEM, "louis");
    const signature = token.split(".")[1];
    const forge = Buffer.from(JSON.stringify({ i: AUTRE, u: "louis", e: Date.now() + 10_000 })).toString("base64url");
    expect(await verifyCastToken(`${forge}.${signature}`, AUTRE)).toBeNull();
  });

  it("refuse ce qui n'est pas un jeton, sans jamais lever", async () => {
    // Appelé depuis le proxy, sur le chemin de toutes les requêtes de flux : une vérification qui
    // lève au lieu de refuser transformerait une saisie hasardeuse en panne générale.
    for (const mauvais of ["", "n'importe quoi", "a.b", "...", "eyJhIjoxfQ", null, undefined]) {
      expect(await verifyCastToken(mauvais, ITEM)).toBeNull();
    }
  });

  it("ne se laisse pas remplacer par un jeton signé pour autre chose", async () => {
    // La clé est dérivée avec son propre préfixe de domaine. Un HMAC du même secret brut — ce
    // qu'un autre usage du même `SESSION_SECRET` produirait — ne doit pas passer ici.
    const payload = Buffer.from(JSON.stringify({ i: ITEM, u: "louis", e: Date.now() + 10_000 })).toString("base64url");
    const cle = await crypto.subtle.importKey("raw", new TextEncoder().encode("un-secret-de-test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const brute = Buffer.from(await crypto.subtle.sign("HMAC", cle, new TextEncoder().encode(payload))).toString("base64url");
    expect(await verifyCastToken(`${payload}.${brute}`, ITEM)).toBeNull();
  });
});

describe("la portée du laissez-passer", () => {
  // La seule porte de l'application qui s'ouvre sans session. Ce qui est vérifié ici est
  // exclusivement ce qu'elle doit refuser.
  const requete = (pathname: string, token: string | null, method = "GET") => ({
    method,
    nextUrl: { pathname, searchParams: new URLSearchParams(token ? { [CAST_TOKEN_PARAM]: token } : {}) },
  });

  it("ouvre le flux du titre signé", async () => {
    const token = await signCastToken(ITEM, "louis");
    expect(await castPassFor(requete(`/api/jellyfin/stream/${ITEM}/master.m3u8`, token))).toBe("louis");
    // Et ses segments, qui sont l'essentiel du trafic.
    expect(await castPassFor(requete(`/api/jellyfin/stream/${ITEM}/hls1/main/3.mp4`, token))).toBe("louis");
  });

  it("n'ouvre pas le flux d'un autre titre", async () => {
    const token = await signCastToken(ITEM, "louis");
    expect(await castPassFor(requete(`/api/jellyfin/stream/${AUTRE}/master.m3u8`, token))).toBeNull();
  });

  it("n'ouvre rien d'autre que le flux", async () => {
    // Un laissez-passer valable, présenté partout ailleurs, ne vaut rien. C'est la borne qui fait
    // que cette porte n'ouvre pas l'application.
    const token = await signCastToken(ITEM, "louis");
    for (const ailleurs of [
      "/api/player/lists",
      "/api/auth/me",
      "/api/maintenance",
      "/api/jellyfin/favorite",
      "/gestion",
      "/",
    ]) {
      expect(await castPassFor(requete(ailleurs, token))).toBeNull();
    }
  });

  /**
   * Les sous-titres du **même** titre, et la borne se déplace d'un cran seulement.
   *
   * Ils étaient exclus, et ce test l'affirmait. C'était une erreur de portée, pas de principe :
   * une diffusion ne donne au téléviseur que des adresses, et il va chercher les pistes de
   * sous-titres lui-même, sans cookie. Chacune lui répondait 401 — ce qui se voyait comme une
   * liste réduite à ce que le téléviseur devinait seul. Vérifié en direct le 19/09/2026 : le
   * manifeste répond 200 avec un laissez-passer, la piste de sous-titres 401 avec le même.
   *
   * Ce qui ne change pas : le jeton nomme un titre, et ne vaut que pour lui.
   */
  it("ouvre les sous-titres du titre qu'il nomme", async () => {
    const token = await signCastToken(ITEM, "louis");
    expect(await castPassFor(requete(`/api/jellyfin/stream/subtitle/${ITEM}`, token))).toBe("louis");
  });

  it("n'ouvre pas les sous-titres d'un autre titre", async () => {
    const token = await signCastToken(ITEM, "louis");
    expect(await castPassFor(requete(`/api/jellyfin/stream/subtitle/${AUTRE}`, token))).toBeNull();
  });

  it("n'ouvre pas un chemin qui commence seulement par le même texte", async () => {
    const token = await signCastToken(ITEM, "louis");
    expect(await castPassFor(requete(`/api/jellyfin/streaming/${ITEM}/x.m3u8`, token))).toBeNull();
    expect(await castPassFor(requete(`/api/jellyfin/stream/${ITEM}`, token))).toBeNull();
  });

  it("refuse tout ce qui n'est pas une lecture", async () => {
    // Rien ne s'écrit avec un laissez-passer, quelle que soit l'adresse.
    const token = await signCastToken(ITEM, "louis");
    for (const methode of ["POST", "DELETE", "PUT", "PATCH", "HEAD"]) {
      expect(await castPassFor(requete(`/api/jellyfin/stream/${ITEM}/master.m3u8`, token, methode))).toBeNull();
    }
  });

  it("refuse un identifiant qui n'en est pas un", async () => {
    // La traversée de chemin est déjà refusée plus loin, mais elle ne doit pas non plus arriver
    // jusque-là avec un laissez-passer en main.
    const token = await signCastToken(ITEM, "louis");
    expect(await castPassFor(requete("/api/jellyfin/stream/..%2F..%2Fetc/master.m3u8", token))).toBeNull();
    expect(await castPassFor(requete("/api/jellyfin/stream/-/master.m3u8", token))).toBeNull();
  });

  it("ne laisse rien passer sans jeton", async () => {
    expect(await castPassFor(requete(`/api/jellyfin/stream/${ITEM}/master.m3u8`, null))).toBeNull();
  });
});

describe("le report du laissez-passer dans le manifeste", () => {
  // Le téléviseur ne reçoit qu'une adresse de nous ; il déduit tout le reste du manifeste. Cette
  // fonction décide si la diffusion dure deux heures ou deux secondes.
  const PASS = "jeton.signe";

  it("signe une adresse nue sur sa propre ligne", () => {
    const m = `#EXTINF:6,\n/api/jellyfin/stream/${ITEM}/hls1/main/0.mp4\n`;
    expect(withCastPass(m, ITEM, PASS)).toContain(`0.mp4?${CAST_TOKEN_PARAM}=jeton.signe`);
  });

  it("ajoute au bon séparateur quand l'adresse a déjà des paramètres", () => {
    const m = `/api/jellyfin/stream/${ITEM}/master.m3u8?PlaySessionId=abc\n`;
    expect(withCastPass(m, ITEM, PASS)).toContain(`PlaySessionId=abc&${CAST_TOKEN_PARAM}=jeton.signe`);
  });

  it("signe aussi les adresses entre guillemets — pistes de sous-titres comprises", () => {
    // C'est la forme des renditions : `URI="..."`. La rater, c'est diffuser sans sous-titres.
    const m = `#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/api/jellyfin/stream/${ITEM}/subs/3.m3u8",NAME="fr"\n`;
    const out = withCastPass(m, ITEM, PASS);
    expect(out).toContain(`3.m3u8?${CAST_TOKEN_PARAM}=jeton.signe"`);
    // Et le guillemet fermant reste dehors : une adresse qui l'avalerait serait introuvable.
    expect(out).not.toContain('jeton.signe",NAME'.replace("jeton.signe", 'jeton.signe"'));
  });

  it("ne touche à rien d'autre", () => {
    const m = `#EXTM3U\n#EXT-X-VERSION:7\n/api/jellyfin/stream/autre/x.mp4\n`;
    expect(withCastPass(m, ITEM, PASS)).toBe(m);
  });

  it("ne signe pas deux fois", () => {
    const m = `/api/jellyfin/stream/${ITEM}/a.mp4?${CAST_TOKEN_PARAM}=deja\n`;
    expect(withCastPass(m, ITEM, PASS)).toBe(m);
  });

  it("échappe ce qui doit l'être", () => {
    const m = `/api/jellyfin/stream/${ITEM}/a.mp4\n`;
    expect(withCastPass(m, ITEM, "a+b/c=d")).toContain("a%2Bb%2Fc%3Dd");
  });
});
