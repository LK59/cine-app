export interface VipPerson {
  tmdbId: number;
  galleryPath: string;
  links: { instagram?: string; imdb?: string; wikipedia?: string; agency?: string; tiktok?: string };
  bio: { fr: string; es: string; en: string };
  videos?: { id: string; title: string }[];
  timeline?: { date: string; event: string; detail?: string; tag?: string }[];
  quotes?: { text: string; context?: string }[];
}

export const VIP_PERSONS: Record<number, VipPerson> = {
  3247402: {
    tmdbId: 3247402,
    galleryPath: "/app/gallery/clara",
    links: {
      instagram: "https://www.instagram.com/claaragalle/",
      tiktok: "https://www.tiktok.com/@claaragalle",
      imdb: "https://www.imdb.com/name/nm12494183",
      wikipedia: "https://fr.wikipedia.org/wiki/Clara_Galle",
      agency: "https://cramtalent.com/talentos/clara-galle/",
    },
    videos: [
      { id: "q2XtW18Wh8M", title: "Interview" },
      { id: "W8_5TyR0dDY", title: "Interview" },
      { id: "L-XeaV9rQb0", title: "Interview" },
      { id: "HLa1o1s4hSk", title: "Interview" },
      { id: "1n1QcURZ7fU", title: "Interview" },
      { id: "fw98mndzgug", title: "Interview" },
      { id: "-5t_9ixSB-M", title: "Interview" },
      { id: "jHok5LGZQ74", title: "Interview" },
      { id: "PuZ-DlboJhw", title: "Interview" },
    ],
    timeline: [
      { date: "Avril 2019", event: "Première campagne publicitaire", detail: "Campagne de Noël Tous aux côtés d'Emma Roberts", tag: "Publicité" },
      { date: "2020", event: "Installation à Madrid", detail: "Inscription en histoire de l'art à l'Universidad Complutense", tag: "Formation" },
      { date: "Octobre 2021", event: "« Tacones Rojos » de Sebastián Yatra", detail: "Clip musical à 440 millions de vues sur YouTube", tag: "Clip" },
      { date: "4 février 2022", event: "A través de mi ventana — Netflix", detail: "Rôle de Raquel, ses débuts au cinéma. Premier film de la trilogie.", tag: "Netflix" },
      { date: "1er avril 2022", event: "El Internado: Las Cumbres S2 — Prime Video", detail: "Rôle d'Eva Merino dans la série de Prime Video.", tag: "Série" },
      { date: "23 juin 2023", event: "A través del mar — Netflix", detail: "Deuxième volet de la trilogie À travers ma fenêtre.", tag: "Netflix" },
      { date: "23 février 2024", event: "A través de tu mirada — Netflix", detail: "Troisième et dernier volet de la trilogie.", tag: "Netflix" },
      { date: "31 mai 2024", event: "Ni una más — Netflix", detail: "Rôle de Greta dans le thriller espagnol.", tag: "Netflix" },
      { date: "2024", event: "The Head — Saison 3", detail: "Rôle d'Alba dans la série internationale.", tag: "Série" },
      { date: "20 juin 2025", event: "Olympo — Netflix", detail: "Rôle d'Amaia, capitaine d'une équipe de natation synchronisée.", tag: "Netflix" },
      { date: "Fév. – Avr. 2025", event: "Tournage de Esa noche à Pamplona", detail: "Tournage entre la République Dominicaine et le Palacio Baluarte de Pamplona, avec Claudia Salas et Paula Usero.", tag: "Tournage" },
      { date: "13 mars 2026", event: "Esa noche — Netflix", detail: "Minisérie de 8 épisodes. Rôle d'Elena, adaptée du roman That Night de Gillian McAllister (Txintxua Films).", tag: "Netflix" },
    ],
    quotes: [
      {
        text: "Es complicado de asimilar. A veces no entiendo nada, y es normal, porque al final tan repente hay tanto trabajo y tan poco tiempo para la vida que a veces no sabes donde estás. Pero estoy muy agradecida y es un momento de pensar que es solo el principio y que ojalá poder contar un montón de historias más.",
        context: "eCartelera, 2022",
      },
      {
        text: "Te mentiría si te digo que lo estoy llevando realmente bien. Me encanta todo, porque al final esto es precioso, pero a la vez hay partes que son complicadas.",
        context: "eCartelera, 2022",
      },
      {
        text: "Todos los personajes van a contar su historia. Y eso me parece muy bonito y muy justo, y me alegro mucho de que podamos hacer eso.",
        context: "eCartelera, 2022",
      },
    ],
    bio: {
      fr: `Clara Galle, de son vrai nom Clara Huete Sánchez, est née le 15 avril 2002 à Pampelune, en Espagne. Dès son plus jeune âge, elle se passionne pour les arts du spectacle et intègre l'Instituto Plaza de la Cruz, où elle se forme à l'art dramatique tout en suivant des cours de danse contemporaine et urbaine. En 2020, elle s'installe à Madrid pour étudier l'histoire de l'art à l'Université Complutense, conjuguant formation académique et ambitions artistiques.

Sa carrière débute dans la publicité : en avril 2019, elle tourne pour la campagne de Noël de la marque de bijoux Tous, aux côtés d'Emma Roberts. Elle prête ensuite son image à des campagnes touristiques pour Andorre, à un spot Fanta, et collabore avec plusieurs enseignes de mode. En octobre 2021, elle apparaît dans le clip du single Tacones rojos du chanteur colombien Sebastián Yatra, qui lui offre une première exposition musicale notable.

C'est en mai 2021 qu'elle est confirmée pour deux projets qui vont définir sa carrière. D'une part, elle rejoint le casting principal de la deuxième saison de L'Internat : Las Cumbres (Amazon Prime Video), série thriller dont elle incarne le personnage d'Eva Merino. D'autre part, elle obtient le rôle principal de Raquel Mendoza dans le film original Netflix À travers ma fenêtre, adapté du roman d'Ariana Godoy — sa première expérience sur grand écran. Sorti le 4 février 2022, le film rencontre un succès mondial immédiat, si bien que Netflix annonce dès le 15 février le développement de deux suites : À travers ma fenêtre : L'amour pour horizon (2023) et À travers ma fenêtre : Les yeux dans les yeux (2024). Cette trilogie, vue dans des dizaines de pays, lui apporte une véritable reconnaissance internationale et une communauté de fans fidèle et enthousiaste.

La suite de sa carrière confirme sa polyvalence. En 2024, elle incarne Greta dans Ni una más, série abordant des thématiques sociales fortes. En 2025, elle rejoint le casting principal de la série Netflix Olympo, dans laquelle elle joue Amaia Olaberria — un nouveau rôle ambitieux qui marque une étape supplémentaire dans la construction d'une carrière sérielle variée et engagée.`,

      es: `Clara Galle, cuyo nombre real es Clara Huete Sánchez, nació el 15 de abril de 2002 en Pamplona, España. Desde pequeña sintió una profunda atracción por las artes escénicas, por lo que se formó en el Instituto Plaza de la Cruz, donde estudió arte dramático al tiempo que tomaba clases de danza contemporánea y urbana. En 2020, se trasladó a Madrid para cursar Historia del Arte en la Universidad Complutense, combinando su formación académica con sus ambiciones artísticas.

Su carrera comenzó en el mundo de la publicidad: en abril de 2019 participó en la campaña navideña de la joyería Tous junto a Emma Roberts. Posteriormente prestó su imagen a campañas turísticas de Andorra, a un spot de Fanta, y colaboró con varias marcas de moda. En octubre de 2021, apareció en el videoclip del sencillo Tacones rojos del cantante colombiano Sebastián Yatra, lo que le dio una primera y notable proyección musical.

En mayo de 2021 se confirmaron dos proyectos que definirían su trayectoria. Por un lado, se incorporó al reparto principal de la segunda temporada de El Internado: Las Cumbres (Amazon Prime Video), interpretando a Eva Merino. Por otro, obtuvo el papel protagonista de Raquel Mendoza en la película original de Netflix A través de mi ventana, adaptación de la novela de Ariana Godoy — su primera experiencia en el cine. Estrenada el 4 de febrero de 2022, la película alcanzó un éxito mundial inmediato, lo que llevó a Netflix a anunciar el 15 de febrero el desarrollo de dos secuelas: A través del mar (2023) y A través de tu mirada (2024). Esta trilogía, vista en decenas de países, le reportó un reconocimiento internacional genuino y una comunidad de fans fiel y entusiasta.

El resto de su carrera confirma su versatilidad. En 2024, encarnó a Greta en Ni una más, serie que aborda temáticas sociales de calado. En 2025, se incorporó al reparto principal de la serie de Netflix Olympo, donde interpreta a Amaia Olaberria — un papel ambicioso que representa un nuevo paso en la construcción de una carrera televisiva variada y comprometida.`,

      en: `Clara Galle, born Clara Huete Sánchez on April 15, 2002, in Pamplona, Spain, discovered a passion for the performing arts at an early age. She trained at the Instituto Plaza de la Cruz, where she studied dramatic arts alongside contemporary and urban dance. In 2020, she moved to Madrid to study Art History at the Universidad Complutense, balancing her academic pursuits with her growing artistic ambitions.

Her career began in advertising: in April 2019, she appeared in the Christmas campaign for jewellery brand Tous, alongside Emma Roberts. She went on to front tourism campaigns for Andorra, a Fanta commercial, and collaborated with various fashion brands. In October 2021, she featured in the music video for Tacones rojos by Colombian singer Sebastián Yatra, earning her a first wave of wider public attention.

May 2021 marked a turning point, with two major projects confirmed simultaneously. She joined the main cast of the second season of The Boarding School: Las Cumbres (Amazon Prime Video), playing the character Eva Merino. She also landed the lead role of Raquel Mendoza in the Netflix original film Through My Window, adapted from Ariana Godoy's novel — her first experience on screen. Released on February 4, 2022, the film became an instant global success, prompting Netflix to announce two sequels just days later: Through My Window: Across the Sea (2023) and Through My Window: Looking at You (2024). The trilogy, watched across dozens of countries, brought her genuine international recognition and a devoted fanbase.

Her subsequent work confirms her range. In 2024, she played Greta in Ni una más, a series addressing serious social themes. In 2025, she joined the main cast of the Netflix series Olympo as Amaia Olaberria — an ambitious new role marking a further step in a diverse and committed television career.`,
    },
  },
};

export function isVip(tmdbId: number): boolean {
  return tmdbId in VIP_PERSONS;
}

export function isClaraGalleryEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CLARA_GALLERY_ENABLED !== "false";
}
