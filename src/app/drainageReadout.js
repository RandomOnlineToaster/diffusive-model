import { config } from '../config.js';

// The panel tiles under the storm readouts: the sea level the outfalls meet,
// the wind steering new storms, water held in the pipes, and water the ground
// and generic drains have taken - with the detail on hover - plus the storm
// surge slider that lifts the tide.

const cubic = (value) => `${Math.round(value).toLocaleString()} m³`;

export function createDrainageReadout({ rainfall, tide, wind, pipeNet, roadFlow }) {
  const dom = {
    sea: document.querySelector('#sim-sea'),
    wind: document.querySelector('#sim-wind'),
    drains: document.querySelector('#sim-drains'),
    absorbed: document.querySelector('#sim-absorbed'),
    surge: document.querySelector('#sim-surge'),
    surgeValue: document.querySelector('#sim-surge-value')
  };

  function update() {
    const nowMs = rainfall.scenarioTimeMs;
    const level = tide.levelAt(nowMs);
    dom.sea.textContent = `${level >= 0 ? '+' : '−'}${Math.abs(level).toFixed(2)} m`;
    dom.sea.title =
      `Sea level at the outfalls, metres above mean sea level: ${tide.source}` +
      (tide.isSyntheticAt(nowMs) && tide.available ? ' (outside the forecast window: synthetic tide)' : '') +
      (tide.offsetM ? `, plus ${tide.offsetM.toFixed(1)} m surge` : '');

    const sample = wind.windAt(nowMs);
    if (sample) {
      dom.wind.textContent = `${(sample.speedMs * 3.6).toFixed(0)} km/h from ${Math.round(sample.directionDeg)}°`;
      const steer = wind.steeringVelocityAt(nowMs);
      dom.wind.title =
        `Surface wind, gusting ${(sample.gustMs * 3.6).toFixed(0)} km/h, ${sample.pressureHpa.toFixed(0)} hPa. ` +
        (steer
          ? `New storms drift towards ${Math.round(steer.bearingDeg)}° at ${steer.speedMs.toFixed(1)} m/s ` +
            `(${sample.steeringFromAloft ? '850 hPa' : 'scaled 10 m'} steering wind).`
          : '');
    } else {
      dom.wind.textContent = 'no data';
      dom.wind.title = 'Wind forecast unavailable; new storms start parked.';
    }

    if (pipeNet) {
      const t = pipeNet.totals();
      dom.drains.textContent = cubic(t.storedM3);
      dom.drains.title =
        `Water in the surveyed pipes now. ${t.surchargedNodes.toLocaleString()} manholes surcharged, ` +
        `${t.pumpsRunning} pump stations running (${cubic(t.pumpedM3)} pumped so far), ` +
        `${cubic(t.dischargedM3)} out through the outfalls, ${cubic(t.backflowM3)} in from the sea, ` +
        `${cubic(t.spilledM3)} spilled back onto the streets.`;
    } else {
      dom.drains.textContent = 'no model';
      dom.drains.title = 'Run `npm run build:drainage` to build the pipe network.';
    }

    const s = roadFlow.dynamic?.totals();
    if (s) {
      dom.absorbed.textContent = cubic(s.infiltratedM3 + s.drainedM3);
      dom.absorbed.title =
        `${cubic(s.infiltratedM3)} soaked into the ground, ${cubic(s.drainedM3)} down generic drains ` +
        `outside the surveyed network, ${cubic(s.capturedM3)} down the inlets, ` +
        `${cubic(s.dischargedM3)} out through ${s.seaOutfalls.toLocaleString()} sea and other street outfalls, ` +
        `${cubic(s.backflowM3)} in from the sea over the streets.`;
    }
  }

  // The surge slider: an offset on the tide, applied live.
  dom.surge.value = String(config.tideSurgeM);
  const showSurge = () => {
    const value = Number(dom.surge.value);
    dom.surgeValue.textContent = `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} m`;
  };
  dom.surge.addEventListener('input', () => {
    tide.setOffset(Number(dom.surge.value));
    showSurge();
    update();
  });
  showSurge();
  update();

  return { update };
}
