import re, sys


def parse(path):
    txt = open(path, encoding="utf-8-sig", errors="replace").read().replace("\r", "")
    out = []
    for block in re.split(r"\n\s*\n", txt.strip()):
        lines = block.strip().split("\n")
        for i, l in enumerate(lines):
            m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)", l)
            if m:
                g = [int(x) for x in m.groups()]
                s = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
                e = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
                text = " / ".join(re.sub(r"<[^>]+>|\{[^}]+\}", "", x).strip() for x in lines[i + 1:] if x.strip())
                if text:
                    out.append({"start": s, "end": e, "text": text})
                break
    return out


if __name__ == "__main__":
    a = parse(sys.argv[1])
    b = parse(sys.argv[2]) if len(sys.argv) > 2 else []
    c = parse(sys.argv[3]) if len(sys.argv) > 3 else []
    lo = float(sys.argv[4]) if len(sys.argv) > 4 else 0
    hi = float(sys.argv[5]) if len(sys.argv) > 5 else 1e9

    def near(lst, cue):
        r = [x["text"] for x in lst if x["end"] > cue["start"] - 0.1 and x["start"] < cue["end"] + 0.1]
        return " | ".join(r)
    for i, cue in enumerate(a):
        if not (lo <= cue["start"] < hi):
            continue
        print(f"{i:4d} {cue['start']:7.1f} {cue['text']}   ‖ {near(b, cue)}   ‖ {near(c, cue)}")
