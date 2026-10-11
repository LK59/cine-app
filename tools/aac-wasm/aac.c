// Le décodeur AAC natif de FFmpeg (libavcodec/aacdec), exposé au JavaScript.
//
// Compilé en WebAssembly par build.sh ; le module produit est src/lib/webcodecs/aac/aac-wasm.mjs.
// Pourquoi il existe (11/10/2026) : « Elle s'appelle Ruby » porte un AAC 5.1 décrit par un PCE
// (`channelConfiguration` à 0, écrit par l'encodeur de FFmpeg). Safari sur iPhone refuse de le
// prendre tel quel dans MediaSource, ET son AudioDecoder (CoreAudio) échoue à le décoder
// (« InternalAudioDecoderCocoa decoding failed ») : le film partait au lecteur serveur. Le décodeur
// de FFmpeg lit le PCE ; ce que la chaîne ré-encode ensuite est un AAC à configuration standard.
//
// Même forme que le décodeur TrueHD (tools/truehd-wasm/truehd.c) : flottants entrelacés, dans
// l'ordre natif de libavcodec, et la disposition telle que libavcodec la nomme (`aac_layout_lo/hi`,
// le masque en ordre natif ; 0 sinon) pour que l'appelant puisse vérifier ce qu'il range.
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/log.h>
#include <libavutil/mem.h>
#include <libavutil/samplefmt.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>

typedef struct {
  AVCodecContext *ctx;
  AVPacket *pkt;
  AVFrame *frame;
  float *out;       // flottants entrelacés, [image][canal]
  int out_cap;      // en flottants
  int out_frames;   // images rendues par le dernier appel
  int channels;
  int sample_rate;
  int errors;       // trames refusées par le dernier appel
  uint64_t mask;    // disposition en ordre natif, 0 sinon
} Aac;

static int grow(Aac *d, int floats) {
  if (floats <= d->out_cap) return 0;
  int cap = d->out_cap ? d->out_cap : 65536;
  while (cap < floats) cap *= 2;
  float *next = realloc(d->out, (size_t)cap * sizeof(float));
  if (!next) return -1;
  d->out = next;
  d->out_cap = cap;
  return 0;
}

static int drain(Aac *d) {
  for (;;) {
    int ret = avcodec_receive_frame(d->ctx, d->frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) { d->errors++; return 0; }
    AVFrame *f = d->frame;
    int ch = f->ch_layout.nb_channels;
    int n = f->nb_samples;
    d->channels = ch;
    d->sample_rate = f->sample_rate;
    d->mask = f->ch_layout.order == AV_CHANNEL_ORDER_NATIVE ? f->ch_layout.u.mask : 0;
    if (grow(d, (d->out_frames + n) * ch) < 0) { av_frame_unref(f); return -1; }
    float *dst = d->out + (size_t)d->out_frames * ch;
    int planar = av_sample_fmt_is_planar(f->format);
    enum AVSampleFormat packed = av_get_packed_sample_fmt(f->format);
    for (int i = 0; i < n; i++) {
      for (int c = 0; c < ch; c++) {
        float v;
        if (packed == AV_SAMPLE_FMT_FLT) {
          const float *src = planar ? (const float *)f->extended_data[c] + i : (const float *)f->extended_data[0] + (size_t)i * ch + c;
          v = *src;
        } else if (packed == AV_SAMPLE_FMT_S16) {
          const int16_t *src = planar ? (const int16_t *)f->extended_data[c] + i : (const int16_t *)f->extended_data[0] + (size_t)i * ch + c;
          v = *src / 32768.0f;
        } else if (packed == AV_SAMPLE_FMT_S32) {
          const int32_t *src = planar ? (const int32_t *)f->extended_data[c] + i : (const int32_t *)f->extended_data[0] + (size_t)i * ch + c;
          v = (float)(*src / 2147483648.0);
        } else {
          v = 0.0f;
        }
        dst[(size_t)i * ch + c] = v;
      }
    }
    d->out_frames += n;
    av_frame_unref(f);
  }
}

// La configuration AAC de la piste (AudioSpecificConfig, PCE compris) : sans elle, une trame AAC
// brute — celle d'un bloc Matroska, sans en-tête ADTS — ne se décode pas.
EMSCRIPTEN_KEEPALIVE Aac *aac_open(const uint8_t *asc, int size) {
  av_log_set_level(AV_LOG_QUIET);
  const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_AAC);
  if (!codec || size <= 0) return NULL;
  Aac *d = calloc(1, sizeof(Aac));
  if (!d) return NULL;
  d->ctx = avcodec_alloc_context3(codec);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  if (!d->ctx || !d->pkt || !d->frame) goto fail;
  d->ctx->extradata = av_mallocz((size_t)size + AV_INPUT_BUFFER_PADDING_SIZE);
  if (!d->ctx->extradata) goto fail;
  memcpy(d->ctx->extradata, asc, (size_t)size);
  d->ctx->extradata_size = size;
  if (avcodec_open2(d->ctx, codec, NULL) < 0) goto fail;
  return d;
fail:
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  free(d);
  return NULL;
}

// Rend le nombre d'images décodées (par canal), ou -1 si la mémoire manque.
EMSCRIPTEN_KEEPALIVE int aac_decode(Aac *d, const uint8_t *data, int size) {
  d->out_frames = 0;
  d->errors = 0;
  d->pkt->data = (uint8_t *)data;
  d->pkt->size = size;
  if (avcodec_send_packet(d->ctx, d->pkt) < 0) d->errors++;
  d->pkt->data = NULL;
  d->pkt->size = 0;
  if (drain(d) < 0) return -1;
  return d->out_frames;
}

// Après un saut : l'état (recouvrement de la MDCT) appartient à l'endroit d'avant.
EMSCRIPTEN_KEEPALIVE void aac_reset(Aac *d) { avcodec_flush_buffers(d->ctx); }

EMSCRIPTEN_KEEPALIVE float *aac_output(Aac *d) { return d->out; }
EMSCRIPTEN_KEEPALIVE int aac_channels(Aac *d) { return d->channels; }
EMSCRIPTEN_KEEPALIVE int aac_sample_rate(Aac *d) { return d->sample_rate; }
EMSCRIPTEN_KEEPALIVE int aac_errors(Aac *d) { return d->errors; }
EMSCRIPTEN_KEEPALIVE unsigned aac_layout_lo(Aac *d) { return (unsigned)(d->mask & 0xffffffffu); }
EMSCRIPTEN_KEEPALIVE unsigned aac_layout_hi(Aac *d) { return (unsigned)(d->mask >> 32); }

EMSCRIPTEN_KEEPALIVE void aac_close(Aac *d) {
  if (!d) return;
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  free(d->out);
  free(d);
}
