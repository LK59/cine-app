// Mot de passe administrateur oublié (DECISIONS.md §48) :
//
//   docker exec -it cine-app node server-boot/reset-admin-password.mjs
//
// demande le nouveau mot de passe deux fois sans l'afficher, et le pose dans la base. Le nom du
// compte ne change pas ; `--user <nom>` le remplace. Les sessions déjà ouvertes restent ouvertes.
// Un compte fixé par `APP_ADMIN_PASSWORD` dans le .env ne se réinitialise pas ici : il suffit de
// changer la ligne et de relancer le conteneur.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetAdminPassword } from "./adminAccount.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || path.join(appDir, "data");
const userFlag = process.argv.indexOf("--user");
const user = userFlag > 0 ? process.argv[userFlag + 1] : undefined;

/** Lit une ligne sans l'afficher (terminal) ; sans terminal, lit l'entrée telle quelle. */
function ask(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    if (!stdin.isTTY) {
      let text = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => (text += chunk));
      stdin.on("end", () => resolve(text.split(/\r?\n/)[0] ?? ""));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (char) => {
      if (char === "\r" || char === "\n" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(value);
      } else if (char === "\u0003") {
        stdout.write("\n");
        process.exit(130);
      } else if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

if (process.env.APP_ADMIN_PASSWORD) {
  console.error("Le compte administrateur est fixé par APP_ADMIN_PASSWORD (.env) : changez cette ligne et relancez le conteneur.");
  process.exit(1);
}
const password = await ask("Nouveau mot de passe administrateur : ");
if (process.stdin.isTTY) {
  const again = await ask("Confirmez : ");
  if (again !== password) {
    console.error("Les deux saisies diffèrent : rien n'a changé.");
    process.exit(1);
  }
}
try {
  const name = await resetAdminPassword(dataDir, password, user);
  console.log(`Mot de passe du compte « ${name} » remplacé. Connectez-vous avec lui.`);
} catch (error) {
  console.error(`Rien n'a changé : ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
