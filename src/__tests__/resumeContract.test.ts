import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Tout appelant de `playback.play` nomme la position de départ.
 *
 * `resumeAt: 0` veut dire « depuis le début » ; le champ *absent* veut dire « demande au
 * serveur ». Ce ne sont pas deux façons d'écrire la même chose, et les confondre a coûté deux
 * bugs opposés le même jour : « Recommencer » qui reprenait là où l'on s'était arrêté, et un film
 * à moitié vu qui repartait de zéro.
 *
 * Le piège est que l'omission ne se voit pas. Un appelant qui oublie le champ compile, se lance,
 * et démarre au mauvais endroit une fois sur deux selon ce que le serveur se rappelle. D'où ce
 * balayage des sources plutôt qu'un test par écran : ce qu'on protège, c'est qu'*aucun* des
 * treize endroits qui lancent une lecture ne puisse redevenir muet sur la question.
 *
 * L'absence reste permise — mais dite : `resumeAt: resumeKnown ? … : undefined`. Elle est alors
 * une réponse, pas un oubli.
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Le littéral passé à `.play(` — lu accolade par accolade, faute de quoi un objet imbriqué le tronquerait. */
function playArguments(src: string): string[] {
  const found: string[] = [];
  const marker = ".play({";
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) return found;
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    found.push(src.slice(at, i + 1));
    from = i + 1;
  }
}

describe("le contrat de position de départ", () => {
  const files = sources("src");

  it("est exercé — le balayage trouve bien les appelants", () => {
    const total = files.reduce((n, f) => n + playArguments(readFileSync(f, "utf8")).length, 0);
    // Un plancher, pas un compte exact : ajouter un écran ne doit pas casser ce test, mais un
    // balayage qui ne trouve plus rien (renommage de `play`, par exemple) doit se voir.
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it.each(
    files.flatMap((file) =>
      playArguments(readFileSync(file, "utf8")).map((call, i) => [`${file} #${i + 1}`, call] as const)
    )
  )("%s nomme resumeAt", (_where, call) => {
    expect(call).toMatch(/\bresumeAt\b/);
  });
});
