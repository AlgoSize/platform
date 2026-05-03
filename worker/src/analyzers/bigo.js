// Big-O inference from a small set of (n, ms) measurements.
//
// We fit log(t) = log(c) + k * log(n) via ordinary least squares on the
// log-transformed points, then bucket the slope `k` into a complexity class.
// With only 3 data points the fit is noisy — we bias the buckets toward the
// nearest "common" exponent (1, 2, 3) and fall back to "unknown" when the
// run times are too small to be informative (< 0.1 ms each, dominated by
// measurement noise).

const NOISE_FLOOR_MS = 0.1;

/**
 * @param {Array<{n:number, ms:number}>} points  At least 2 points; sizes must be > 0.
 * @returns {{label:string, exponent:number|null, points:Array, reason?:string}}
 */
export function inferBigO(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { label: "unknown", exponent: null, points: points || [], reason: "need ≥ 2 measurements" };
  }

  const usable = points.filter((p) => Number.isFinite(p.n) && p.n > 0 && Number.isFinite(p.ms) && p.ms >= 0);
  if (usable.length < 2) {
    return { label: "unknown", exponent: null, points, reason: "no valid measurements" };
  }

  // If every measurement is below the noise floor we can't say anything
  // meaningful. Report O(1) only if the largest n was actually substantial,
  // otherwise unknown.
  const allBelowNoise = usable.every((p) => p.ms < NOISE_FLOOR_MS);
  if (allBelowNoise) {
    const maxN = Math.max(...usable.map((p) => p.n));
    if (maxN >= 10000) {
      return { label: "O(1)", exponent: 0, points, reason: "all runs below noise floor at large n" };
    }
    return { label: "unknown", exponent: null, points, reason: "all run times below noise floor" };
  }

  // Replace zeros with the noise floor so log() is finite.
  const xs = usable.map((p) => Math.log(p.n));
  const ys = usable.map((p) => Math.log(Math.max(p.ms, NOISE_FLOOR_MS)));
  const meanX = mean(xs);
  const meanY = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const k = den === 0 ? 0 : num / den;

  return { label: bucketize(k), exponent: round(k, 2), points };
}

function bucketize(k) {
  // Bucket boundaries chosen so each "common" complexity class is the centre
  // of its band:                        target k
  //   O(1)        k < 0.30                0
  //   O(log n)    0.30 ≤ k < 0.70        ~0.5 (slope of log-log of log)
  //   O(n)        0.70 ≤ k < 1.30         1
  //   O(n log n)  1.30 ≤ k < 1.70        ~1.4 (slope ~1.4 over n=100..10k)
  //   O(n²)       1.70 ≤ k < 2.50         2
  //   O(n³)       2.50 ≤ k < 3.50         3
  //   O(n^k)      otherwise               (raw exponent reported)
  if (k < 0.30) return "O(1)";
  if (k < 0.70) return "O(log n)";
  if (k < 1.30) return "O(n)";
  if (k < 1.70) return "O(n log n)";
  if (k < 2.50) return "O(n²)";
  if (k < 3.50) return "O(n³)";
  return `O(n^${round(k, 1)})`;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function round(v, places) { const m = 10 ** places; return Math.round(v * m) / m; }
