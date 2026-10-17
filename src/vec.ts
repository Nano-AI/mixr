// Plain vector math on number[]. Embeddings are L2-normalized, so cosine is the dot product.

export const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(dot(v, v));
  return n === 0 ? v : v.map((x) => x / n);
}

export const cosine = (a: number[], b: number[]): number => dot(normalize(a), normalize(b));

export const scale = (v: number[], k: number): number[] => v.map((x) => x * k);

export const add = (...vs: number[][]): number[] => vs.reduce((s, v) => s.map((x, i) => x + v[i]));

export function mean(vs: number[][]): number[] {
  return scale(add(...vs), 1 / vs.length);
}
