import './style.css';
import { createAppLayout } from './ui.js';
import { createRainfallController } from './rainfall.js';
import { initializeMap } from './map.js';

createAppLayout(document.querySelector('#app'));

// The calculator card renders its own outputs; nothing else consumes it.
createRainfallController({ onChange: () => {} });

initializeMap();
