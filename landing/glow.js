// Living background. A small Navier-Stokes fluid (velocity + ink) runs at low resolution;
// the icon's color field is drawn on top of it, pushed around by the flow, so the page swirls
// on its own and stirs when the cursor moves. When `reveal.goal` flips to 1 (scroll passed the unlock),
// a shockwave from behind the phone shoves the fluid and a "reveal dye" out to every edge; the color
// shows wherever that dye is carried. When it flips back to 0, the wave runs inward and drains it.

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// state: xy = velocity, z = pressure/density, w = ink
const SIM = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uMouseVel;
uniform float uCover;
uniform float uDir;
out vec4 o;
#define T(q) texture(uState, (q) / uRes)
#define DT 0.15
// wavefront radius in fluid pixels: fast out of the phone, easing as it passes the corners
float waveR(vec2 res, float b) {
  return length(res * 0.5) * 1.7 * (1.0 - pow(1.0 - clamp(b, 0.0, 1.0), 3.0)); // well past the corners
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 c = T(p);
  vec4 n = T(p + vec2(0.0, 1.0));
  vec4 e = T(p + vec2(1.0, 0.0));
  vec4 s = T(p - vec2(0.0, 1.0));
  vec4 w = T(p - vec2(1.0, 0.0));
  vec4 lap = -20.0 / 6.0 * c + 4.0 / 6.0 * (n + e + s + w)
    + 1.0 / 6.0 * (T(p + vec2(1.0, 1.0)) + T(p + vec2(-1.0, 1.0)) + T(p + vec2(1.0, -1.0)) + T(p + vec2(-1.0, -1.0)));
  vec4 dx = (e - w) * 0.5;
  vec4 dy = (n - s) * 0.5;
  float div = dx.x + dy.y;

  c.xyw = T(p - DT * c.xy).xyw;          // advect
  c.xy += DT * 0.35 * lap.xy;            // viscosity
  c.w += DT * 0.06 * lap.w;              // ink diffusion
  c.xy -= 0.2 * vec2(dx.z, dy.z);        // pressure
  c.z -= DT * (dx.z * c.x + dy.z * c.y + div * c.z);

  // vorticity confinement: keeps the small curls alive
  float curl = dx.y - dy.x;
  vec2 eta = normalize(vec2(abs(e.y - c.y) - abs(c.y - w.y), abs(n.x - c.x) - abs(c.x - s.x)) + 1e-5);
  c.xy += DT * 0.04 * vec2(eta.y, -eta.x) * curl;

  // two slow drifting currents, so it moves without any input
  float t = uTime;
  float r2 = pow(uRes.y * 0.14, 2.0);
  vec2 e1 = uRes * vec2(0.3 + 0.12 * sin(t * 0.21), 0.5 + 0.28 * sin(t * 0.33));
  vec2 e2 = uRes * vec2(0.7 + 0.12 * cos(t * 0.27), 0.5 + 0.28 * cos(t * 0.29));
  float k1 = exp(-dot(p - e1, p - e1) / r2);
  float k2 = exp(-dot(p - e2, p - e2) / r2);
  c.xy += DT * k1 * vec2(cos(t * 0.5), sin(t * 0.7)) * 1.4;
  c.xy += DT * k2 * vec2(-cos(t * 0.4), sin(t * 0.6)) * 1.4;
  c.w += DT * (k1 + k2) * 0.5;

  // the unlock: a shockwave from behind the phone out past every edge (uDir = 1), or back in
  // when scrolled back (uDir = -1). It shoves the fluid with uneven strength around the ring,
  // so the front tears into tendrils.
  vec2 fromC = p - uRes * 0.5;
  float dist = length(fromC);
  if (uDir != 0.0) {
    vec2 dir = fromC / max(dist, 1e-3);
    float ang = atan(fromC.y, fromC.x);
    float R = waveR(uRes, uCover);
    float band = exp(-pow((dist - R) / (uRes.y * 0.09), 2.0));
    float wob = 1.0 + 0.45 * sin(ang * 7.0 + t * 2.0) + 0.3 * sin(ang * 13.0 - t * 3.0);
    c.xy += band * (uDir * dir * 4.5 * wob + vec2(-dir.y, dir.x) * 2.5 * sin(ang * 5.0 + t));
    c.w += band * 0.35;
  }

  // the cursor stirs it
  float km = exp(-dot(p - uMouse, p - uMouse) / (r2 * 0.3));
  c.xy += km * uMouseVel * 0.5;
  c.w += km * length(uMouseVel) * 0.12;

  if (p.x < 1.0 || p.y < 1.0 || uRes.x - p.x < 1.0 || uRes.y - p.y < 1.0) c.xyw *= 0.0;
  c.w *= 0.992;
  o = clamp(c, vec4(-5.0, -5.0, 0.5, 0.0), vec4(5.0, 5.0, 3.0, 5.0));
}`;

// reveal dye: carried by the fluid's velocity, filled in behind the shockwave, cleared when scrolled back
const DYE = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uDye;
uniform vec2 uRes;
uniform float uCover;
uniform float uDir;
out vec4 o;
#define DT 0.15
// wavefront radius in fluid pixels: fast out of the phone, easing as it passes the corners
float waveR(vec2 res, float b) {
  return length(res * 0.5) * 1.7 * (1.0 - pow(1.0 - clamp(b, 0.0, 1.0), 3.0)); // well past the corners
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 vel = texture(uState, p / uRes).xy;
  float d = texture(uDye, (p - DT * vel * 4.0) / uRes).x;
  // going out: fill well behind the wavefront, the front itself is whatever the flow carried ahead.
  // coming back: erase outside the shrinking wave, so the color drains inward with the flow.
  float R = waveR(uRes, uCover);
  // the boundary is bent by the flow itself and by an uneven ring, so it splashes instead of expanding
  vec2 fromC = p - uRes * 0.5 - vel * 4.0;
  float ang = atan(fromC.y, fromC.x);
  float lumpy = 1.0 + 0.12 * sin(ang * 5.0 + R * 0.05) + 0.07 * sin(ang * 11.0 - R * 0.08);
  float inside = smoothstep(R * 0.8, R * 0.5, length(fromC) * lumpy);
  d = uDir < 0.0 ? d * inside : max(d, inside);
  o = vec4(uCover <= 0.0 ? 0.0 : min(d, 1.5), 0.0, 0.0, 1.0);
}`;

