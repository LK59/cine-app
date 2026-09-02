// Drawing decoded frames.
//
// Two renderers, because SDR and HDR are genuinely different problems:
//
//  * SDR goes to a 2D canvas. `drawImage(VideoFrame)` is a GPU-side blit the browser already
//    colour-manages correctly; anything more elaborate would be slower for no visible gain.
//
//  * HDR cannot. The pixels are BT.2020 primaries with a PQ transfer curve encoding up to
//    10 000 nits, and a normal canvas is sRGB. Handing those pixels over unconverted is what
//    makes HDR content look washed out and grey in players that don't handle it. The frame's
//    planes are copied out at their native 10-bit depth and converted in a fragment shader:
//    PQ to linear light, BT.2390 roll-off down to the display's range, BT.2020 to BT.709
//    primaries, then the sRGB curve. All of it on the GPU, per pixel, at no measurable cost.

export interface FrameRenderer {
  /** Async on the HDR path: the frame's planes have to be copied out before they can be drawn. */
  draw(frame: VideoFrame): void | Promise<void>;
  destroy(): void;
}

// ── SDR ──────────────────────────────────────────────────────────────────────

class CanvasRenderer implements FrameRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false });
  }

  draw(frame: VideoFrame): void {
    if (!this.ctx) return;
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
  }

  destroy(): void {}
}

// ── HDR ──────────────────────────────────────────────────────────────────────

const VERTEX_SHADER = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  // A single triangle covering the viewport — cheaper than two, and the texture coordinates
  // fall out of the vertex positions.
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position.x, -position.y, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 fragColor;

// Integer samplers: the planes are uploaded as raw 10-bit code values (R16UI) rather than
// normalised textures, because WebGL2 has no normalised 16-bit format without an extension.
uniform usampler2D yPlane;
uniform usampler2D uPlane;
uniform usampler2D vPlane;
// Peak brightness the source is mastered for, in nits. 1000 covers most HDR10 grades; the value
// only sets where the roll-off starts, so being a little off is a gentle change in contrast
// rather than a broken picture.
uniform float peakNits;
// 0 = limited/TV range (16-235 scaled), 1 = full range.
uniform float fullRange;

// SMPTE ST 2084 (PQ): maps a stored code value to absolute luminance in nits.
vec3 pqToLinear(vec3 v) {
  const float m1 = 0.1593017578125;
  const float m2 = 78.84375;
  const float c1 = 0.8359375;
  const float c2 = 18.8515625;
  const float c3 = 18.6875;
  vec3 p = pow(max(v, 0.0), vec3(1.0 / m2));
  vec3 num = max(p - c1, 0.0);
  vec3 den = c2 - c3 * p;
  return pow(num / max(den, 1e-6), vec3(1.0 / m1)) * 10000.0;
}

// Extended Reinhard, applied to luminance only: L * (1 + L/white^2) / (1 + L). It leaves the
// dark and mid tones very close to linear — which is what keeps faces and shadows looking right
// rather than uniformly dimmed — and compresses only as it approaches the peak, mapping the
// mastering white exactly to display white. Chosen over a filmic curve on purpose: it has one
// parameter, it is reversible in the head, and it does not impose a "look" on the grade.
float toneMapLuma(float l, float white) {
  return l * (1.0 + l / max(white * white, 1e-6)) / (1.0 + l);
}

