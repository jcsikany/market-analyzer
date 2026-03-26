const axios = require('axios');

const BASE_URL = 'https://www.alphavantage.co/query';
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// Tracking de calls diarios (25/día free tier)
let dailyCalls = 0;
let lastResetDate = new Date().toDateString();
const DAILY_LIMIT = 24; // dejamos 1 de margen

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyCalls = 0;
    lastResetDate = today;
  }
}

function canMakeCall() {
  resetDailyIfNeeded();
  return dailyCalls < DAILY_LIMIT;
}

/**
 * Obtiene datos técnicos adicionales de Alpha Vantage para cross-validación.
 * Solo se usa para los top 3 candidatos para no exceder el límite diario.
 */
async function fetchAdditionalTechnicals(symbols) {
  if (!API_KEY) {
    console.log('[AlphaVantage] No API key configured, skipping');
    return {};
  }

  const toProcess = symbols.slice(0, 3); // Max 3 para no gastar calls
  console.log(`[AlphaVantage] Fetching additional technicals for: ${toProcess.join(', ')} (${dailyCalls}/${DAILY_LIMIT} calls used today)`);

  const results = {};

  for (const symbol of toProcess) {
    if (!canMakeCall()) {
      console.warn(`[AlphaVantage] Daily limit reached (${DAILY_LIMIT}), skipping ${symbol}`);
      break;
    }

    try {
      // Fetch RSI for cross-validation
      const rsiData = await fetchIndicator(symbol, 'RSI', {
        interval: 'daily',
        time_period: 14,
        series_type: 'close',
      });

      // Fetch SMA200 for cross-validation
      const sma200Data = await fetchIndicator(symbol, 'SMA', {
        interval: 'daily',
        time_period: 200,
        series_type: 'close',
      });

      // Fetch global quote for latest price confirmation
      const quoteData = await fetchGlobalQuote(symbol);

      results[symbol] = {
        rsi: rsiData,
        sma200: sma200Data,
        quote: quoteData,
        crossValidation: buildCrossValidation(rsiData, sma200Data, quoteData),
      };

      console.log(`[AlphaVantage] ${symbol}: RSI=${rsiData?.value ?? 'N/A'}, SMA200=$${sma200Data?.value ?? 'N/A'}`);
    } catch (err) {
      console.warn(`[AlphaVantage] Error for ${symbol}:`, err.message);
      results[symbol] = { error: err.message };
    }
  }

  return results;
}

async function fetchIndicator(symbol, fn, params) {
  if (!canMakeCall()) return null;
  dailyCalls++;

  try {
    const { data } = await axios.get(BASE_URL, {
      params: { function: fn, symbol, apikey: API_KEY, ...params },
      timeout: 10000,
    });

    // Alpha Vantage returns data in different key formats
    const analysisKey = Object.keys(data).find(k => k.startsWith('Technical Analysis'));
    if (!analysisKey) return null;

    const entries = Object.entries(data[analysisKey]);
    if (entries.length === 0) return null;

    const [date, values] = entries[0];
    const value = parseFloat(Object.values(values)[0]);

    return { value, date, raw: values };
  } catch (err) {
    console.warn(`[AlphaVantage] ${fn} error for ${symbol}:`, err.message);
    return null;
  }
}

async function fetchGlobalQuote(symbol) {
  if (!canMakeCall()) return null;
  dailyCalls++;

  try {
    const { data } = await axios.get(BASE_URL, {
      params: { function: 'GLOBAL_QUOTE', symbol, apikey: API_KEY },
      timeout: 10000,
    });

    const quote = data['Global Quote'];
    if (!quote) return null;

    return {
      price: parseFloat(quote['05. price']),
      change: parseFloat(quote['09. change']),
      changePct: parseFloat(quote['10. change percent']?.replace('%', '')),
      volume: parseInt(quote['06. volume']),
      previousClose: parseFloat(quote['08. previous close']),
    };
  } catch (err) {
    return null;
  }
}

function buildCrossValidation(rsi, sma200, quote) {
  const issues = [];
  const confirmations = [];

  if (rsi?.value != null) {
    if (rsi.value > 70) issues.push(`RSI sobrecomprado (${rsi.value.toFixed(1)})`);
    else if (rsi.value < 30) confirmations.push(`RSI sobrevendido (${rsi.value.toFixed(1)}) — posible rebote`);
    else confirmations.push(`RSI neutral (${rsi.value.toFixed(1)})`);
  }

  if (sma200?.value != null && quote?.price != null) {
    if (quote.price > sma200.value) {
      confirmations.push(`Precio sobre SMA200 ($${sma200.value.toFixed(2)}) — tendencia alcista`);
    } else {
      issues.push(`Precio bajo SMA200 ($${sma200.value.toFixed(2)}) — tendencia bajista`);
    }
  }

  return { issues, confirmations };
}

module.exports = { fetchAdditionalTechnicals };