const VIEW = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uDye;
uniform vec2 uRes;
uniform float uTime;
uniform float uCover;
out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * 0.6180339887);
  p *= 25.0;
  return fract(p.x * p.y * (p.x + p.y));
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
const mat2 M = mat2(0.80, 0.60, -0.60, 0.80);
float fbm(vec2 p) {
  float f = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    f += a * noise(p);
    p = M * p * 2.02;
    a *= 0.5;
  }
  return f / 0.96875;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 st = texture(uState, uv);
  vec2 p0 = (2.0 * gl_FragCoord.xy - uRes) / uRes.y;
  float breathe = 0.5 + 0.5 * sin(uTime * 0.8);
  vec2 p = p0 * (1.0 + 0.035 * breathe) + st.xy * 0.07;   // the fluid pushes the colors around
  float t = uTime * 0.12;

  vec2 q = vec2(fbm(p * 0.9 + vec2(0.0, t)), fbm(p * 0.9 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p * 0.9 + 1.8 * q + vec2(1.7, 9.2) + 0.7 * t),
                fbm(p * 0.9 + 1.8 * q + vec2(8.3, 2.8) - 0.5 * t));
  float f = fbm(p * 0.9 + 2.0 * r);

  // the icon's glass colors, a step deeper than the icon so the field has contrast
  vec3 blue  = vec3(0.580, 0.680, 1.000);
  vec3 lilac = vec3(0.700, 0.660, 0.960);
  vec3 pink  = vec3(1.000, 0.700, 0.880);
  vec3 peach = vec3(1.000, 0.840, 0.700);
  vec3 page  = vec3(0.961, 0.965, 0.984);

  vec3 col = mix(blue, lilac, smoothstep(0.25, 0.65, f));
  col = mix(col, pink, smoothstep(0.40, 0.85, r.x));
  col = mix(col, peach, smoothstep(0.50, 0.90, q.y) * 0.8);
  // where the fluid carries ink, the color deepens toward the icon's saturated pink and blue
  float ink = smoothstep(0.0, 2.5, st.w);
  vec3 inkCol = mix(vec3(1.0, 0.62, 0.84), vec3(0.55, 0.64, 1.0), 0.5 + 0.5 * sin(atan(st.y, st.x) + t));
  col = mix(col, inkCol, ink * 0.55);
  // light veins where the field folds over itself
  col = mix(col, page, smoothstep(0.55, 0.75, f) * 0.55 + 0.04 * breathe);
  col = mix(col, page, smoothstep(1.2, 2.4, length(p0)) * 0.3);

  // reveal: color shows wherever the fluid has carried the dye; the end of the scroll fills the rest
  float dye = texture(uDye, uv).x;
  // the last stretch of the wave fills whatever is left (the corners) as a fade, not a jitter
  float m = max(smoothstep(0.02, 0.55, dye), smoothstep(0.8, 1.0, uCover));
  float aura = smoothstep(1.2, 0.0, length(p0)) * (0.10 + 0.07 * breathe) * (1.0 - uCover);
  // the dye's leading edge glows, shifting between the icon's pink and blue
  float rim = smoothstep(0.0, 0.05, dye) * (1.0 - smoothstep(0.05, 0.35, dye)) * (1.0 - smoothstep(0.85, 1.0, uCover));
  vec3 rimCol = mix(vec3(1.0, 0.45, 0.76), vec3(0.40, 0.52, 1.0), 0.5 + 0.5 * sin(atan(p0.y, p0.x) * 2.0 + t * 3.0));
  vec3 c = mix(col * aura, col, m) + rim * rimCol * 0.7;
  // settle into the page color at the bottom of the section, where the footer begins
  c = mix(c, page, smoothstep(0.32, 0.0, uv.y) * m);
  fragColor = vec4(min(c, vec3(1.0)), 1.0);
}`;

function program(gl, frag) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(prog));
  const u = {};
  for (const name of ['uState', 'uDye', 'uRes', 'uTime', 'uMouse', 'uMouseVel', 'uCover', 'uDir']) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u };
}

export function startGlow(canvas, reveal, still) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return false;
  gl.getExtension('EXT_color_buffer_float'); // needed to render into half-float textures
  let sim, dyeProg, view;
  try {
    sim = program(gl, SIM);
    dyeProg = program(gl, DYE);
    view = program(gl, VIEW);
  } catch (err) {
    console.error(err);
    return false;
  }
  gl.bindVertexArray(gl.createVertexArray());

  // ponytail: view at half resolution, fluid at a quarter; it's all soft gradients, so nobody can tell
  let sw = 0, sh = 0, bufs = [], dyes = [];
  const makeBuf = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, sw, sh, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 1, 0); // still water: no velocity, baseline density
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, ok: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE };
  };
  const size = () => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * 0.5));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * 0.5));
    sw = Math.max(1, Math.round(canvas.width / 2));
    sh = Math.max(1, Math.round(canvas.height / 2));
    [...bufs, ...dyes].forEach((b) => (gl.deleteTexture(b.tex), gl.deleteFramebuffer(b.fbo)));
    bufs = [makeBuf(), makeBuf()];
    dyes = [makeBuf(), makeBuf()];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  size();
  addEventListener('resize', size);
  const fluid = () => [...bufs, ...dyes].every((b) => b.ok) && !still;

  // cursor in fluid pixels, and how far it moved since the last frame
  const mouse = { x: -1e4, y: -1e4, px: null, py: null };
  addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width) * sw;
    mouse.y = (1 - (e.clientY - r.top) / r.height) * sh;
  });

  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);
  const t0 = performance.now();
  reveal.cover = still ? 1 : 0;
  const BURST_MS = 1600;
  let prev = performance.now();
  const frame = (now) => {
    const time = still ? 12 : (now - t0) / 1000;
    // coverage runs on its own clock toward "unlocked" or "locked", so the wave always reaches the
    // edges (or drains all the way back) however fast you scroll
    const goal = still || reveal.goal ? 1 : 0;
    const step = (now - prev) / BURST_MS;
    prev = now;
    const before = reveal.cover;
    reveal.cover = goal > before ? Math.min(1, before + step) : goal < before ? Math.max(0, before - step) : before;
    const dir = reveal.cover > before ? 1 : reveal.cover < before ? -1 : 0;
    if (fluid()) {
      const clamp = (v) => Math.max(-20, Math.min(20, v));
      const vx = mouse.px === null ? 0 : clamp(mouse.x - mouse.px);
      const vy = mouse.py === null ? 0 : clamp(mouse.y - mouse.py);
      mouse.px = mouse.x;
      mouse.py = mouse.y;
      gl.useProgram(sim.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bufs[1].fbo);
      gl.viewport(0, 0, sw, sh);
      gl.bindTexture(gl.TEXTURE_2D, bufs[0].tex);
      gl.uniform1i(sim.u.uState, 0);
      gl.uniform2f(sim.u.uRes, sw, sh);
      gl.uniform1f(sim.u.uTime, time);
      gl.uniform2f(sim.u.uMouse, mouse.x, mouse.y);
      gl.uniform2f(sim.u.uMouseVel, vx, vy);
      gl.uniform1f(sim.u.uCover, reveal.cover);
      gl.uniform1f(sim.u.uDir, dir);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      bufs.reverse();

      gl.useProgram(dyeProg.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dyes[1].fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bufs[0].tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dyes[0].tex);
      gl.uniform1i(dyeProg.u.uState, 0);
      gl.uniform1i(dyeProg.u.uDye, 1);
      gl.uniform2f(dyeProg.u.uRes, sw, sh);
      gl.uniform1f(dyeProg.u.uCover, reveal.cover);
      gl.uniform1f(dyeProg.u.uDir, dir);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      dyes.reverse();
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.useProgram(view.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bufs[0].tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dyes[0].tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(view.u.uState, 0);
    gl.uniform1i(view.u.uDye, 1);
    gl.uniform2f(view.u.uRes, canvas.width, canvas.height);
    gl.uniform1f(view.u.uTime, time);
    gl.uniform1f(view.u.uCover, reveal.cover);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const loop = (now) => {
    if (visible && !document.hidden) frame(now);
    if (!still) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return true;
}
