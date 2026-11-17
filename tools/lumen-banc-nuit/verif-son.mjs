// Quelle piste joue vraiment, et quand elle change — par corrélation du son capté dans la page avec le son de chaque
// piste du fichier, décodé par ffmpeg (demande de Louis du 16/11 : « vérifier soi-même le changement de piste »).
//
//   node verif-son.mjs <capture.json> <ref-piste-A.f32> <nomA> <ref-piste-B.f32> <nomB> <début des références, s>
//
// capture.json : { rate, chunks: [{ ct, b64 }], switches: [{ at: ct, to }] } — écrit par banc.mjs (MODE=son) : des
// morceaux mono à `rate` Hz (moyenne des canaux, décimés), chacun daté par `video.currentTime` au rappel.
// Références : mono, même `rate`, f32le, depuis la même position du fichier (ffmpeg -ss <début> -map 0:a:K -ac 1).
//
// Méthode : (1) le décalage global capture → média par corrélation des enveloppes (10 ms) sur les 12 premières
// secondes, contre chaque piste, puis affiné sur la forme d'onde (± 20 ms) ; (2) fenêtre par fenêtre (0,5 s), la
// corrélation normalisée de la forme d'onde avec chaque piste autour de ce décalage (± 60 ms : la dérive d'horloge) : la plus forte nomme la piste
// entendue ; « silence » si l'énergie captée est nulle alors que les références ne le sont pas. Les deux doublages
// partagent souvent la musique et les bruits (le même fond « M&E ») : la marge entre les deux corrélations compte
// autant que leur valeur, et seules les fenêtres où elle dépasse 0,15 tranchent.
import fs from "node:fs";

const [capFile, refA, nameA, refB, nameB, refStartS] = process.argv.slice(2);
const cap = JSON.parse(fs.readFileSync(capFile, "utf8"));
const rate = 8000;
const capRate = cap.rate;
const readF32 = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)); };
const refs = [[nameA, readF32(refA)], [nameB, readF32(refB)]];
const r0 = Number(refStartS);

// La capture remise bout à bout, chaque échantillon daté (temps média estimé par le ct du morceau).
const samples = [];
const times = [];
// Chaque morceau ramené à 8 kHz (interpolation linéaire) : la capture est à ctxRate / décimation.
let anchor = cap.chunks[0]?.ct ?? 0;
let anchorAt = 0;
const resyncs = [];
for (const c of cap.chunks) {
  // Un arrêt (blocage, saut, changement de piste) : le son capté continue (silence) pendant que le média ne bouge
  // pas. Au-delà de 2 s d écart (un saut, un long blocage) avec le `ct` du morceau, la datation repart de lui.
  const expected = anchor + (samples.length - anchorAt) / rate;
  if (Math.abs(c.ct - expected) > 2) { resyncs.push(Math.round(c.ct * 10) / 10); anchor = c.ct; anchorAt = samples.length; }
  const buf = Buffer.from(c.b64, "base64");
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const n = Math.floor((f.length * rate) / capRate);
  for (let i = 0; i < n; i++) {
    const p = (i * capRate) / rate;
    const k = Math.floor(p);
    const v = k + 1 < f.length ? f[k] + (f[k + 1] - f[k]) * (p - k) : f[k];
    samples.push(v);
    // Le son capté est continu (ScriptProcessor rend des tampons contigus) : la date d'un échantillon est celle du
    // premier morceau plus son rang. Le `ct` de chaque morceau, lu au rappel, varie de dizaines de ms — trop pour une
    // corrélation de forme d'onde ; il sert seulement à dater le changement de piste.
    times.push(anchor + (samples.length - anchorAt) / rate);
  }
}
const x = Float32Array.from(samples);

const env = (a, step) => { const out = new Float32Array(Math.floor(a.length / step)); for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < step; j++) s += Math.abs(a[i * step + j]); out[i] = s / step; } return out; };
function ncc(a, ai, b, bi, n) {
  let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < n; k++) { const u = a[ai + k] ?? 0, v = b[bi + k] ?? 0; sa += u; sb += v; sab += u * v; saa += u * u; sbb += v * v; }
  const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

