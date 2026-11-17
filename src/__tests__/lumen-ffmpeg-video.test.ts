import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Le ffmpeg vidéo minimal de la version allégée (tools/ffmpeg-video, DECISIONS §195, 17/11/2026) : ce que l'image doit
// tenir ensemble — l'étape qui le construit, le chemin où il est copié et celui que la configuration cherche, la même
// FFmpeg épinglée que le ffmpeg du son, une licence LGPL, et plus le paquet Alpine `ffmpeg` (240 Mo d'image).
const dockerfile = readFileSync("Dockerfile", "utf8");
const video = readFileSync("tools/ffmpeg-video/build.sh", "utf8");
const audio = readFileSync("tools/ffmpeg-lumen/build.sh", "utf8");
const config = readFileSync("src/lib/config.ts", "utf8");

const pin = (script: string, name: string) => new RegExp(`^${name}=(\\S+)$`, "m").exec(script)?.[1];

describe("le ffmpeg vidéo de la version allégée", () => {
  it("construit par sa propre étape, copié là où la configuration le cherche", () => {
    expect(dockerfile).toMatch(/^FROM alpine:3\.24 AS ffmpeg-video$/m);
    expect(dockerfile).toContain("COPY tools/ffmpeg-video/build.sh /build.sh");
    expect(dockerfile).toContain("COPY --from=ffmpeg-video /opt/ffmpeg-video/bin/ffmpeg /usr/local/bin/ffmpeg-video");
    expect(config).toContain('envOnly("LUMEN_VIDEO_FFMPEG_PATH", "/usr/local/bin/ffmpeg-video")');
  });

  it("le paquet Alpine `ffmpeg` n'est plus installé ; seulement libva et le pilote iHD", () => {
    const installs = [...dockerfile.matchAll(/^RUN apk add [^\n]*$/gm)].map((m) => m[0]);
    expect(installs.some((line) => /\bffmpeg\b/.test(line))).toBe(false);
    expect(installs).toContain("RUN apk add --no-cache libva libdrm intel-media-driver");
  });

  it("la même FFmpeg épinglée que le ffmpeg du son, une version annoncée à lui, rien de GPL ni de non libre", () => {
    expect(pin(video, "FFMPEG")).toBe(pin(audio, "FFMPEG"));
    expect(pin(video, "SHA256")).toBe(pin(audio, "SHA256"));
    expect(pin(video, "EXTRA_VERSION")).toMatch(/^lumen-video-\d+$/);
    expect(video).toContain('--extra-version="$EXTRA_VERSION"');
    // Dans les options du configure seulement : le commentaire de tête, lui, dit « ni --enable-gpl, ni --enable-nonfree ».
    const options = video.split("\n").filter((line) => /^\s*(\.\/configure|--)/.test(line)).join("\n");
    expect(options).not.toMatch(/--enable-(gpl|nonfree|version3)\b/);
    expect(video).toContain("--disable-everything --disable-autodetect");
    // Ce que l'encodeur et la détection demandent (`light/encoder.ts`).
    for (const piece of ["--enable-vaapi", "hevc_vaapi", "scale_vaapi", "hwupload", "testsrc2", "--enable-indev=lavfi", "wrapped_avframe", "--enable-demuxer=matroska", "--enable-muxer=hevc"]) {
      expect(video, piece).toContain(piece);
    }
  });
});
