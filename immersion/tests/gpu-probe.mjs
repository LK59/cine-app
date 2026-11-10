// Quelle carte graphique le navigateur de test utilise-t-il vraiment ? (IMMERSION_GL=egl : celle de la machine.)
import { chromium } from "@playwright/test";
const variants = {
  "gl-egl": ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu"],
  vulkan: ["--use-gl=angle", "--use-angle=vulkan", "--enable-features=Vulkan", "--enable-gpu"],
  swiftshader: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
};
for (const [name, gl] of Object.entries(variants)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  const browser = await chromium.launch({ args: [...gl, "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const info = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return "pas de WebGL 2";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) + " | timer query : " + !!gl.getExtension("EXT_disjoint_timer_query_webgl2");
  });
  console.log(name, "→", info);
  await browser.close();
}
