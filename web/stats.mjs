// Plain statistics, one home: the sum and mean of numbers (a mean of none
// is 0), and the least-squares slope of `ys` over `xs` (null under two
// points, or with every x the same).

export const sum = (list) => list.reduce((t, v) => t + v, 0);
export const mean = (list) => (list.length > 0 ? sum(list) / list.length : 0);
// The middle value (an even list: its middle two's mean); null when empty.
export function median(list) {
  if (list.length === 0) return null;
  const s = list.toSorted((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function leastSquares(xs, ys) {
  if (xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i] - my);
    den += (x - mx) ** 2;
  });
  return den ? num / den : null;
}
