export function createAppLayout(root) {
  root.innerHTML = `
    <div class="app-shell">
      <main class="map-panel">
        <div id="map" class="map-canvas" aria-label="Interactive map of Chon Buri Province"></div>
      </main>

      <aside class="analysis-panel">
        <section class="panel-card panel-card--sim">
          <div class="sim-header">
            <h2>Rainfall Simulator</h2>
            <span class="sim-clock-wrap"><small>sim time</small><span class="sim-clock" id="sim-clock">00:00:00</span></span>
          </div>

          <div class="sim-controls">
            <button type="button" id="sim-play" class="sim-button sim-button--primary">Play</button>
            <button type="button" id="sim-add" class="sim-button">Add storm</button>
            <button type="button" id="sim-reset" class="sim-button">Reset</button>
          </div>

          <label class="field field--inline">
            <span>Speed</span>
            <input id="sim-speed" type="range" min="1" max="100" step="1" value="10"
              title="Simulated seconds per real second" />
            <output id="sim-speed-value">10x</output>
          </label>

          <!-- One editor card per storm, stacked; several can stay open at
               once so two storms can be tuned side by side. Built by
               rainfallSim.js as storms are added and removed. -->
          <div class="storm-cards" id="sim-storms" hidden></div>

          <div class="sim-readout">
            <div><span>Peak now</span><strong id="sim-peak">0 mm/h</strong></div>
            <div><span>Peak cell / step</span><strong id="sim-step">0 mm</strong></div>
            <div><span>Rain volume</span><strong id="sim-volume">0 m&sup3;</strong></div>
            <div><span>Water on map</span><strong id="sim-water">0 m&sup3;</strong></div>
          </div>

          <div class="sim-legend"><span class="sim-legend-stops" id="sim-legend"></span><span class="sim-legend-unit">mm/h</span></div>

          <div class="sim-probe" id="sim-probe">Intensity 0.0 mm/h &middot; Surface 0.0 mm &middot; Total 0.0 mm</div>
        </section>

        <!-- Driven by weather.js while the Rain Forecast layer is on; the
             time controls live here rather than over the map so they have
             room for a separate day and hour. -->
        <section class="panel-card panel-card--forecast" id="forecast-card">
          <div class="sim-header">
            <h2>Rain Forecast</h2>
            <span class="forecast-source" id="forecast-source">loading&hellip;</span>
          </div>

          <label class="field field--inline">
            <span>Day</span>
            <input id="forecast-day" type="range" min="0" max="0" step="1" value="0" />
            <output id="forecast-day-value">&mdash;</output>
          </label>

          <label class="field field--inline">
            <span>Hour</span>
            <input id="forecast-hour" type="range" min="0" max="23" step="1" value="0" />
            <output id="forecast-hour-value">00:00</output>
          </label>

          <div class="sim-readout">
            <div><span>At this hour</span><strong id="forecast-peak">0 mm/h</strong></div>
            <div><span>Day total, wettest spot</span><strong id="forecast-total">0 mm</strong></div>
          </div>

          <div class="forecast-scale">
            <i id="forecast-gradient"></i>
            <span class="forecast-ticks" id="forecast-ticks"></span>
          </div>
        </section>

        <section class="panel-card">
          <h2>Rainfall Calculator</h2>
          <form id="rainfall-form" class="stack-form">
            <label class="field">
              <span>Rainfall amount (mm)</span>
              <input id="rainfall-mm" name="rainfallMm" type="number" min="0" step="0.1" value="0" />
            </label>

            <label class="field">
              <span>Area (m²)</span>
              <input id="rainfall-area" name="areaM2" type="number" min="0" step="1" value="0" />
            </label>

            <div class="result-box">
              <span class="stat-label">Water Volume</span>
              <div class="result-line">
                <strong class="stat-value" id="rainfall-result-m3">0 m³</strong>
                <span class="result-liters" id="rainfall-result-liters">0 liters</span>
              </div>
            </div>
          </form>
        </section>

        <section class="panel-card panel-card--formula">
          <h2>Storm Rain Formula</h2>
          <p class="formula-line">
            I(d) = I<sub>max</sub> &middot; e<sup>&minus;d&sup2; / 2&sigma;&sup2;</sup>
          </p>
          <p class="formula-sub">Every tick each cell gains I &times; &Delta;t / 3600 mm of water, where d is its distance from the storm centre.</p>
          <ul class="formula-params">
            <li><strong>I<sub>max</sub> = <span id="formula-imax">100 mm/h</span></strong>Peak rain rate, only reached at the storm centre (d = 0).</li>
            <li><strong>&sigma; = <span id="formula-sigma">1000 m</span></strong>Spread. Rain thins with distance: 61% of I<sub>max</sub> at 1&sigma;, 14% at 2&sigma;. Bigger &sigma; = wider, gentler storm.</li>
            <li><strong>Rain radius = <span id="formula-rain">3000 m</span></strong>Hard edge. Beyond it the intensity is cut to 0, so the Gaussian tail cannot drizzle everywhere.</li>
            <li><strong>Cloud radius = <span id="formula-cloud">5000 m</span></strong>Cloud cover only. Between the rain radius and this edge you are under cloud but staying dry.</li>
          </ul>
          <table class="formula-table">
            <thead><tr><th>Distance from centre</th><th>Rain rate</th></tr></thead>
            <tbody id="formula-samples"></tbody>
          </table>
        </section>

        <section class="panel-card">
          <h2>Data Layers</h2>
          <ul class="layer-list">
            <li>Boundary: Chon Buri provincial GeoJSON</li>
            <li>Elevation: DEM squares from the local COP30 cache</li>
            <li>Elevation contours: toggleable contour-line overlay</li>
            <li>Rivers &amp; canals: OpenStreetMap waterways (ODbL)</li>
            <li>Lakes, reservoirs and water gates: OpenStreetMap (ODbL)</li>
            <li>Drainage pipes: SMART GIS database export</li>
            <li>Sensors: in-pipe (tunnel) and pole-mounted road stations</li>
            <li>Flow direction: D8 routing on the analysis grid</li>
            <li>Flow accumulation: drainage network from the analysis grid</li>
            <li>Street flow: runoff routed along the OSM street network (30 m DEM heights)</li>
            <li>Rainfall: Gaussian storm cells on a grid, placed and moved on the map</li>
          </ul>
        </section>
      </aside>
    </div>
  `;

}