void main() {
  // 10-bit code values, 0..1023.
  float y = float(texture(yPlane, uv).r) / 1023.0;
  float cb = float(texture(uPlane, uv).r) / 1023.0;
  float cr = float(texture(vPlane, uv).r) / 1023.0;

  // Limited range uses 64-940 of 1023 for luma and 64-960 for chroma; full range uses all of it.
  float yScaled = mix((y * 1023.0 - 64.0) / 876.0, y, fullRange);
  float cbScaled = mix((cb * 1023.0 - 512.0) / 896.0, cb - 0.5, fullRange);
  float crScaled = mix((cr * 1023.0 - 512.0) / 896.0, cr - 0.5, fullRange);

  // BT.2020 non-constant luminance YCbCr to R'G'B'.
  vec3 rgb = vec3(
    yScaled + 1.4746 * crScaled,
    yScaled - 0.16455 * cbScaled - 0.57135 * crScaled,
    yScaled + 1.8814 * cbScaled
  );

  vec3 linear = pqToLinear(clamp(rgb, 0.0, 1.0));

  // Normalised so that 1.0 is the mastering peak, then tone-mapped on luminance alone and
  // reapplied as a ratio: scaling the three channels by the same factor is what preserves hue,
  // where mapping each channel separately desaturates bright colours.
  vec3 normalized = linear / peakNits;
  float luma = dot(normalized, vec3(0.2627, 0.6780, 0.0593));
  float mapped = toneMapLuma(luma, 1.0);
  vec3 toned = luma > 1e-6 ? normalized * (mapped / luma) : vec3(0.0);

  // BT.2020 to BT.709 primaries.
  mat3 toBt709 = mat3(
     1.6605, -0.1246, -0.0182,
    -0.5876,  1.1329, -0.1006,
    -0.0728, -0.0083,  1.1187
  );
  vec3 display = clamp(toBt709 * toned, 0.0, 1.0);

  // sRGB transfer curve.
  vec3 srgb = mix(display * 12.92, 1.055 * pow(display, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, display));
  fragColor = vec4(srgb, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Impossible de créer le shader de conversion HDR.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Compilation du shader HDR échouée : ${log ?? "raison inconnue"}`);
  }
  return shader;
}

/** The planar 10-bit formats this renderer knows how to unpack. */
const SUPPORTED_HDR_FORMATS = new Set(["I420P10", "I422P10", "I444P10"]);

class ToneMapRenderer implements FrameRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly textures: WebGLTexture[] = [];
  private buffer: ArrayBuffer | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly peakNits: number, private readonly fullRange: boolean) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, desynchronized: true });
    if (!gl) throw new Error("WebGL2 est indisponible : la conversion HDR ne peut pas s'exécuter.");
    this.gl = gl;

    const program = gl.createProgram();
    if (!program) throw new Error("Impossible de créer le programme WebGL.");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Édition de liens WebGL échouée : ${gl.getProgramInfoLog(program) ?? ""}`);
    }
    this.program = program;
    gl.useProgram(program);

    const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    for (let i = 0; i < 3; i++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Impossible d'allouer les textures de plan.");
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // NEAREST is not a choice: an integer texture cannot be linearly filtered. Chroma is
      // therefore point-sampled, which at these resolutions is invisible.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.push(texture);
    }
    gl.uniform1i(gl.getUniformLocation(program, "yPlane"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uPlane"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "vPlane"), 2);
    gl.uniform1f(gl.getUniformLocation(program, "peakNits"), this.peakNits);
    gl.uniform1f(gl.getUniformLocation(program, "fullRange"), this.fullRange ? 1 : 0);
  }

  static supports(format: string | null): boolean {
    return !!format && SUPPORTED_HDR_FORMATS.has(format);
  }

  async draw(frame: VideoFrame): Promise<void> {
    const gl = this.gl;
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // copyTo is the only way to reach the frame's own 10-bit samples. Uploading the VideoFrame
    // directly as a texture would hand back pixels the browser has already flattened to sRGB,
    // with the HDR information gone before the shader ever sees it. It is asynchronous, and the
    // result must be awaited — uploading the buffer before it is filled draws a green screen.
    const size = frame.allocationSize();
    if (!this.buffer || this.buffer.byteLength < size) this.buffer = new ArrayBuffer(size);
    const bytes = new Uint8Array(this.buffer, 0, size);
    const layout = await frame.copyTo(bytes);

    for (let i = 0; i < 3 && i < layout.length; i++) {
      const { width, height } = this.planeSize(frame, i);
      // The layout says where each plane starts and how wide its rows are; stride can exceed
      // width, so rows are only contiguous when they happen to match.
      const plane = new Uint16Array(this.buffer, layout[i].offset, (layout[i].stride / 2) * height);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, layout[i].stride / 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, plane);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Chroma plane geometry depends only on the frame's subsampling.
  private planeSize(frame: VideoFrame, index: number): { width: number; height: number } {
    if (index === 0) return { width: frame.codedWidth, height: frame.codedHeight };
    const format = frame.format as string | null;
    const horizontal = format === "I444P10" ? 1 : 2;
    const vertical = format === "I420P10" ? 2 : 1;
    return {
      width: Math.ceil(frame.codedWidth / horizontal),
      height: Math.ceil(frame.codedHeight / vertical),
    };
  }

  destroy(): void {
    const gl = this.gl;
    for (const texture of this.textures) gl.deleteTexture(texture);
    gl.deleteProgram(this.program);
  }
}

export function createRenderer(canvas: HTMLCanvasElement, options: { hdr: boolean; peakNits?: number; fullRange?: boolean }): FrameRenderer {
  if (!options.hdr) return new CanvasRenderer(canvas);
  return new ToneMapRenderer(canvas, options.peakNits ?? 1000, options.fullRange ?? false);
}

export const __testing = { ToneMapRenderer, CanvasRenderer };
