import './styles/index.css';
import { createAppLayout } from './ui/layout.js';
import { createRainfallController } from './ui/rainfallCalculator.js';
import { initializeMap } from './app/map.js';

createAppLayout(document.querySelector('#app'));

// The calculator card renders its own outputs; nothing else consumes it.
createRainfallController({ onChange: () => {} });

initializeMap();
