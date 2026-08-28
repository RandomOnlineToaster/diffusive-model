// Hydraulic formulas, and nothing else: no Leaflet, no DOM, no config. Every
// number a formula needs is an argument, so the same functions serve the
// street model, the pipe model and the Node test in scripts/test-hydraulics.mjs.
//
// Units throughout are SI - metres, square metres, seconds, cubic metres per
// second - except where a name says otherwise (mm/h is how rain is quoted).

export const GRAVITY = 9.80665;

/** Keep a value inside [low, high]. */
function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

// --- cross-sections ---------------------------------------------------------
//
// Manning's equation needs the flow area A and the hydraulic radius R = A / P
// (P is the wetted perimeter: the length of wall in contact with water). Both
// depend on how deep the water in the conduit is, so each shape gets a
// function from depth to { area, wettedPerimeter, hydraulicRadius, topWidth }.

/** A round pipe of diameter D running y deep (0 <= y <= D). */
export function circularSection(diameterM, depthM) {
  const D = diameterM;
  const y = clamp(depthM, 0, D);
  if (y <= 0) {
    return { area: 0, wettedPerimeter: 0, hydraulicRadius: 0, topWidth: 0 };
  }
  if (y >= D) {
    const area = (Math.PI * D * D) / 4;
    return { area, wettedPerimeter: Math.PI * D, hydraulicRadius: D / 4, topWidth: 0 };
  }

  // theta is the angle at the centre subtended by the water surface.
  const theta = 2 * Math.acos(1 - (2 * y) / D);
  const area = ((D * D) / 8) * (theta - Math.sin(theta));
  const wettedPerimeter = (D * theta) / 2;
  return {
    area,
    wettedPerimeter,
    hydraulicRadius: area / wettedPerimeter,
    topWidth: D * Math.sin(theta / 2)
  };
}

/** A rectangular box culvert W wide and H high running y deep. */
export function boxSection(widthM, heightM, depthM) {
  const y = clamp(depthM, 0, heightM);
  if (y <= 0) {
    return { area: 0, wettedPerimeter: 0, hydraulicRadius: 0, topWidth: 0 };
  }
  const full = y >= heightM;
  const area = widthM * y;
  const wettedPerimeter = full ? 2 * (widthM + heightM) : widthM + 2 * y;
  return {
    area,
    wettedPerimeter,
    hydraulicRadius: area / wettedPerimeter,
    topWidth: full ? 0 : widthM
  };
}

export const SHAPE_CIRCULAR = 0;
export const SHAPE_BOX = 1;

/** Section of either shape. For a round pipe `widthM` is the diameter. */
export function sectionOf(shape, widthM, heightM, depthM) {
  return shape === SHAPE_BOX
    ? boxSection(widthM, heightM, depthM)
    : circularSection(widthM, depthM);
}

/**
 * The same, written into a record the caller owns and reuses.
 *
 * A network step evaluates a section per conduit per substep - tens of
 * thousands of times a step - and returning a fresh object each time made
 * the garbage collector, not the arithmetic, the cost of the model.
 */
export function sectionInto(out, shape, widthM, heightM, depthM) {
  if (shape === SHAPE_BOX) {
    const y = clamp(depthM, 0, heightM);
    if (y <= 0) {
      out.area = 0;
      out.wettedPerimeter = 0;
      out.hydraulicRadius = 0;
      out.topWidth = 0;
      return out;
    }
    const full = y >= heightM;
    out.area = widthM * y;
    out.wettedPerimeter = full ? 2 * (widthM + heightM) : widthM + 2 * y;
    out.hydraulicRadius = out.area / out.wettedPerimeter;
    out.topWidth = full ? 0 : widthM;
    return out;
  }

  const D = widthM;
  const y = clamp(depthM, 0, D);
  if (y <= 0) {
    out.area = 0;
    out.wettedPerimeter = 0;
    out.hydraulicRadius = 0;
    out.topWidth = 0;
    return out;
  }
  if (y >= D) {
    out.area = (Math.PI * D * D) / 4;
    out.wettedPerimeter = Math.PI * D;
    out.hydraulicRadius = D / 4;
    out.topWidth = 0;
    return out;
  }

  const theta = 2 * Math.acos(1 - (2 * y) / D);
  out.area = ((D * D) / 8) * (theta - Math.sin(theta));
  out.wettedPerimeter = (D * theta) / 2;
  out.hydraulicRadius = out.area / out.wettedPerimeter;
  out.topWidth = D * Math.sin(theta / 2);
  return out;
}

/** An empty section record, for sectionInto. */
export function createSection() {
  return { area: 0, wettedPerimeter: 0, hydraulicRadius: 0, topWidth: 0 };
}

// --- Manning's equation -----------------------------------------------------
//
//   v = (1 / n) * R^(2/3) * sqrt(S)       Q = A * v
//
// n is the roughness of the wall (concrete ~0.013, smooth plastic ~0.011,
// asphalt street ~0.015), S the slope of the energy line. For a slow-changing
// flow S is the slope of the water surface, which is what both models use:
// that is what makes a full downstream pipe back water up an upstream one.

export function manningVelocity(hydraulicRadius, slope, n) {
  if (!(hydraulicRadius > 0) || !(slope > 0)) {
    return 0;
  }
  return (1 / n) * Math.cbrt(hydraulicRadius * hydraulicRadius) * Math.sqrt(slope);
}

