// Checks src/sources/forecastAxis.js: a grid whose points skip different hours still
// gets one correct axis, with each value under its own stamp.
//
// Run: node scripts/test-forecast-axis.mjs

import { alignSeries, stepContaining } from '../src/sources/forecastAxis.js';

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!condition) {
    failures += 1;
  }
}

const t = (hour) => `2026-08-27T${String(hour).padStart(2, '0')}:00:00+07:00`;

// Point A skips 17:00, point B skips 16:00, point C has every hour.
const { times, rows } = alignSeries([
  { stamps: [t(15), t(16), t(18)], values: [1, 2, 4] },
  { stamps: [t(15), t(17), t(18)], values: [10, 30, 40] },
  { stamps: [t(15), t(16), t(17), t(18)], values: [100, 200, 300, 400] }
]);
check('axis is the union of stamps, in order', times.join() === [t(15), t(16), t(17), t(18)].join(), times.join());
check('point A keeps its values under their own hours', rows[0].join() === '1,2,0,4', rows[0].join());
check('point B keeps its values under their own hours', rows[1].join() === '10,0,30,40', rows[1].join());
check('point C is untouched', rows[2].join() === '100,200,300,400', rows[2].join());

// Unsorted input sorts by time, not by string.
const shuffled = alignSeries([{ stamps: [t(18), t(15)], values: [4, 1] }]);
check('stamps sort by parsed time', shuffled.times.join() === [t(15), t(18)].join() && shuffled.rows[0].join() === '1,4');

// The step containing a moment.
const stamps = [t(15), t(16), t(18)].map((s) => Date.parse(s));
const at = (hour, minute) => Date.parse(`2026-08-27T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+07:00`);
check('16:17 falls in the 16:00 step', stepContaining(stamps, at(16, 17)) === 1);
check('17:30 falls in the 16:00 step (the axis has no 17:00)', stepContaining(stamps, at(17, 30)) === 1);
check('18:59 falls in the last step', stepContaining(stamps, at(18, 59)) === 2);
check('19:01 is past the last step', stepContaining(stamps, at(19, 1)) === -1);
check('14:00 is before the first step', stepContaining(stamps, at(14, 0)) === -1);
check('a 3-hourly last step lasts three hours', stepContaining(stamps, at(20, 30), 3 * 3600 * 1000) === 2);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
