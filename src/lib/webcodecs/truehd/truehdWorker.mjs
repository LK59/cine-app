// Le décodage TrueHD d'un lot, et le worker qui le fait hors du fil principal (06/11/2026).
//
// Un seul fichier pour les deux rôles, et c'est voulu : le fil principal (le repli, et Node — tests
// et bancs) importe `decodeBlocks` d'ici, et le worker exécute ce même fichier. Ce que le worker rend
// est donc ce que le fil principal rendait, au flottant près : même code, même module WebAssembly,
// mêmes octets en entrée (prouvé par ffmpeg-wasm-regress-bench.spec.ts, FFW_WORKER=1).
//
// Du JavaScript, et non du TypeScript, parce que le worker exécute ce fichier tel quel : le build le
// copie sans y toucher dans `static/media` (`new URL("./truehdWorker.mjs", import.meta.url)`, une
// copie conforme vérifiée dans la sortie du build), et la page le lance par un petit module en ligne
// qui l'importe (truehdDecoder.ts, `createHost`). Le module WebAssembly (truehd-wasm.mjs) est copié
// de la même façon, et son adresse est donnée au worker par son premier message : un import relatif
// ne survivrait pas au nom haché de la copie. Aucun import statique ici, pour la même raison.
// Types : truehdWorker.d.mts.

/**
 * Décode des blocs Matroska, un par un et chacun entier : l'analyseur `mlp_parser` de FFmpeg perd la
 * synchronisation quand on le lance au milieu d'un flux — plus de son après chaque saut —, c'est
 * donc truehd.c qui reçoit chaque bloc tel quel.
 *
 * `scratch` est la mémoire d'entrée du décodeur dans le module ({ input, inputSize }), gardée d'un
 * lot à l'autre et agrandie au besoin.
 */
export function decodeBlocks(m, decoder, scratch, blocks) {
  const frames = new Int32Array(blocks.length);
  const parts = [];
  let channels = 0;
  let sampleRate = 0;
  let errors = 0;
  let total = 0;
  blocks.forEach((block, i) => {
    if (block.length > scratch.inputSize) {
      if (scratch.input) m._free(scratch.input);
      scratch.inputSize = Math.max(block.length, 64 * 1024);
      scratch.input = m._malloc(scratch.inputSize);
    }
    m.HEAPU8.set(block, scratch.input);
    const n = m._thd_decode(decoder, scratch.input, block.length);
    if (n < 0) throw new Error("mémoire épuisée dans le décodeur TrueHD");
    errors += m._thd_errors(decoder);
    if (n === 0) return;
    channels = m._thd_channels(decoder);
    sampleRate = m._thd_sample_rate(decoder);
    frames[i] = n;
    // Relu à chaque fois : la mémoire du module peut grandir, et l'ancienne vue devient vide.
    const at = m._thd_output(decoder) / 4;
    parts.push(m.HEAPF32.slice(at, at + n * channels));
    total += n * channels;
  });
  const pcm = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    pcm.set(part, at);
    at += part.length;
  }
  return { pcm, frames, channels, sampleRate, errors };
}

/** Libère un décodeur et sa mémoire d'entrée — une fois : deux fois, c'est libérer deux fois. */
export function closeDecoder(m, decoder, scratch) {
  if (scratch.input) m._free(scratch.input);
  scratch.input = 0;
  scratch.inputSize = 0;
  m._thd_close(decoder);
}

/**
 * Le worker. Les messages sont traités un par un, dans l'ordre d'arrivée — la chaîne de promesses
 * ne sert qu'au premier, le chargement du module : un `open` arrivé pendant ce chargement attend son
 * tour au lieu de passer devant. Ensuite tout est synchrone. L'ordre est ce qui rend l'annulation
 * sûre : un `reset` envoyé après un lot est appliqué après lui, et avant les lots du nouvel endroit,
 * exactement comme sur le fil principal.
 *
 * Messages reçus : `init` { wasm } ; `open` { req, id, mlp } ; `decode` { req, id, data, sizes } ;
 * `reset` { id } ; `close` { id }. Réponses : { req, ok } ou { req, error } ; `init` répond
 * { ready: true } ou { ready: false, error }. Envoyé de lui-même, une fois : { listening: true }.
 */
export function serveTrueHd(scope) {
  let wasm = null;
  const decoders = new Map();
  let chain = Promise.resolve();

  const answer = (message, transfer) => scope.postMessage(message, transfer ?? []);
  const reason = (error) => (error instanceof Error ? error.message : String(error));

  async function handle(message) {
    switch (message.op) {
      case "init":
        try {
          const { default: createTrueHd } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ message.wasm);
          wasm = await createTrueHd();
          answer({ ready: true });
        } catch (error) {
          answer({ ready: false, error: reason(error) });
        }
        return;
      case "open": {
        try {
          if (!wasm) throw new Error("module TrueHD absent");
          const decoder = wasm._thd_open(message.mlp ? 1 : 0);
          if (!decoder) throw new Error("le décodeur TrueHD n'a pas pu s'ouvrir");
          decoders.set(message.id, { decoder, scratch: { input: 0, inputSize: 0 } });
          answer({ req: message.req, ok: true });
        } catch (error) {
          answer({ req: message.req, error: reason(error) });
        }
        return;
      }
      case "decode": {
        try {
          const entry = decoders.get(message.id);
          if (!entry) throw new Error("décodeur TrueHD fermé");
          // Les blocs arrivent bout à bout dans un seul tampon transféré : des vues, aucune copie.
          const blocks = [];
          let at = 0;
          for (const size of message.sizes) {
            blocks.push(new Uint8Array(message.data, at, size));
            at += size;
          }
          const batch = decodeBlocks(wasm, entry.decoder, entry.scratch, blocks);
          // Rendus par transfert : `pcm` et `frames` ont chacun leur propre tampon (decodeBlocks).
          answer({ req: message.req, ok: batch }, [batch.pcm.buffer, batch.frames.buffer]);
        } catch (error) {
          answer({ req: message.req, error: reason(error) });
        }
        return;
      }
      case "reset": {
        const entry = decoders.get(message.id);
        if (entry) wasm._thd_reset(entry.decoder);
        return;
      }
      case "close": {
        const entry = decoders.get(message.id);
        if (!entry) return;
        decoders.delete(message.id);
        closeDecoder(wasm, entry.decoder, entry.scratch);
        return;
      }
    }
  }

  scope.onmessage = (event) => {
    const message = event.data;
    chain = chain.then(() => handle(message)).catch(() => {});
  };
  // Le premier mot : la page n'envoie rien avant, aucun message ne peut donc précéder `onmessage`.
  answer({ listening: true });
}

// Exécuté comme worker : on sert. Importé par la page ou par Node : rien ne se passe.
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
  serveTrueHd(self);
}
