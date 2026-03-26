const axios = require('axios');

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const API_KEY = process.env.FRED_API_KEY;

// Cache de 6 horas (datos macro cambian lento)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000;

const SERIES = {
  DGS10: 'Treasury 10Y Yield',
  T10Y2Y: 'Yield Curve (10Y-2Y Spread)',
  BAMLH0A0HYM2: 'High Yield Credit Spread',
  UNRATE: 'Unemployment Rate',
};

/**
 * Obtiene datos macroeconómicos de la Federal Reserve.
 * Retorna señal macro: FAVORABLE / CAUTIOUS / RISK_OFF
 */
async function fetchMacroData() {
  if (!API_KEY) {
    console.log('[FRED] No API key configured, skipping macro data');
    return null;
  }

  // Verificar cache
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL) {
    console.log('[FRED] Returning cached macro data');
    return cache.data;
  }

  console.log('[FRED] Fetching macro economic data...');

  const results = {};
  const thirtyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (const [seriesId, label] of Object.entries(SERIES)) {
    try {
      const { data } = await axios.get(FRED_BASE, {
        params: {
          series_id: seriesId,
          api_key: API_KEY,
          file_type: 'json',
          sort_order: 'desc',
          limit: 5,
          observation_start: thirtyDaysAgo,
        },
        timeout: 10000,
      });

      const observations = (data.observations || []).filter(o => o.value !== '.');
      if (observations.length > 0) {
        const latest = parseFloat(observations[0].value);
        const previous = observations.length > 1 ? parseFloat(observations[1].value) : null;
        const change = previous != null ? latest - previous : null;

        results[seriesId] = {
          label,
          value: latest,
          date: observations[0].date,
          previousValue: previous,
          change: change != null ? parseFloat(change.toFixed(4)) : null,
          trend: change > 0 ? 'SUBIENDO' : change < 0 ? 'BAJANDO' : 'ESTABLE',
        };
      }
    } catch (err) {
      console.warn(`[FRED] Error fetching ${seriesId}:`, err.message);
    }
  }

  // Interpretar señal macro
  const macroSignal = interpretMacro(results);

  const macroData = {
    ...results,
    macroSignal,
    summary: buildMacroSummary(results, macroSignal),
    fetchedAt: new Date().toISOString(),
  };

  cache = { data: macroData, timestamp: Date.now() };
  console.log(`[FRED] Macro signal: ${macroSignal.signal}`);

  return macroData;
}

function interpretMacro(data) {
  let bullPoints = 0;
  let bearPoints = 0;
  const reasons = [];

  // Yield curve
  const yieldCurve = data.T10Y2Y;
  if (yieldCurve) {
    if (yieldCurve.value < 0) {
      bearPoints += 2;
      reasons.push(`Yield curve invertida (${yieldCurve.value.toFixed(2)}%) — señal de recesión`);
    } else if (yieldCurve.value < 0.5) {
      bearPoints += 1;
      reasons.push(`Yield curve aplanada (${yieldCurve.value.toFixed(2)}%) — cautela`);
    } else {
      bullPoints += 1;
      reasons.push(`Yield curve normal (${yieldCurve.value.toFixed(2)}%)`);
    }
  }

  // Credit spreads
  const creditSpread = data.BAMLH0A0HYM2;
  if (creditSpread) {
    if (creditSpread.value > 5) {
      bearPoints += 2;
      reasons.push(`Credit spreads muy amplios (${creditSpread.value.toFixed(2)}%) — estrés crediticio`);
    } else if (creditSpread.value > 4) {
      bearPoints += 1;
      reasons.push(`Credit spreads elevados (${creditSpread.value.toFixed(2)}%)`);
    } else {
      bullPoints += 1;
      reasons.push(`Credit spreads normales (${creditSpread.value.toFixed(2)}%)`);
    }
  }

  // Treasury 10Y level and direction
  const treasury = data.DGS10;
  if (treasury) {
    if (treasury.value > 5) {
      bearPoints += 1;
      reasons.push(`Treasury 10Y alto (${treasury.value.toFixed(2)}%) — presión sobre acciones`);
    } else if (treasury.trend === 'BAJANDO') {
      bullPoints += 1;
      reasons.push(`Treasury 10Y bajando (${treasury.value.toFixed(2)}%) — favorable para acciones`);
    }
  }

  // Unemployment
  const unemployment = data.UNRATE;
  if (unemployment) {
    if (unemployment.value > 5) {
      bearPoints += 1;
      reasons.push(`Desempleo alto (${unemployment.value}%)`);
    } else if (unemployment.trend === 'SUBIENDO') {
      bearPoints += 1;
      reasons.push(`Desempleo subiendo (${unemployment.value}%)`);
    } else {
      bullPoints += 1;
      reasons.push(`Desempleo bajo/estable (${unemployment.value}%)`);
    }
  }

  let signal;
  if (bearPoints >= 4) signal = 'RISK_OFF';
  else if (bearPoints >= 2 && bearPoints > bullPoints) signal = 'CAUTIOUS';
  else if (bullPoints > bearPoints) signal = 'FAVORABLE';
  else signal = 'NEUTRAL';

  return { signal, bullPoints, bearPoints, reasons };
}

function buildMacroSummary(data, signal) {
  const parts = [];
  if (data.DGS10) parts.push(`10Y: ${data.DGS10.value.toFixed(2)}%`);
  if (data.T10Y2Y) parts.push(`Curva: ${data.T10Y2Y.value.toFixed(2)}%`);
  if (data.BAMLH0A0HYM2) parts.push(`HY Spread: ${data.BAMLH0A0HYM2.value.toFixed(2)}%`);
  if (data.UNRATE) parts.push(`Desempleo: ${data.UNRATE.value}%`);
  return `Macro ${signal.signal}: ${parts.join(' | ')}`;
}

module.exports = { fetchMacroData };
