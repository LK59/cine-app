// Le décodeur TrueHD/MLP de FFmpeg (libavcodec/mlpdec.c), exposé au JavaScript.
//
// Compilé en WebAssembly par build.sh ; le module produit est
// src/lib/webcodecs/truehd/truehd-wasm.mjs. La sortie est rangée en flottants entrelacés, dans
// l'ordre natif de libavcodec — celui du décodeur DTS que le lecteur utilise déjà, lui aussi tiré
// de libavcodec, c'est-à-dire l'ordre WAVE que la suite de la chaîne attend.
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/log.h>
#include <libavutil/samplefmt.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>

typedef struct {
  const AVCodec *codec;
  AVCodecContext *ctx;
  AVPacket *pkt;
  AVFrame *frame;
  float *out;       // flottants entrelacés, [image][canal]
  int out_cap;      // en flottants
  int out_frames;   // images rendues par le dernier appel
  int channels;
  int sample_rate;
  int errors;       // unités refusées par le dernier appel
} Thd;

static int grow(Thd *d, int floats) {
  if (floats <= d->out_cap) return 0;
  int cap = d->out_cap ? d->out_cap : 65536;
  while (cap < floats) cap *= 2;
  float *next = realloc(d->out, (size_t)cap * sizeof(float));
  if (!next) return -1;
  d->out = next;
  d->out_cap = cap;
  return 0;
}

static int drain(Thd *d) {
  for (;;) {
    int ret = avcodec_receive_frame(d->ctx, d->frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) { d->errors++; return 0; }
    AVFrame *f = d->frame;
    int ch = f->ch_layout.nb_channels;
    int n = f->nb_samples;
    d->channels = ch;
    d->sample_rate = f->sample_rate;
    if (grow(d, (d->out_frames + n) * ch) < 0) { av_frame_unref(f); return -1; }
    float *dst = d->out + (size_t)d->out_frames * ch;
    int planar = av_sample_fmt_is_planar(f->format);
    enum AVSampleFormat packed = av_get_packed_sample_fmt(f->format);
    for (int i = 0; i < n; i++) {
      for (int c = 0; c < ch; c++) {
        float v;
        if (packed == AV_SAMPLE_FMT_S32) {
          const int32_t *src = planar ? (const int32_t *)f->extended_data[c] + i : (const int32_t *)f->extended_data[0] + (size_t)i * ch + c;
          v = (float)(*src / 2147483648.0);
        } else if (packed == AV_SAMPLE_FMT_S16) {
          const int16_t *src = planar ? (const int16_t *)f->extended_data[c] + i : (const int16_t *)f->extended_data[0] + (size_t)i * ch + c;
          v = *src / 32768.0f;
        } else if (packed == AV_SAMPLE_FMT_FLT) {
          const float *src = planar ? (const float *)f->extended_data[c] + i : (const float *)f->extended_data[0] + (size_t)i * ch + c;
          v = *src;
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

EMSCRIPTEN_KEEPALIVE Thd *thd_open(int mlp) {
  // Muet : sans cela, chaque saut écrit « Stream parameters not seen » dans la console du
  // navigateur, pour les quelques unités qui précèdent la première synchronisation majeure.
  av_log_set_level(AV_LOG_QUIET);
  Thd *d = calloc(1, sizeof(Thd));
  if (!d) return NULL;
  d->codec = avcodec_find_decoder(mlp ? AV_CODEC_ID_MLP : AV_CODEC_ID_TRUEHD);
  if (!d->codec) { free(d); return NULL; }
  d->ctx = avcodec_alloc_context3(d->codec);
  d->pkt = av_packet_alloc();
  d->frame = av_frame_alloc();
  if (!d->ctx || !d->pkt || !d->frame || avcodec_open2(d->ctx, d->codec, NULL) < 0) {
    avcodec_free_context(&d->ctx);
    av_packet_free(&d->pkt);
    av_frame_free(&d->frame);
    free(d);
    return NULL;
  }
  return d;
}

// Rend le nombre d'images décodées (par canal), ou -1 si la mémoire manque.
//
// Le bloc va tel quel au décodeur, sans le découpeur mlp_parser. Matroska range une unité d'accès
// par bloc (ou plusieurs, que le décodeur audio consomme l'une après l'autre), et le découpeur,
// démarré en plein flux — c'est-à-dire après chaque saut —, perdait sa synchronisation à chaque
// unité (« Parity check failed ») : il ne sortait plus rien. Le décodeur, lui, ignore proprement
// tout ce qui précède la première synchronisation majeure, puis décode.
EMSCRIPTEN_KEEPALIVE int thd_decode(Thd *d, const uint8_t *data, int size) {
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

// Après un saut : l'état du décodeur appartient à l'endroit d'avant. Il se resynchronise seul
// sur la synchronisation majeure suivante (88 ms au pire, mesurées sur la bibliothèque).
EMSCRIPTEN_KEEPALIVE void thd_reset(Thd *d) {
  avcodec_flush_buffers(d->ctx);
}

EMSCRIPTEN_KEEPALIVE float *thd_output(Thd *d) { return d->out; }
EMSCRIPTEN_KEEPALIVE int thd_channels(Thd *d) { return d->channels; }
EMSCRIPTEN_KEEPALIVE int thd_sample_rate(Thd *d) { return d->sample_rate; }
EMSCRIPTEN_KEEPALIVE int thd_errors(Thd *d) { return d->errors; }

EMSCRIPTEN_KEEPALIVE void thd_close(Thd *d) {
  if (!d) return;
  avcodec_free_context(&d->ctx);
  av_packet_free(&d->pkt);
  av_frame_free(&d->frame);
  free(d->out);
  free(d);
}
