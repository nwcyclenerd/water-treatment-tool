(function(){
  "use strict";

  // === CONVERSION CONSTANTS ===
  // Used throughout calculations for unit conversions between imperial and metric systems
  const WATER_LB_PER_GAL = 8.34; // Mass of water per gallon (base for ppm calculations)
  const GPM_TO_M3HR = 0.2271247; // Flow conversion: gallons per minute to cubic meters per hour
  const GAL_TO_L = 3.78541; // Volume conversion: gallons to liters
  const LB_TO_KG = 0.45359237; // Mass conversion: pounds to kilograms

  // === STATE VARIABLES ===
  let isMetric = false; // Toggle between imperial (false) and metric (true) units
  let chartSeries = { evap: true, bleed: true }; // Chart visibility toggles for cooling balance visualization
  let latestCoolingBleedGpm = NaN; // Cached bleed rate from cooling calcs; used by inhibitor feed section
  let latestPumpGph = NaN; // Cached pump calibration output; can be imported to pump capacity field
  let useCoolingCyclesContext = false;

  const sections = [
    { key: "feed", sectionId: "feedSection", buttonId: "btnFeed" },
    { key: "slug", sectionId: "slugSection", buttonId: "btnSlug" },
    { key: "cycles", sectionId: "cyclesSection", buttonId: "btnCycles" },
    { key: "cooling", sectionId: "coolingSection", buttonId: "btnCooling" },
    { key: "inhib", sectionId: "inhibSection", buttonId: "btnInhib" },
    { key: "biocide", sectionId: "biocideSection", buttonId: "btnBiocide" },
    { key: "pumpCal", sectionId: "pumpCalSection", buttonId: "btnPumpCal" },
    { key: "lsi", sectionId: "lsiSection", buttonId: "btnLSI" },
  ];

  // === UTILITY FUNCTIONS ===
  function $(id){ return document.getElementById(id); } // DOM shortcut
  
  // Convert input to number, handling empty strings, commas, and invalid values
  function toNumber(v){
    if (v === null || v === undefined || String(v).trim() === "") return NaN;
    const n = Number(String(v).replace(/,/g, "")); // Strip commas for user-friendly input
    return Number.isFinite(n) ? n : NaN;
  }
  
  // Format number to fixed decimal places; returns "—" for invalid numbers
  function fmt(v, d){ return Number.isFinite(v) ? v.toFixed(d) : "—"; }
  
  // Format number with magnitude abbreviation (M=millions, K=thousands) for chart labels and large values
  function fmtShort(v, d){
    d = d === undefined ? 1 : d;
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    if (abs >= 1000000) return (v / 1000000).toFixed(d).replace(/\.0$/, "") + "M";
    if (abs >= 1000) return (v / 1000).toFixed(d).replace(/\.0$/, "") + "K";
    return v.toFixed(0);
  }
  
  // Format number with thousands separator (comma grouping) for display
  function fmtComma(v, d){
    d = d === undefined ? 0 : d;
    if (!Number.isFinite(v)) return "—";
    return Number(v.toFixed(d)).toLocaleString();
  }

// === DENSITY TYPE STATE ===
// Tracks previous density input method (sg vs lb/gal) to enable conversion when user switches types
let feedDensityTypePrevious = "sg";
let slugDensityTypePrevious = "sg";
let inhibDensityTypePrevious = "sg";
let biocideDensityTypePrevious = "sg";

// === UNIT CONVERSION ===
// Converts all input field values when user toggles between imperial and metric units.
// Key formula: feed lb/day = dose × gpm × 1440 min/day × 8.34 lb/gal / 1,000,000
function convertUnitFields(previousMetric, newMetric){
  if (previousMetric === newMetric) return;

  // Volume fields: gallons ↔ liters
  const galToLFields = ['volume', 'biocideVolume'];

  galToLFields.forEach(id => {
    const el = $(id);
    if (!el) return;

    const value = toNumber(el.value);
    if (!Number.isFinite(value) || value <= 0) return;

    el.value = newMetric
      ? fmt(value * GAL_TO_L, 2)
      : fmt(value / GAL_TO_L, 2);
  });

  // Flow rate fields: gpm ↔ m³/hr (1 gpm = 0.227 m³/hr)
  const gpmToM3hrFields = ['flow', 'bleedRate', 'recircFlow'];

  gpmToM3hrFields.forEach(id => {
    const el = $(id);
    if (!el) return;

    const value = toNumber(el.value);
    if (!Number.isFinite(value) || value <= 0) return;

    el.value = newMetric
      ? fmt(value * GPM_TO_M3HR, 3)
      : fmt(value / GPM_TO_M3HR, 3);
  });

  const pumpCapacity = $('pumpCapacity');
  if (pumpCapacity){
    const pumpValue = toNumber(pumpCapacity.value);
    if (Number.isFinite(pumpValue) && pumpValue > 0){
      pumpCapacity.value = newMetric
        ? fmt(pumpValue * GAL_TO_L, 3)
        : fmt(pumpValue / GAL_TO_L, 3);
    }
  }

  const tempFields = ['lsiTemp'];

  tempFields.forEach(id => {
  const el = $(id);
    if (!el) return;

    const value = toNumber(el.value);
    if (!Number.isFinite(value)) return;

    el.value = newMetric
        ? fmt((value - 32) * 5 / 9, 1)
        : fmt((value * 9 / 5) + 32, 1);
    });
  }
  // === DENSITY CONVERSION ===
  // Convert density to lb/gal for calculations. SG × 8.34 = lb/gal (where 8.34 is water density)
  function densityToLbGal(value, type){
    if (!Number.isFinite(value) || value <= 0) return NaN;
    return type === "lbgal" ? value : value * WATER_LB_PER_GAL;
  }

  // === DENSITY VALIDATION ===
  // Checks density inputs against reasonable bounds to catch data entry errors
  // Typical range: SG 1.0-1.5 (0.5-12.5 lb/gal). Alerts user if outside normal range.
  function densityWarning(value, type){
    if (!Number.isFinite(value) || value <= 0) return "";
    if (type === "sg" && value > 1.5) return '<div class="warning">⚠️ Specific gravity is above 1.5. Confirm density entry.</div>';
    if (type === "sg" && value < 1.0) return '<div class="warning">⚠️ Specific gravity is below 1.0. Confirm density entry.</div>';
    if (type === "lbgal" && value < 8.0) return '<div class="warning">⚠️ Density is below 8.0 lb/gal. Confirm density entry.</div>';
    if (type === "lbgal" && value > 12.5) return '<div class="warning">⚠️ Density is above 12.5 lb/gal. Confirm density entry.</div>';
    return "";
  }
  // === DYNAMIC LABEL UPDATES ===
  // Updates density field labels to match selected input type (SG or lb/gal)
  // Called when user changes the densityType dropdown
  function updateDensityLabels(){
    if ($("densityLabel")) $("densityLabel").innerText = $("densityType").value === "lbgal" ? "Density (lb/gal)" : "Density (SG)";
    if ($("slugDensityLabel")) $("slugDensityLabel").innerText = $("slugDensityType").value === "lbgal" ? "Density (lb/gal)" : "Density (SG)";
    if ($("inhibDensityLabel")) $("inhibDensityLabel").innerText = $("inhibDensityType").value === "lbgal" ? "Density (lb/gal)" : "Density (SG)";
    if ($("biocideDensityLabel")) $("biocideDensityLabel").innerText = $("biocideDensityType").value === "lbgal" ? "Density (lb/gal)" : "Density (SG)";
  }
  // === FEED RATE CALCULATION ===
  // Core calculation: daily product requirement based on system flow and target dose
  // Formula: lb/day = dose(ppm) × flow(gpm) × 1440(min/day) × 8.34 / 1,000,000
  // Converts to metric (kg/day, L/day) if isMetric flag is true
  // Also provides pump guidance based on selected pump control type and capacity
  function calcFeed(){
    const dose = toNumber($("dose").value);
    const flowInput = toNumber($("flow").value);
    const densityInput = toNumber($("density").value);
    const densityType = $("densityType").value;
    const lbPerGal = densityToLbGal(densityInput, densityType);
    const densityCaution = densityWarning(densityInput, densityType);
    const pumpInput = toNumber($("pumpCapacity").value);
    const pumpType = $("pumpType").value;

    if (!dose || !flowInput || !lbPerGal){
      $("feedResult").innerHTML = '<div class="warning">Enter target dose, system flow, and density.</div>';
      return;
    }

    // Convert flow to gpm for calculation; adjust if user is in metric mode
    const gpm = isMetric ? flowInput / GPM_TO_M3HR : flowInput;
    const lbDay = dose * gpm * 1440 * WATER_LB_PER_GAL / 1000000; // Core feed calculation
    const galDay = lbDay / lbPerGal;
    const galHr = galDay / 24;
    const displayDailyVol = isMetric ? galDay * GAL_TO_L : galDay;
    const displayHourlyVol = isMetric ? galHr * GAL_TO_L : galHr;
    const displayMass = isMetric ? lbDay * LB_TO_KG : lbDay;
    const dailyUnit = isMetric ? "L/day" : "gal/day";
    const hourlyUnit = isMetric ? "L/hr" : "gph";
    const massUnit = isMetric ? "kg/day" : "lb/day";
    let pumpGuidance = "";
    let warning = "";

    if (Number.isFinite(pumpInput) && pumpInput > 0){
      const pumpCapacityGph = isMetric ? pumpInput / GAL_TO_L : pumpInput;
      const requiredPercent = (galHr / pumpCapacityGph) * 100;
      const runtimeHours = galDay / pumpCapacityGph;
      const runtimePercent = (runtimeHours / 24) * 100;
      const balancedSetting = Math.sqrt(requiredPercent / 100) * 100;
      if (pumpType === "continuous") pumpGuidance = '<div class="guidance"><strong>Continuous Pump Setting</strong><div>Set pump to ' + fmt(displayHourlyVol, 3) + ' ' + hourlyUnit + '</div><div>~' + fmt(requiredPercent, 1) + '% of pump capacity.</div></div>';
      if (pumpType === "timer") pumpGuidance = '<div class="guidance"><strong>Timer-Based Pump Setting</strong><div>Run pump ' + fmt(runtimeHours, 2) + ' hrs/day</div><div>~' + fmt(runtimePercent, 1) + '% runtime.</div></div>';
      if (pumpType === "speed") pumpGuidance = '<div class="guidance"><strong>Pump Speed Setting</strong><div>Estimated speed: ' + fmt(requiredPercent, 1) + '%</div><div>Confirm with drawdown/calibration.</div></div>';
      if (pumpType === "speedStroke") pumpGuidance = '<div class="guidance"><strong>Speed + Stroke Starting Point</strong><div>Estimated balanced setting: ' + fmt(balancedSetting, 1) + '% speed and ' + fmt(balancedSetting, 1) + '% stroke</div><div>Starting point only. Confirm actual output.</div></div>';
      if (pumpType === "spm") pumpGuidance = '<div class="guidance"><strong>SPM / Percent Output Setting</strong><div>Estimated output: ' + fmt(requiredPercent, 1) + '% of calibrated pump output</div><div>Confirm with drawdown/calibration.</div></div>';
      if (requiredPercent > 100 || runtimePercent > 100) warning = '<div class="warning">⚠️ Required feed exceeds pump capacity.</div>';
    }

    $("feedResult").innerHTML = densityCaution + '<div class="section-title">Calculated Feed Requirement</div><div class="result-main">' + fmt(displayDailyVol, 2) + ' ' + dailyUnit + '</div><div class="result-sub">' + fmt(displayHourlyVol, 3) + ' ' + hourlyUnit + ' continuous equivalent</div><div class="result-sub">' + fmt(displayMass, 2) + ' ' + massUnit + ' product</div><div class="note">This is the calculated daily product requirement. It does not mean all product should be added at once unless the treatment plan calls for slug feeding.</div>' + pumpGuidance + warning;
  }

  function calcSlug(){
    // === SLUG DOSE CALCULATION ===
    // One-time product addition to reach target dose in system volume
    // Formula: lb = dose(ppm) × gallons / 120,000
    const dose = toNumber($("slugPpm").value);
    const volInput = toNumber($("volume").value);
    const densityInput = toNumber($("slugDensity").value);
    const densityType = $("slugDensityType").value;
    const lbPerGal = densityToLbGal(densityInput, densityType);
    const densityCaution = densityWarning(densityInput, densityType);
    if (!dose || !volInput || !lbPerGal){ $("slugResult").innerHTML = '<div class="warning">Enter target dose, system volume, and density.</div>'; return; }
    const gallons = isMetric ? volInput / GAL_TO_L : volInput;
    const lb = dose * gallons / 120000;
    const galProduct = lb / lbPerGal;
    const displayVol = isMetric ? galProduct * GAL_TO_L : galProduct;
    const displayMass = isMetric ? lb * LB_TO_KG : lb;
    const volUnit = isMetric ? "L" : "gal";
    const massUnit = isMetric ? "kg" : "lb";
    const smallVol = isMetric ? displayVol * 1000 : displayVol * 128;
    const smallUnit = isMetric ? "mL" : "fl oz";
    $("slugResult").innerHTML = densityCaution + '<div class="section-title">Calculated Slug Addition</div><div class="result-main">' + fmt(displayVol, 3) + ' ' + volUnit + '</div><div class="result-sub">' + fmt(smallVol, 1) + ' ' + smallUnit + '</div><div class="result-sub">' + fmt(displayMass, 3) + ' ' + massUnit + ' product</div><div class="note">This is a one-time product addition based on product ppm, system volume, and density.</div>';
  }

  function calcCycles(){
    // === CYCLES OF CONCENTRATION ===
    // Ratio of dissolved solids in tower water vs makeup water: Tower ÷ Makeup
    // Used to determine evaporation rate and bleed requirements in cooling towers
    // Formula: cycles = tower_concentration / makeup_concentration (same basis units required)
    const basis = $("cycleBasis").value;
    const makeup = toNumber($("makeupCycleValue").value);
    const tower = toNumber($("towerCycleValue").value);
    $("makeupCycleLabel").innerText = "Makeup " + basis;
    $("towerCycleLabel").innerText = "Tower " + basis;
    if (!makeup || !tower){ $("cyclesResult").innerHTML = '<div class="warning">Enter makeup and tower values using the same units.</div>'; return; }
    if (tower < makeup){ $("cyclesResult").innerHTML = '<div class="warning">Tower value is lower than makeup value. Confirm samples, units, and basis selection.</div>'; return; }
    const cycles = tower / makeup;
    let warning = "";
    if (cycles < 1.2) warning = '<div class="warning">⚠️ Calculated cycles are very low. Confirm blowdown, makeup source, or sample location.</div>';
    if (cycles > 10) warning = '<div class="warning">⚠️ Calculated cycles are high. Confirm scaling limits, conductivity control, and chemistry program limits.</div>';
    if (basis === "Chloride") warning += '<div class="warning">⚠️ Chloride can be misleading where halogens, chloride-based chemistry, or contamination are present.</div>';
    $("cyclesResult").innerHTML = '<div class="section-title">Calculated Cycles</div><div class="result-main">' + fmt(cycles, 2) + ' cycles</div><div class="result-sub">Basis: ' + basis + '</div><div class="result-sub">Tower ÷ Makeup = ' + fmt(tower, 2) + ' ÷ ' + fmt(makeup, 2) + '</div><div class="note">Cycles are calculated as tower concentration divided by makeup concentration. Use the same units for both values.</div>' + warning;
  }

  function buildCoolingChart(evapGpm, selectedCycles){
    const minCycles = 2, maxCycles = 10, width = 360, height = 220, padL = 56, padR = 12, padT = 14, padB = 34;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const points = [];
    for (let c = minCycles; c <= maxCycles; c += 0.5) points.push({ cycles: c, evap: evapGpm, bleed: evapGpm / (c - 1) });
    const values = [];
    points.forEach(p => { if (chartSeries.evap) values.push(p.evap); if (chartSeries.bleed) values.push(p.bleed); });
    const maxFlow = Math.max.apply(null, values.concat([evapGpm])) * 1.1;
    function x(c){ return padL + ((c - minCycles) / (maxCycles - minCycles)) * plotW; }
    function y(flow){ return padT + plotH - (flow / maxFlow) * plotH; }
    function displayRate(flow){ return isMetric ? flow * GPM_TO_M3HR : flow; }
    function pathFor(key){ return points.map((p, i) => (i === 0 ? "M" : "L") + x(p.cycles).toFixed(1) + "," + y(p[key]).toFixed(1)).join(" "); }
    const selectedX = x(Math.max(minCycles, Math.min(maxCycles, selectedCycles)));
    let lines = "";
    if (chartSeries.evap) lines += '<path d="' + pathFor("evap") + '" fill="none" stroke="#0284c7" stroke-width="3" stroke-dasharray="6 4" />';
    if (chartSeries.bleed) lines += '<path d="' + pathFor("bleed") + '" fill="none" stroke="#dc2626" stroke-width="3" />';
    const rateUnit = isMetric ? "m³/hr" : "gpm";
    return '<div class="chart-wrap"><div class="section-title">Cycles vs Flow Rate</div><div class="chart-controls"><button type="button" id="toggleBleed" class="' + (chartSeries.bleed ? "active" : "") + '">Bleed</button><button type="button" id="toggleEvap" class="' + (chartSeries.evap ? "active" : "") + '">Evap</button></div><svg viewBox="0 0 ' + width + ' ' + height + '" width="100%"><line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#94a3b8" /><line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" stroke="#94a3b8" /><line x1="' + padL + '" y1="' + y(maxFlow / 2) + '" x2="' + (padL + plotW) + '" y2="' + y(maxFlow / 2) + '" stroke="#e2e8f0" /><text x="8" y="' + (padT + 4) + '" font-size="10" fill="#64748b">' + fmtShort(displayRate(maxFlow)) + '</text><text x="8" y="' + (y(maxFlow / 2) + 4) + '" font-size="10" fill="#64748b">' + fmtShort(displayRate(maxFlow / 2)) + '</text><text x="' + padL + '" y="' + (height - 12) + '" font-size="10" fill="#64748b">2</text><text x="' + (x(6) - 4) + '" y="' + (height - 12) + '" font-size="10" fill="#64748b">6</text><text x="' + (padL + plotW - 12) + '" y="' + (height - 12) + '" font-size="10" fill="#64748b">10</text><text x="' + (width / 2 - 30) + '" y="' + (height - 2) + '" font-size="10" fill="#64748b">Cycles</text><text x="14" y="' + (padT + plotH - 10) + '" font-size="10" fill="#64748b" transform="rotate(-90 14 ' + (padT + plotH - 10) + ')">' + rateUnit + '</text>' + lines + '<line x1="' + selectedX + '" y1="' + padT + '" x2="' + selectedX + '" y2="' + (padT + plotH) + '" stroke="#64748b" stroke-dasharray="4 4" /></svg><div class="chart-label">Lines show how bleed changes as cycles increase. Evaporation stays flat because the entered evaporation rate is held constant.</div></div>';
  }

  function attachChartToggleHandlers(){
    [["toggleBleed", "bleed"], ["toggleEvap", "evap"]].forEach(pair => {
      const el = $(pair[0]);
      if (el) el.addEventListener("click", () => { chartSeries[pair[1]] = !chartSeries[pair[1]]; calcCooling(); });
    });
  }

  function syncCoolingBleedToInhib(){
    if (!$('useCoolingBleed').checked || !Number.isFinite(latestCoolingBleedGpm)) return;
    $('bleedRate').value = fmt(isMetric ? latestCoolingBleedGpm * GPM_TO_M3HR : latestCoolingBleedGpm, 3);
  }

  function calcBiocide(){
    // === BIOCIDE DOSE CALCULATION ===
    // One-time biocide addition for microbiological control
    // Same formula as slug: lb = dose(ppm) × gallons / 120,000
    const dose = toNumber($('biocidePpm').value);
    const volInput = toNumber($('biocideVolume').value);
    const densityInput = toNumber($('biocideDensity').value);
    const densityType = $('biocideDensityType').value;
    const lbPerGal = densityToLbGal(densityInput, densityType);
    const densityCaution = densityWarning(densityInput, densityType);
    if (!dose || !volInput || !lbPerGal){ $('biocideResult').innerHTML = '<div class="warning">Enter target dose, system volume, and density.</div>'; return; }
    const gallons = isMetric ? volInput / GAL_TO_L : volInput;
    const lb = dose * gallons / 120000;
    const galProduct = lb / lbPerGal;
    const displayVol = isMetric ? galProduct * GAL_TO_L : galProduct;
    const displayMass = isMetric ? lb * LB_TO_KG : lb;
    const volUnit = isMetric ? 'L' : 'gal';
    const massUnit = isMetric ? 'kg' : 'lb';
    const smallVol = isMetric ? displayVol * 1000 : displayVol * 128;
    const smallUnit = isMetric ? 'mL' : 'fl oz';
    $('biocideResult').innerHTML = densityCaution + '<div class="section-title">Calculated Biocide Addition</div><div class="result-main">' + fmt(displayVol, 3) + ' ' + volUnit + '</div><div class="result-sub">' + fmt(smallVol, 1) + ' ' + smallUnit + '</div><div class="result-sub">' + fmt(displayMass, 3) + ' ' + massUnit + ' product</div><div class="note">One-time product addition based on target dose and known system volume.</div>';
  }

  function calcPumpCal(){
    // === PUMP CALIBRATION ===
    // Determine actual pump output (gph) from field drawdown test
    // Formula: gph = collected_volume(mL) / 1000 / 3.78541 / (collection_time_min / 60)
    // Caches result in latestPumpGph for import to pump capacity field
    const volInput = toNumber($('pumpCalVolume').value);
    const minutes = toNumber($('pumpCalTime').value);
    if (!volInput || !minutes){ $('pumpCalResult').innerHTML = '<div class="warning">Enter collected volume and collection time.</div>'; return; }
    const gph = (volInput / 1000 / GAL_TO_L) / (minutes / 60);
    latestPumpGph = gph;
    const lhr = gph * GAL_TO_L;
    const mainValue = isMetric ? lhr : gph;
    const mainUnit = isMetric ? 'L/hr' : 'gph';
    const altValue = isMetric ? gph : lhr;
    const altUnit = isMetric ? 'gph' : 'L/hr';
    let warning = '';
    if (minutes < 1) warning = '<div class="warning">⚠️ Very short collection time. Use a longer drawdown for better accuracy.</div>';
    if (volInput < 10) warning += '<div class="warning">⚠️ Small collected volume. Measurement error may be significant.</div>';
    $('pumpCalResult').innerHTML = '<div class="section-title">Calculated Pump Output</div><div class="result-main">' + fmt(mainValue, 3) + ' ' + mainUnit + '</div><div class="result-sub">' + fmt(altValue, 3) + ' ' + altUnit + '</div><div class="result-sub">' + fmt(isMetric ? volInput : volInput / 29.5735, 1) + ' ' + (isMetric ? 'mL' : 'fl oz') + ' collected in ' + fmt(minutes, 2) + ' min</div><div class="note">Use this calibrated output as pump capacity in the feed rate tools.</div>' + warning;
  }

  function interpretLSI(lsi){
    if (lsi > 0.5) return "Scaling tendency; calcium carbonate precipitation likely.";
    if (lsi > 0.1) return "Slight scaling tendency.";
    if (lsi >= -0.1) return "Near balanced.";
    if (lsi >= -0.5) return "Slight corrosive / undersaturated tendency.";
  return "Corrosive / undersaturated tendency.";
  }

  function calcSaturationPH(tempInput, tds, calcium, alkalinity){
    const tempC = isMetric ? tempInput : (tempInput - 32) * 5 / 9;

    const A = (Math.log10(tds) - 1) / 10;
    const B = -13.12 * Math.log10(tempC + 273) + 34.55;
    const C = Math.log10(calcium) - 0.4;
    const D = Math.log10(alkalinity);

  return (9.3 + A + B) - (C + D);
  }

  function interpretRSI(rsi){
    if (rsi < 5.5) return "Heavy scaling tendency.";
    if (rsi < 6.2) return "Scaling tendency.";
    if (rsi <= 6.8) return "Near balanced.";
    if (rsi <= 8.5) return "Corrosive / undersaturated tendency.";
    return "Strong corrosive tendency.";
  }

  function overallCondition(lsi){
    if (lsi > 0.5) return "⚠️ High scaling risk; evaluate cycles, calcium, alkalinity, and inhibitor.";
    if (lsi < -0.5) return "⚠️ Corrosion risk; evaluate pH control and inhibitor program.";
    return "✅ Operating in a controllable range.";
  }

  function lsiActionGuidance(lsi){
    if (lsi > 0.5){
        return "Action: Review cycles, calcium hardness, alkalinity, pH control, and inhibitor residual. Consider lowering cycles or tightening scale inhibitor control.";
    }

    if (lsi > 0.1){
        return "Action: Monitor closely. Scaling tendency is present, but may be manageable with proper inhibitor control and stable cycles.";
    }

    if (lsi >= -0.1){
        return "Action: Maintain current control range. System appears near calcium carbonate balance.";
    }

    if (lsi >= -0.5){
        return "Action: Watch for corrosion tendency. Confirm pH, alkalinity, metallurgy, and corrosion inhibitor residual.";
    }

    return "Action: Corrosion tendency is elevated. Review pH/alkalinity control, inhibitor feed, metallurgy, and potential aggressive water conditions.";
   }

  function coolingCyclesGuidance(){
    if (!useCoolingCyclesContext) return "";

    const cyclesInput = toNumber($('cycles').value);
    if (!Number.isFinite(cyclesInput) || cyclesInput <= 1){
        return '<div class="guidance"><strong>Cooling Context</strong><div>Cooling cycles are not currently available or valid.</div></div>';
    }

    let message = "";

    if (cyclesInput > 6){
        message = "Cooling cycles are elevated. If LSI is positive, scaling risk may increase quickly as calcium and alkalinity concentrate.";
    } else if (cyclesInput >= 3){
        message = "Cooling cycles are in a common operating range. Compare LSI against actual inhibitor residual and system limits.";
    } else {
        message = "Cooling cycles are low. Scaling risk from concentration is lower, but corrosion tendency and water cost should still be reviewed.";
    }

    return '<div class="guidance"><strong>Cooling Context</strong><div>Current cycles: ' + fmt(cyclesInput, 2) + '</div><div>' + message + '</div></div>';
}

  function lsiInputInstruction(){
  const mode = $('lsiInputMode') ? $('lsiInputMode').value : 'direct';

  if (mode === 'estimated'){
    const cyclesVal = toNumber($('cycles').value);

    return '<div class="guidance">' +
      '<strong>How to Use (Estimated Mode)</strong>' +
      '<div>Enter MAKEUP water values for TDS, calcium, and alkalinity.</div>' +
      '<div>Cycles will be pulled from Cooling Balance: ' + (Number.isFinite(cyclesVal) ? fmt(cyclesVal, 2) : '—') + '</div>' +
      '<div>System will estimate tower water chemistry automatically.</div>' +
    '</div>';
  }

    return '<div class="guidance">' +
        '<strong>How to Use (Direct Mode)</strong>' +
        '<div>Enter actual tower water test results.</div>' +
        '<div>Do NOT use makeup water values in this mode.</div>' +
    '</div>';
 }

  function updateLSIModeUI(){
  const mode = $('lsiInputMode') ? $('lsiInputMode').value : 'direct';

    if (mode === 'estimated'){
        if ($('lsiTdsLabel')) $('lsiTdsLabel').innerText = 'Makeup TDS (mg/L)';
        if ($('lsiCalciumLabel')) $('lsiCalciumLabel').innerText = 'Makeup Calcium (mg/L as CaCO₃)';
        if ($('lsiAlkLabel')) $('lsiAlkLabel').innerText = 'Makeup Alkalinity (mg/L as CaCO₃)';
    } else {
        if ($('lsiTdsLabel')) $('lsiTdsLabel').innerText = 'TDS (mg/L)';
        if ($('lsiCalciumLabel')) $('lsiCalciumLabel').innerText = 'Calcium Hardness (mg/L as CaCO₃)';
        if ($('lsiAlkLabel')) $('lsiAlkLabel').innerText = 'Total Alkalinity (mg/L as CaCO₃)';
    }
  }

    function interpretPSI(psi){
        if (psi < 4.5) return "Heavy scaling tendency.";
        if (psi < 6.0) return "Scaling tendency.";
        if (psi <= 7.0) return "Near balanced.";
        return "Corrosive / undersaturated tendency.";
    }

    function indexClass(value, type){
    if (!Number.isFinite(value)) return "";

    if (type === "lsi"){
        if (value > 0.5) return "bad";
        if (value < -0.5) return "caution";
        if (value > 0.1 || value < -0.1) return "watch";
        return "good";
    }

    if (type === "rsi" || type === "psi"){
        if (value < 5.5) return "bad";
        if (value < 6.2) return "watch";
        if (value <= 6.8) return "good";
        if (value <= 8.5) return "watch";
        return "caution";
    }

    return "";
    }

    function resultPill(label, value, type){
    return '<div class="index-pill ' + indexClass(value, type) + '">' +
        '<div class="index-label">' + label + '</div>' +
        '<div class="index-value">' + fmt(value, 2) + '</div>' +
    '</div>';
    }

  function calcLSI(){
    const pH = toNumber($('lsiPh').value);
    const tempInput = toNumber($('lsiTemp').value);
    let tds = toNumber($('lsiTds').value);
    let calcium = toNumber($('lsiCalcium').value);
    let alkalinity = toNumber($('lsiAlkalinity').value);

    const inputMode = $('lsiInputMode') ? $('lsiInputMode').value : 'direct';

    if (inputMode === 'estimated'){
    const cyclesVal = toNumber($('cycles').value);

        if (Number.isFinite(cyclesVal) && cyclesVal > 1){
            tds = tds * cyclesVal;
            calcium = calcium * cyclesVal;
            alkalinity = alkalinity * cyclesVal;
        }
    }
    const pHeq = toNumber($('lsiPHeq') ? $('lsiPHeq').value : "");
    

    if (!Number.isFinite(pH) || !Number.isFinite(tempInput) || !Number.isFinite(tds) || !Number.isFinite(calcium) || !Number.isFinite(alkalinity)){
        $('lsiResult').innerHTML = '<div class="warning">Enter pH, temperature, TDS, calcium hardness, and total alkalinity.</div>';
        return;
    }

    const pHs = calcSaturationPH(tempInput, tds, calcium, alkalinity);

    const lsi = pH - pHs;
    const rsi = (2 * pHs) - pH;
    const psi = Number.isFinite(pHeq) ? (2 * pHs) - pHeq : NaN;

    $('lsiResult').innerHTML =
        '<div class="section-title">Calculated Saturation Indexes</div>' +
        lsiInputInstruction() +

        '<div class="result-main">' + fmt(lsi, 2) + ' LSI</div>' +
        '<div class="result-sub">RSI: ' + fmt(rsi, 2) + '</div>' +
        (Number.isFinite(psi) ? '<div class="result-sub">PSI: ' + fmt(psi, 2) + '</div>' : '') +
        '<div class="result-sub">Calculated saturation pH: ' + fmt(pHs, 2) + '</div>' +
        (inputMode === 'estimated'
        ? '<div class="result-sub">Estimated Tower TDS: ' + fmt(tds, 0) + '</div>' +
            '<div class="result-sub">Estimated Tower Calcium: ' + fmt(calcium, 0) + '</div>' +
            '<div class="result-sub">Estimated Tower Alkalinity: ' + fmt(alkalinity, 0) + '</div>'
        : ''
        ) +

        '<div class="result-sub">LSI: ' + interpretLSI(lsi) + '</div>' +
        '<div class="result-sub">RSI: ' + interpretRSI(rsi) + '</div>' +
        (Number.isFinite(psi) ? '<div class="result-sub">PSI: ' + interpretPSI(psi) + '</div>' : '') +

        '<div class="guidance"><strong>System Condition</strong><div>' + overallCondition(lsi) + '</div></div>' +
        '<div class="guidance"><strong>Recommended Field Check</strong><div>' + lsiActionGuidance(lsi) + '</div></div>' +
        coolingCyclesGuidance() +
        '<div class="note">Input mode: ' + (inputMode === 'estimated' ? 'Estimated from Makeup + Cycles' : 'Direct Tower Water Inputs') + '. LSI compares actual pH to saturation pH. RSI and PSI are derived from the same pHs value.</div>';
    }

  function clearLSI(){
        ['lsiPh','lsiTemp','lsiTds','lsiCalcium','lsiAlkalinity','lsiPHeq'].forEach(id => {
            const el = $(id);
            if (el) el.value = '';
        });

        $('lsiResult').innerHTML = '';
   }

  function calcInhib(){
    // === INHIBITOR REQUIREMENT ===
    // Calculates daily inhibitor product needed based on bleed rate
    // Can pull bleed rate from cooling tower calculation or manual entry
    // Formula: lb/day = dose(ppm) × bleed(gpm) × 1440 × 8.34 / 1,000,000
    syncCoolingBleedToInhib();
    const bleedInput = toNumber($('bleedRate').value);
    const dose = toNumber($('inhibPpm').value);
    const densityInput = toNumber($('inhibDensity').value);
    const densityType = $('inhibDensityType').value;
    const lbPerGal = densityToLbGal(densityInput, densityType);
    const densityCaution = densityWarning(densityInput, densityType);
    if (!bleedInput || !dose){ $('inhibResult').innerHTML = '<div class="warning">Enter bleed rate and product dose.</div>'; return; }
    const bleedGpm = isMetric ? bleedInput / GPM_TO_M3HR : bleedInput;
    const lbDay = dose * bleedGpm * 1440 * WATER_LB_PER_GAL / 1000000;
    const galDay = lbPerGal ? lbDay / lbPerGal : NaN;
    $('inhibResult').innerHTML = densityCaution + '<div class="section-title">Inhibitor Requirement</div><div class="result-main">' + fmt(isMetric ? lbDay * LB_TO_KG : lbDay, 2) + ' ' + (isMetric ? 'kg/day' : 'lb/day') + '</div><div class="result-sub">' + (Number.isFinite(galDay) ? fmt(isMetric ? galDay * GAL_TO_L : galDay, 2) + ' ' + (isMetric ? 'L/day' : 'gal/day') : '—') + '</div><div class="note">Calculated from bleed × ppm. Represents product required to offset blowdown losses.</div>';
  }

  function suggestLoadBySeason(){
    const month = new Date().getMonth() + 1;
    let pct = 70, label = 'shoulder season';
    if ([6,7,8].includes(month)) { pct = 90; label = 'summer'; }
    else if ([12,1,2].includes(month)) { pct = 40; label = 'winter'; }
    else if ([3,4,5].includes(month)) { pct = 65; label = 'spring'; }
    else if ([9,10,11].includes(month)) { pct = 60; label = 'fall'; }
    $('loadPercent').value = pct;
    $('loadSuggestNote').innerText = 'Suggested ' + pct + '% for ' + label + '. Adjust if actual load is known.';
    calcCooling();
  }

  function calcCooling(){
    // === COOLING TOWER BALANCE ===
    // Calculates evaporation, bleed (blowdown), and makeup requirements for cooling tower systems
    // Three methods for estimating evaporation: Flow×ΔT, Centrifugal tons, or Absorption tons
    // Key formulas: evap(gpm) varies by method; bleed = evap/(cycles-1); makeup = evap + bleed
    // Cache latest bleed for use by inhibitor feed calculation
    const evapMethod = $('evapMethod').value;
    const cycles = toNumber($('cycles').value);
    $('anyTowerInputs').style.display = evapMethod === 'anyTower' ? 'block' : 'none';
    $('chillerInputs').style.display = evapMethod === 'anyTower' ? 'none' : 'block';
    $('loadPercentField').style.display = evapMethod === 'centrifugal' ? 'block' : 'none';
    if (!cycles){ $('coolingResult').innerHTML = '<div class="warning">Enter cycles of concentration.</div>'; return; }
    if (cycles <= 1){ $('coolingResult').innerHTML = '<div class="warning">Cycles must be greater than 1 to calculate bleed.</div>'; return; }
    let evapGpm = NaN, methodNote = '';
    if (evapMethod === 'anyTower'){
      const recircInput = toNumber($('recircFlow').value);
      const deltaT = toNumber($('deltaT').value);
      if (!recircInput || !deltaT){ $('coolingResult').innerHTML = '<div class="warning">Enter recirculation flow and temperature drop.</div>'; return; }
      evapGpm = (isMetric ? recircInput / GPM_TO_M3HR : recircInput) * deltaT * 0.001;
      methodNote = 'Evaporation estimated using recirculation flow × ΔT × 0.001.';
    }
    if (evapMethod === 'centrifugal'){
      const tons = toNumber($('chillerTons').value);
      const loadPct = toNumber($('loadPercent').value) || 100;
      if (!tons){ $('coolingResult').innerHTML = '<div class="warning">Enter chiller load in tons.</div>'; return; }
      const effectiveTons = tons * (loadPct / 100);
      evapGpm = effectiveTons * 0.03;
      methodNote = 'Evaporation estimated using ' + fmt(effectiveTons, 1) + ' effective tons (load-adjusted) × 0.03 gpm/ton.';
    }
    if (evapMethod === 'absorption'){
      const tons = toNumber($('chillerTons').value);
      if (!tons){ $('coolingResult').innerHTML = '<div class="warning">Enter chiller load in tons.</div>'; return; }
      evapGpm = tons * 0.04;
      methodNote = 'Evaporation estimated for towers serving absorption chillers using tons × 0.04 gpm/ton.';
    }
    const bleedGpm = evapGpm / (cycles - 1);
    latestCoolingBleedGpm = bleedGpm;
    syncCoolingBleedToInhib();
    const makeupGpm = evapGpm + bleedGpm;
    const displayEvap = isMetric ? evapGpm * GPM_TO_M3HR : evapGpm;
    const displayBleed = isMetric ? bleedGpm * GPM_TO_M3HR : bleedGpm;
    const displayMakeup = isMetric ? makeupGpm * GPM_TO_M3HR : makeupGpm;
    const rateUnit = isMetric ? 'm³/hr' : 'gpm';
    const bleedDaily = isMetric ? bleedGpm * 1440 * GAL_TO_L / 1000 : bleedGpm * 1440;
    const makeupDaily = isMetric ? makeupGpm * 1440 * GAL_TO_L / 1000 : makeupGpm * 1440;
    const dailyUnit = isMetric ? 'm³/day' : 'gal/day';
    $('coolingResult').innerHTML = '<div class="section-title">Calculated Cooling Balance</div><div class="result-main">' + fmt(displayBleed, 2) + ' ' + rateUnit + ' bleed</div><div class="result-sub">' + fmt(displayEvap, 2) + ' ' + rateUnit + ' evaporation</div><div class="result-sub">' + fmt(displayMakeup, 2) + ' ' + rateUnit + ' makeup</div><div class="result-sub">' + fmtComma(bleedDaily) + ' ' + dailyUnit + ' bleed</div><div class="result-sub">' + fmtComma(makeupDaily) + ' ' + dailyUnit + ' makeup</div><div class="note">' + methodNote + ' Assumes steady-state (makeup = evap + bleed).</div>' + buildCoolingChart(evapGpm, cycles);
    attachChartToggleHandlers();
  }

  function setUnits(metric){
    // === UNIT SYSTEM TOGGLE ===
    // Convert all fields and labels between imperial (false) and metric (true)
    // Updates isMetric flag, toggles button states, relabels all inputs, converts existing values,
    // and recalculates all results to match new unit system
    const previousMetric = isMetric;
    convertUnitFields(previousMetric, metric);

    isMetric = metric;
    $('btnImp').classList.toggle('active', !metric);
    $('btnMet').classList.toggle('active', metric);
    $('feedDoseLabel').innerText = metric ? 'Target Product Dose (mg/L)' : 'Target Product Dose (ppm)';
    $('slugDoseLabel').innerText = metric ? 'Target Product Dose (mg/L)' : 'Target Product Dose (ppm)';
    $('inhibDoseLabel').innerText = metric ? 'Target Product Dose (mg/L)' : 'Target Product Dose (ppm)';
    $('biocideDoseLabel').innerText = metric ? 'Target Product Dose (mg/L)' : 'Target Product Dose (ppm)';
    $('flowLabel').innerText = metric ? 'System Flow (m³/hr)' : 'System Flow (gpm)';
    $('volLabel').innerText = metric ? 'System Volume (L)' : 'System Volume (gal)';
    $('biocideVolumeLabel').innerText = metric ? 'System Volume (L)' : 'System Volume (gal)';
    $('bleedLabel').innerText = metric ? 'Bleed Rate (m³/hr)' : 'Bleed Rate (gpm)';
    $('pumpCapacityLabel').innerText = metric ? 'Pump Capacity (L/hr)' : 'Pump Capacity (gph)';
    $('recircLabel').innerText = metric ? 'Tower Recirculation Flow (m³/hr)' : 'Tower Recirculation Flow (gpm)';
    if ($('lsiTempLabel')) $('lsiTempLabel').innerText = metric ? 'Temperature (°C)' : 'Temperature (°F)';
    calcFeed(); calcSlug(); calcCooling(); calcCycles(); calcInhib(); calcBiocide(); calcPumpCal(); calcLSI();
  }

  function showSection(section){
    sections.forEach(item => {
      const sectionEl = $(item.sectionId);
      const buttonEl = $(item.buttonId);
      if (sectionEl) sectionEl.style.display = section === item.key ? 'block' : 'none';
      if (buttonEl) buttonEl.classList.toggle('active', section === item.key);
    });
  }

   function runSelfTests(){
    const nearly = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;
    console.assert(nearly(densityToLbGal(1.11, 'sg'), 9.2574, 0.01), 'SG density conversion failed');
    console.assert(nearly(densityToLbGal(9.26, 'lbgal'), 9.26, 0.01), 'lb/gal density conversion failed');
    console.assert(densityWarning(1.6, 'sg').includes('above 1.5'), 'High SG warning failed');
    console.assert(densityWarning(0.9, 'sg').includes('below 1.0'), 'Low SG warning failed');
    console.assert(densityWarning(7.9, 'lbgal').includes('below 8.0'), 'Low lb/gal warning failed');
    console.assert(densityWarning(12.6, 'lbgal').includes('above 12.5'), 'High lb/gal warning failed');
    console.assert(nearly((100 * 100 * 1440 * 8.34 / 1000000), 120.096, 0.01), 'Feed lb/day sanity test failed');
    console.assert(nearly((100 * 1000 / 120000), 0.8333, 0.01), 'Slug/biocide lb sanity test failed');
  }

function initScrollReveal() {
  const revealSections = document.querySelectorAll('.reveal-section');

  if (!revealSections.length) return;

  const observer = new IntersectionObserver((entries) => {
    let delay = 0;

    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        setTimeout(() => {
          entry.target.classList.add('visible');
        }, delay);

        delay += 80;
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.05
  });

  revealSections.forEach((section) => observer.observe(section));
}

  function bind(){
    // === EVENT BINDING ===
    // Central setup for all event listeners. Pattern:
    // - UoM buttons (Imperial/Metric) trigger setUnits() with conversion
    // - Navigation buttons trigger showSection() with tab switching
    // - Input fields trigger both 'input' (live) and 'change' (committed) events
    // - Each input group attached to corresponding calc function (e.g., calcFeed)
    // NOTE: To add new calculations, add event listeners here and implement calc function
    $('btnImp').addEventListener('click', () => setUnits(false));
    $('btnMet').addEventListener('click', () => setUnits(true));

    sections.forEach(item => {
      const buttonEl = $(item.buttonId);
      if (buttonEl) buttonEl.addEventListener('click', () => showSection(item.key));
    });

    ['dose','flow','density','densityType','pumpCapacity','pumpType'].forEach(id => $(id).addEventListener('input', () => { updateDensityLabels(); calcFeed(); }));
    ['dose','flow','density','densityType','pumpCapacity','pumpType'].forEach(id => $(id).addEventListener('change', () => { updateDensityLabels(); calcFeed(); }));

    ['slugPpm','volume','slugDensity','slugDensityType'].forEach(id => $(id).addEventListener('input', () => { updateDensityLabels(); calcSlug(); }));
    ['slugPpm','volume','slugDensity','slugDensityType'].forEach(id => $(id).addEventListener('change', () => { updateDensityLabels(); calcSlug(); }));

    // $('slugDensityType').addEventListener('change', () => {
    //     slugDensityTypePrevious = convertDensityField('slugDensity', 'slugDensityType', slugDensityTypePrevious);
    //     updateDensityLabels(); 
    //     calcSlug();
    // });

    ['cycleBasis','makeupCycleValue','towerCycleValue'].forEach(id => $(id).addEventListener('input', calcCycles));
    ['cycleBasis','makeupCycleValue','towerCycleValue'].forEach(id => $(id).addEventListener('change', calcCycles));

    ['evapMethod','recircFlow','deltaT','chillerTons','loadPercent','cycles'].forEach(id => $(id).addEventListener('input', calcCooling));
    ['evapMethod','recircFlow','deltaT','chillerTons','loadPercent','cycles'].forEach(id => $(id).addEventListener('change', calcCooling));

    ['bleedRate','inhibPpm','inhibDensity','inhibDensityType'].forEach(id => $(id).addEventListener('input', () => { updateDensityLabels(); calcInhib(); }));
    ['bleedRate','inhibPpm','inhibDensity','inhibDensityType'].forEach(id => $(id).addEventListener('change', () => { updateDensityLabels(); calcInhib(); }));

    ['biocidePpm','biocideVolume','biocideDensity','biocideDensityType'].forEach(id => $(id).addEventListener('input', () => { updateDensityLabels(); calcBiocide(); }));
    ['biocidePpm','biocideVolume','biocideDensity','biocideDensityType'].forEach(id => $(id).addEventListener('change', () => { updateDensityLabels(); calcBiocide(); }));

    ['pumpCalVolume','pumpCalTime'].forEach(id => $(id).addEventListener('input', calcPumpCal));
    ['pumpCalVolume','pumpCalTime'].forEach(id => $(id).addEventListener('change', calcPumpCal));

    ['lsiInputMode','lsiPh','lsiTemp','lsiTds','lsiCalcium','lsiAlkalinity','lsiPHeq'].forEach(id => $(id).addEventListener('input', calcLSI));
    ['lsiInputMode','lsiPh','lsiTemp','lsiTds','lsiCalcium','lsiAlkalinity','lsiPHeq'].forEach(id => $(id).addEventListener('change', calcLSI));
    if ($('lsiInputMode')){
        $('lsiInputMode').addEventListener('change', () => {
            updateLSIModeUI();
        });
    }
    if ($('clearLsiBtn')) $('clearLsiBtn').addEventListener('click', clearLSI);

    if ($('useCoolingCyclesBtn')) {
        $('useCoolingCyclesBtn').addEventListener('click', () => {
            useCoolingCyclesContext = true;

            if ($('lsiInputMode')) {
            $('lsiInputMode').value = 'estimated';
            }

            updateLSIModeUI();
            calcLSI();
        });
    }

    $('useCoolingBleed').addEventListener('change', () => { syncCoolingBleedToInhib(); calcInhib(); });
    $('suggestLoadBtn').addEventListener('click', suggestLoadBySeason);

    $('usePumpCalBtn').addEventListener('click', () => {
      if (!Number.isFinite(latestPumpGph)) return;
      $('pumpCapacity').value = fmt(isMetric ? latestPumpGph * GAL_TO_L : latestPumpGph, 3);
      showSection('feed');
      calcFeed();
    });
  }

  // === INITIALIZATION SEQUENCE ===
  // Startup order: bind listeners → run tests → configure UI → set imperial mode → show feed tab
  bind();
  runSelfTests();
  updateDensityLabels();
  updateLSIModeUI();
  setUnits(false);           // Initialize with imperial units; false = imperial, true = metric
  showSection('feed');       // Display feed rate calculator on app load
  initScrollReveal();       // Set up scroll reveal for content sections
})();