// (1) Le décalage : l'échantillon i de la capture correspond à l'échantillon (times[i] - r0) * rate + lag de la référence.
const step = Math.round(rate / 100);
const n12 = Math.min(x.length, 12 * rate);
let best = { score: -1, lag: 0, ref: null };
const ex = env(x.subarray(0, n12), step);
const base = Math.round((times[0] - r0) * rate);
for (const [name, ref] of refs) {
  const er = env(ref, step);
  for (let lagE = -200; lagE <= 200; lagE++) {
    const s = ncc(ex, 0, er, Math.round(base / step) + lagE, ex.length);
    if (s > best.score) best = { score: s, lag: lagE * step, ref: name };
  }
}
let fine = best.lag;
let fineScore = -1;
const refBest = refs.find(([n]) => n === best.ref)[1];
for (let l = best.lag - 2 * step; l <= best.lag + 2 * step; l++) {
  const s = ncc(x, 0, refBest, base + l, Math.min(n12, 4 * rate));
  if (s > fineScore) { fineScore = s; fine = l; }
}

// (2) Fenêtre par fenêtre.
const win = Math.round(rate / 2);
const windows = [];
for (let i = 0; i + win <= x.length; i += win) {
  const at = times[i];
  const ri = Math.round((at - r0) * rate) + fine;
  let e = 0;
  for (let k = 0; k < win; k++) e += x[i + k] * x[i + k];
  const rms = Math.sqrt(e / win);
  // Par piste : le décalage grossier sur l enveloppe (± 1 s, pas de 10 ms), puis la forme d'onde (± 15 ms).
  const exw = env(x.subarray(i, i + win), step);
  const scores = refs.map(([name, ref]) => {
    let bestE = -2, lagE = 0;
    const er = env(ref.subarray(Math.max(0, ri - rate), ri + win + rate), step);
    const off = Math.round(Math.min(rate, ri) / step);
    for (let l = -100; l <= 100; l++) { const v = ncc(exw, 0, er, off + l, exw.length); if (v > bestE) { bestE = v; lagE = l * step; } }
    let m = -1;
    for (let d = lagE - Math.round(rate * 0.015); d <= lagE + Math.round(rate * 0.015); d++) m = Math.max(m, ncc(x, i, ref, ri + d, win));
    let er2 = 0;
    for (let k = 0; k < win; k++) er2 += (ref[ri + k] ?? 0) ** 2;
    return { name, c: Math.round(m * 100) / 100, refRms: Math.sqrt(er2 / win) };
  });
  const [s0, s1] = [...scores].sort((a, b) => b.c - a.c);
  const silent = rms < 1e-4 && Math.max(...scores.map((s) => s.refRms)) > 1e-3;
  windows.push({ at: Math.round(at * 10) / 10, rms: Math.round(rms * 1e4) / 1e4, who: silent ? "silence" : s0.c - s1.c >= 0.15 ? s0.name : "?", c: Object.fromEntries(scores.map((s) => [s.name, s.c])) });
}

// Le changement : la première fenêtre après la demande qui nomme la piste visée, et ce qui la précède.
const report = { resyncs, lagMs: Math.round((fine / rate) * 1000), lagScore: Math.round(fineScore * 100) / 100, firstTrack: best.ref, switches: [] };
for (const sw of cap.switches ?? []) {
  const after = windows.filter((w) => w.at >= sw.at - 0.5);
  const hit = after.find((w) => w.who === sw.to);
  const silentWindows = after.filter((w) => hit && w.at < hit.at && w.who === "silence").length;
  const before = windows.filter((w) => w.at < sw.at && w.at >= sw.at - 5).map((w) => w.who);
  report.switches.push({ requestedAtMedia: sw.at, wallMs: sw.wallMs ?? null, to: sw.to, heardAtMedia: hit?.at ?? null, mediaDelayS: hit ? Math.round((hit.at - sw.at) * 10) / 10 : null, silenceS: silentWindows * 0.5, before: before.join(" ") });
}
const decided = windows.filter((w) => w.who !== "?");
report.summary = Object.fromEntries([...new Set(windows.map((w) => w.who))].map((k) => [k, windows.filter((w) => w.who === k).length]));
report.decidedShare = Math.round((decided.length / Math.max(1, windows.length)) * 100) / 100;
report.windows = windows.map((w) => `${w.at}:${w.who}:${Object.values(w.c).join("/")}`);
console.log(JSON.stringify(report));
