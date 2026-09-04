import { redirect } from "next/navigation";

// Le mode cinéma a déménagé : il est devenu l'interface du lecteur, avec sa propre coquille.
// L'ancienne adresse reste, pour les liens et les onglets ouverts.
export default function CinemaRedirect() {
  redirect("/player");
}
