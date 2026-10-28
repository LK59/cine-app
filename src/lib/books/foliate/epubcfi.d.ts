// Ce que le lecteur (`BookReader.tsx`) utilise de l'adressage EPUB CFI de foliate-js : situer un signet
// sur la page montrée.

/** Le début (ou, `toEnd`, la fin) d'une adresse qui couvre un passage. */
export function collapse(cfi: string, toEnd?: boolean): string;
/** Négatif, nul ou positif selon que la première adresse vient avant, au même endroit ou après la seconde. */
export function compare(a: string, b: string): number;
