// A common time axis for a forecast grid whose points may not all carry the
// same time steps. No Leaflet here, so `npm test` can check it.
//
// TMD's grid answers one series per point, and a point's series can skip an
// hour. Reading the axis off the first point (or off "whichever point fills
// index i first") then shifts every other point's values against it, hides
// the missing hour from the slider, and puts the wrong figure under the
// playhead. So the axis is the sorted union of every stamp seen, and each
// point's values are placed by their own stamp; a step a point does not have
// reads 0 (no rain reported) rather than a neighbour's figure.

/**
 * @param series  [{ stamps: string[], values: number[] }] one per point
 * @returns { times: string[], rows: number[][] } rows[i] aligned to times
 */
export function alignSeries(series) {
  const byStamp = new Map(); // stamp -> parsed ms, for sorting
  for (const { stamps } of series) {
    for (const stamp of stamps || []) {
      if (stamp && !byStamp.has(stamp)) {
        const ms = Date.parse(stamp);
        byStamp.set(stamp, Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY);
      }
    }
  }

  const times = [...byStamp.keys()].sort((a, b) => byStamp.get(a) - byStamp.get(b));
  const index = new Map(times.map((stamp, at) => [stamp, at]));

  const rows = series.map(({ stamps, values }) => {
    const row = new Array(times.length).fill(0);
    (stamps || []).forEach((stamp, at) => {
      const slot = index.get(stamp);
      if (slot !== undefined) {
        const value = Number(values?.[at]);
        row[slot] = Number.isFinite(value) ? value : 0;
      }
    });
    return row;
  });

  return { times, rows };
}

/**
 * The step a moment falls in: the last step at or before it, provided the
 * moment is before the next step (or, for the last step, within one step's
 * length of it). -1 when the moment is outside the axis.
 *
 * @param stampsMs  parsed step times, ascending
 * @param nowMs     the moment
 * @param stepMs    nominal step length, for the last step's end
 */
export function stepContaining(stampsMs, nowMs, stepMs = 3600 * 1000) {
  const count = stampsMs.length;
  if (count === 0 || !Number.isFinite(nowMs) || nowMs < stampsMs[0]) {
    return -1;
  }
  for (let index = 0; index < count; index += 1) {
    const end = index + 1 < count ? stampsMs[index + 1] : stampsMs[index] + stepMs;
    if (nowMs < end) {
      return index;
    }
  }
  return -1;
}
