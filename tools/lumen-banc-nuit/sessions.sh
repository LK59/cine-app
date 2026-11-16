#!/bin/sh
# Les lectures en cours sur le Jellyfin de production, lues depuis le conteneur cine-app (lecture seule) : appareil,
# titre, direct ou transcodé (et par quoi). Aucun secret affiché : la clé reste dans l'environnement du conteneur.
docker exec cine-app node -e '
const u = (process.env.JELLYFIN_URL || "http://jellyfin:8096") + "/Sessions?ActiveWithinSeconds=120";
fetch(u, { headers: { Authorization: `MediaBrowser Token="${process.env.JELLYFIN_API_KEY}"` } })
  .then((r) => r.json())
  .then((list) => {
    const playing = list.filter((s) => s.NowPlayingItem);
    for (const s of playing) {
      const t = s.TranscodingInfo;
      console.log([s.UserName, s.DeviceName, s.Client, s.NowPlayingItem.Name, s.PlayState?.IsPaused ? "pause" : "lecture",
        t ? `transcodage ${t.VideoCodec || ""}/${t.AudioCodec || ""} hw=${t.HardwareAccelerationType || "non"} direct=${t.IsVideoDirect}` : (s.PlayState?.PlayMethod || "")].join(" | "));
    }
    console.log(`lectures : ${playing.length}`);
  })
  .catch((e) => console.log("sessions illisibles :", e.message));
'
