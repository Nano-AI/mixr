// Inputs are L2-normalized, so cosine similarity is the dot product.
export const cosine = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * b[i], 0);

export function normalize(v: Float32Array): Float32Array {
  const n = Math.hypot(...v);
  return n === 0 ? v : v.map((x) => x / n);
}

export const mean = (vs: Float32Array[]): Float32Array => normalize(vs.reduce((s, v) => s.map((x, i) => x + v[i]), new Float32Array(vs[0].length)));