export function manningFlow(area, hydraulicRadius, slope, n) {
  return area * manningVelocity(hydraulicRadius, slope, n);
}

/** The most a conduit carries running full, before it surcharges. */
export function fullFlowCapacity(shape, widthM, heightM, n, slope) {
  const full = sectionOf(shape, widthM, heightM, heightM);
  return manningFlow(full.area, full.hydraulicRadius, slope, n);
}

// --- inlets -----------------------------------------------------------------
//
// A grated inlet takes water two ways. With a shallow sheet flowing over it, it
// behaves as a WEIR along its perimeter (Q grows with depth^1.5); once
// submerged it behaves as an ORIFICE through its open area (Q grows with
// sqrt(depth)). The lower of the two is what it actually passes, and a share
// of that is lost to the leaves and litter that block real grates.
//
//   weir:    Q = Cw * P * d^1.5      Cw ~ 1.66 (SI)
//   orifice: Q = Co * A * sqrt(2 g d) Co ~ 0.67

export const INLET_WEIR_COEFFICIENT = 1.66;
export const INLET_ORIFICE_COEFFICIENT = 0.67;

export function inletCapture({ depthM, perimeterM, openAreaM2, clogging = 0 }) {
  if (!(depthM > 0)) {
    return 0;
  }
  const weir = INLET_WEIR_COEFFICIENT * perimeterM * Math.sqrt(depthM * depthM * depthM);
  const orifice = INLET_ORIFICE_COEFFICIENT * openAreaM2 * Math.sqrt(2 * GRAVITY * depthM);
  return Math.min(weir, orifice) * (1 - clamp(clogging, 0, 1));
}

// --- infiltration -----------------------------------------------------------
//
// Horton's curve: dry ground soaks water up fast, then settles to a steady
// rate as it saturates.
//
//   f(t) = fc + (f0 - fc) * e^(-k t)
//
// f0 is the starting rate, fc the saturated rate, k how quickly it decays and
// t how long the ground has been wet. All rates share whatever unit f0 and fc
// are given in; k must match the unit of t.

export function hortonRate({ f0, fc, k, wetSeconds }) {
  if (!(wetSeconds > 0)) {
    return f0;
  }
  return fc + (f0 - fc) * Math.exp(-k * wetSeconds);
}

// --- tide -------------------------------------------------------------------
//
// A tide is a sum of cosines, one per astronomical constituent. These four
// give a mixed, mainly diurnal tide of about 1.5-2 m range, which is what the
// Gulf of Thailand at Pattaya does; the phases are arbitrary (anchored to the
// Unix epoch), so this is the SHAPE of the tide, not today's timetable. It is
// the stand-in when the live sea-level forecast cannot be fetched.

export const PATTAYA_TIDE_CONSTITUENTS = [
  { name: 'K1', periodHours: 23.9345, amplitudeM: 0.55, phaseDeg: 40 },
  { name: 'O1', periodHours: 25.8193, amplitudeM: 0.35, phaseDeg: 10 },
  { name: 'M2', periodHours: 12.4206, amplitudeM: 0.25, phaseDeg: 0 },
  { name: 'S2', periodHours: 12.0, amplitudeM: 0.1, phaseDeg: 0 }
];

export function harmonicTide(timeMs, constituents = PATTAYA_TIDE_CONSTITUENTS, meanLevelM = 0) {
  const hours = timeMs / 3.6e6;
  let level = meanLevelM;
  for (const { periodHours, amplitudeM, phaseDeg } of constituents) {
    level += amplitudeM * Math.cos((2 * Math.PI * hours) / periodHours - (phaseDeg * Math.PI) / 180);
  }
  return level;
}

// --- pumps ------------------------------------------------------------------
//
// A pump station switches on when its sump fills past a start level and off
// again below a stop level - the gap between the two stops it chattering.
// Returns the rate it runs at now and the new on/off state.

export function pumpDischarge({ depthM, startDepthM, stopDepthM, ratedM3s, running }) {
  const next = running ? depthM > stopDepthM : depthM >= startDepthM;
  return { rateM3s: next ? ratedM3s : 0, running: next };
}

// --- wind -------------------------------------------------------------------
//
// Storm cells drift with the wind that steers them. Meteorological direction
// is where the wind comes FROM, so the cell moves the opposite way; `factor`
// scales the speed (a cell moves at roughly three quarters of the mid-level
// wind, and mid-level wind is stronger than the 10 m wind by about a half).

export function stormSteering({ speedMs, directionFromDeg, factor = 1 }) {
  const towardRad = ((directionFromDeg + 180) * Math.PI) / 180;
  const speed = speedMs * factor;
  return {
    east: speed * Math.sin(towardRad),
    north: speed * Math.cos(towardRad),
    speedMs: speed,
    bearingDeg: (directionFromDeg + 180) % 360
  };
}

// --- helpers shared by the models -------------------------------------------

/**
 * The volume that would level two connected tanks of plan areas a and b whose
 * water surfaces differ by headM. Transfers are capped at a fraction of this
 * so two tanks relax towards each other instead of overshooting into a
 * ping-pong between substeps.
 */
export function equalisingVolume(headM, areaA, areaB) {
  if (!(areaA > 0) || !(areaB > 0)) {
    return 0;
  }
  return (headM * areaA * areaB) / (areaA + areaB);
}
