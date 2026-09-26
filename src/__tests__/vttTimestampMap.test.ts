import { describe, it, expect } from "vitest";
import { fixVttTimestampMap } from "@/lib/vttTimestampMap";

// 26/09/2026 : en AirPlay, chaque sous-titre arrivait dix secondes après sa réplique — le repère
// MPEG-TS de Jellyfin appliqué à des segments fMP4 qui n'ont pas ce décalage.
describe("fixVttTimestampMap", () => {
  it("remet à zéro le repère de dix secondes de Jellyfin", () => {
    const vtt = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:20:31.000 --> 00:20:33.000\nBonjour\n";
    expect(fixVttTimestampMap(vtt)).toBe("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:20:31.000 --> 00:20:33.000\nBonjour\n");
  });

  it("laisse tout autre repère, et le texte, intacts", () => {
    const other = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nMPEGTS:900000\n";
    expect(fixVttTimestampMap(other)).toBe(other);
    expect(fixVttTimestampMap("WEBVTT\n\n")).toBe("WEBVTT\n\n");
  });
});
