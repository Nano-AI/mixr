// Living background: domain-warped noise in the icon's colors, breathing slowly.
// `reveal.v` (0..1, driven by the scroll timeline) grows an organic blob of color out of the black.

const VERT = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uReveal;
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
  vec2 p = (2.0 * gl_FragCoord.xy - uRes) / uRes.y;
  float breathe = 0.5 + 0.5 * sin(uTime * 0.8);
  p *= 1.0 + 0.035 * breathe;
  float t = uTime * 0.05;

  // fbm(p + fbm(p + fbm(p))): slow, ink-in-water flow
  vec2 q = vec2(fbm(p * 0.9 + vec2(0.0, t)), fbm(p * 0.9 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p * 0.9 + 1.8 * q + vec2(1.7, 9.2) + 0.7 * t),
                fbm(p * 0.9 + 1.8 * q + vec2(8.3, 2.8) - 0.5 * t));
  float f = fbm(p * 0.9 + 2.0 * r);

  vec3 blue  = vec3(0.737, 0.796, 1.000);
  vec3 lilac = vec3(0.788, 0.769, 0.965);
  vec3 pink  = vec3(1.000, 0.824, 0.933);
  vec3 peach = vec3(1.000, 0.902, 0.812);
  vec3 page  = vec3(0.961, 0.965, 0.984);

  vec3 col = mix(blue, lilac, smoothstep(0.25, 0.65, f));
  col = mix(col, pink, smoothstep(0.40, 0.85, r.x));
  col = mix(col, peach, smoothstep(0.50, 0.90, q.y) * 0.8);
  col = mix(col, page, 0.16 + 0.10 * breathe);
  col = mix(col, page, smoothstep(0.9, 2.2, length(p)) * 0.55);

  // the reveal edge wobbles with its own noise so it reads as grown, not drawn
  float d = length(p * vec2(0.85, 1.0)) + (fbm(p * 1.6 + vec2(t * 3.0, -t * 2.0)) - 0.5) * 0.55;
  float edge = uReveal * 2.8;
  float m = smoothstep(edge, edge - 0.3, d);
  // before the unlock: a faint aura breathing behind the phone
  float aura = smoothstep(1.2, 0.0, d) * (0.10 + 0.07 * breathe) * (1.0 - uReveal);
  // a luminous rim rides the growing edge, so black turns to color through light instead of gray
  float rim = smoothstep(0.32, 0.0, abs(d - (edge - 0.15))) * (1.0 - smoothstep(0.75, 1.0, uReveal));
  // saturated, bioluminescent edge that shifts between the icon's pink and blue as it travels
  vec3 rimCol = mix(vec3(1.0, 0.48, 0.78), vec3(0.42, 0.55, 1.0), 0.5 + 0.5 * sin(atan(p.y, p.x) * 2.0 + t * 8.0));
  vec3 c = mix(col * aura, col, m) + rim * rimCol * 0.55;
  // settle into the page color at the bottom of the section, where the footer begins
  c = mix(c, page, smoothstep(0.32, 0.0, gl_FragCoord.y / uRes.y) * m);
  fragColor = vec4(min(c, vec3(1.0)), 1.0);
}`;

export function startGlow(canvas, reveal, still) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return false;
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(sh));
      return false;
    }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());
  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uTime = gl.getUniformLocation(prog, 'uTime');
  const uReveal = gl.getUniformLocation(prog, 'uReveal');

  // ponytail: half resolution; the field is all soft gradients, so it looks the same at a quarter of the cost
  const size = () => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * 0.5));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * 0.5));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  size();
  addEventListener('resize', size);

  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);
  const t0 = performance.now();
  const draw = (now) => {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, still ? 12 : (now - t0) / 1000);
    gl.uniform1f(uReveal, reveal.v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const loop = (now) => {
    if (visible && !document.hidden) draw(now);
    if (!still) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return true;
}
