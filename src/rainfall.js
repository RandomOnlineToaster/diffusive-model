export function createRainfallController({ onChange }) {
  const rainfallInput = document.querySelector('#rainfall-mm');
  const areaInput = document.querySelector('#rainfall-area');
  const cubicMetersOutput = document.querySelector('#rainfall-result-m3');
  const litersOutput = document.querySelector('#rainfall-result-liters');

  const computeState = () => {
    const rainfallMm = sanitize(rainfallInput.value);
    const areaM2 = sanitize(areaInput.value);
    const liters = rainfallMm * areaM2;
    const cubicMeters = liters / 1000;

    return {
      rainfallMm,
      areaM2,
      liters,
      cubicMeters
    };
  };

  const render = () => {
    const state = computeState();

    cubicMetersOutput.textContent = `${formatNumber(state.cubicMeters)} m³`;
    litersOutput.textContent = `${formatNumber(state.liters)} liters`;

    onChange(state);
    return state;
  };

  rainfallInput.addEventListener('input', render);
  areaInput.addEventListener('input', render);

  render();

  return {
    getState: computeState,
    setArea(value) {
      areaInput.value = String(Math.max(0, value));
      render();
    }
  };
}

function sanitize(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(value);
}
