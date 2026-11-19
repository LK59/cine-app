import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";

// « Son par Lumen » complet (DECISIONS.md §197) : nos paquets et nos décodeurs. mediabunny ne doit
// être ni chargé ni consulté — c'est ce qui permettra de le retirer du lecteur. Un import de
// mediabunny, ou de ses extensions, fait échouer ce fichier.
const imported = vi.hoisted(() => [] as string[]);
vi.mock("mediabunny", () => {
  imported.push("mediabunny");
  return {};
});
vi.mock("@mediabunny/ac3", () => {
  imported.push("@mediabunny/ac3");
  return {};
});
vi.mock("@mediabunny/dts", () => {
  imported.push("@mediabunny/dts");
  return {};
});

describe("« Son par Lumen » sans mediabunny", () => {
  it("un AC-3 se décode de bout en bout sans charger mediabunny ni ses extensions", async () => {
    const source = new MemoryByteSource(new Uint8Array(readFileSync("src/__tests__/fixtures/mp4/c-hevc-multi.mkv")));
    const file = await openMediaFile(source);
    const ac3 = file.tracks.find((t) => t.codecId === "A_AC3")!;
    const track = await SoftwareAudioTrack.open(source, ac3.number, ac3.codecId, file, { demux: "nôtre", decoders: "nôtres" });
    let frames = 0;
    for await (const block of track.samples(0)) frames += block.planes[0]?.length ?? 0;
    track.close();
    expect(frames).toBeGreaterThan(0);
    expect(imported).toEqual([]);
  });
});
