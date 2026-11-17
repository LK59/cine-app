import { describe, it, expect } from "vitest";
import { nextCueChange, textTrackCues, textTrackTextAt } from "@/lib/textTrackCues";

/** Une piste du navigateur réduite à ce qu'on en lit : ses répliques (DECISIONS.md §190). */
const trackOf = (cues: { startTime: number; endTime: number; text: string }[]) => ({ cues }) as unknown as TextTrack;

describe("textTrackCues — les répliques d'un `<track>` lues par la page (§190)", () => {
  it("nettoyées (balises, blocs ASS), triées, les vides écartées ; deux répliques qui se chevauchent écrites ensemble", () => {
    const track = trackOf([
      { startTime: 12, endTime: 14, text: "  Second  " },
      { startTime: 10, endTime: 13, text: "<i>Premier</i>" },
      { startTime: 20, endTime: 21, text: "<b></b>" },
      { startTime: 30, endTime: 32, text: "{\\an8}Panneau" },
    ]);
    expect(textTrackCues(track).map((c) => c.text)).toEqual(["Premier", "Second", "{\\an8}Panneau"]);
    expect(textTrackTextAt(textTrackCues(track), 12.5)).toBe("Premier\nSecond");
    expect(textTrackTextAt(textTrackCues(track), 20.5)).toBeNull();
    expect(textTrackTextAt(textTrackCues(track), 31)).toBe("{\\an8}Panneau");
  });

  it("relues quand la piste finit de se charger ou que ses répliques sont déplacées sur place", () => {
    const cues = [{ startTime: 10, endTime: 12, text: "Un" }];
    const track = trackOf(cues);
    expect(textTrackCues(track)).toHaveLength(1);
    cues.push({ startTime: 20, endTime: 22, text: "Deux" });
    expect(textTrackCues(track)).toHaveLength(2);
    for (const cue of cues) {
      cue.startTime += 1;
      cue.endTime += 1;
    }
    expect(textTrackCues(track)[0].startSeconds).toBe(11);
  });

  it("la prochaine borne : un début à venir, ou la fin d'une réplique à l'écran", () => {
    const cues = textTrackCues(trackOf([
      { startTime: 10, endTime: 15, text: "A" },
      { startTime: 12, endTime: 13, text: "B" },
      { startTime: 20, endTime: 22, text: "C" },
    ]));
    expect(nextCueChange(cues, 5)).toBe(10);
    expect(nextCueChange(cues, 12.5)).toBe(13);
    expect(nextCueChange(cues, 14)).toBe(15);
    expect(nextCueChange(cues, 16)).toBe(20);
    expect(nextCueChange(cues, 23)).toBeNull();
  });
});
