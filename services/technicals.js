const yahooFinance = require('yahoo-finance2').default;
const {
  RSI, MACD, BollingerBands, EMA, SMA, ATR,
} = require('technicalindicators');
const { withRetry } = require('../utils/retry');

yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

/**
 * Obtiene velas históricas de Yahoo Finance y calcula indicadores técnicos.
 * @param {string} symbol
 * @param {number} days - días de historia (default: 60 — suficiente para todos los indicadores)
 */
async function fetchTechnicals(symbol, days = 60) {
  return withRetry(async () => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const chart = await yahooFinance.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    const quotes = chart?.quotes ?? [];
    if (quotes.length < 20) {
      throw new Error(`Not enough data for ${symbol}: ${quotes.length} candles`);
    }

    // Extraer arrays OHLCV
    const closes = quotes.map(q => q.close).filter(Boolean);
    const highs  = quotes.map(q => q.high).filter(Boolean);
    const lows   = quotes.map(q => q.low).filter(Boolean);
    const opens  = quotes.map(q => q.open).filter(Boolean);
    const vols   = quotes.map(q => q.volume).filter(Boolean);

    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];

    // ─── RSI (14) ─────────────────────────────────────────────────────────────
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiValues[rsiValues.length - 1];
    const rsiPrev = rsiValues[rsiValues.length - 2];

    // ─── MACD (12, 26, 9) ────────────────────────────────────────────────────
    const macdValues = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const macd = macdValues[macdValues.length - 1];
    const macdPrev = macdValues[macdValues.length - 2];

    // ─── Bollinger Bands (20, 2) ──────────────────────────────────────────────
    const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const bb = bbValues[bbValues.length - 1];

    // ─── EMAs ────────────────────────────────────────────────────────────────
    const ema9  = lastOf(EMA.calculate({ values: closes, period: 9 }));
    const ema21 = lastOf(EMA.calculate({ values: closes, period: 21 }));
    const ema50 = lastOf(EMA.calculate({ values: closes, period: 50 }));
    const sma200 = closes.length >= 200
      ? lastOf(SMA.calculate({ values: closes, period: 200 }))
      : null;

    // ─── ATR (14) — volatilidad real ─────────────────────────────────────────
    const atrValues = ATR.calculate({
      high: highs, low: lows, close: closes, period: 14,
    });
    const atr = lastOf(atrValues);

    // ─── VWAP estimado (sesión actual — últimas 5 velas) ─────────────────────
    const vwap = estimateVWAP(quotes.slice(-5));

    // ─── Interpretaciones ────────────────────────────────────────────────────
    const interpretation = interpretIndicators({ rsi, macd, macdPrev, bb, last, ema9, ema21, ema50, sma200, vwap });

    return {
      symbol,
      currentPrice: last,
      prevClose: prev,
      // RSI
      rsi: round(rsi),
      rsiPrev: round(rsiPrev),
      rsiSignal: interpretRSI(rsi),
      // MACD
      macdLine: round(macd?.MACD),
      macdSignal: round(macd?.signal),
      macdHistogram: round(macd?.histogram),
      macdHistPrev: round(macdPrev?.histogram),
      macdCrossover: detectMACDCrossover(macd, macdPrev),
      // Bollinger Bands
      bbUpper: round(bb?.upper),
      bbMiddle: round(bb?.middle),
      bbLower: round(bb?.lower),
      bbWidth: bb ? round(((bb.upper - bb.lower) / bb.middle) * 100) : null,
      bbPosition: bb ? interpretBBPosition(last, bb) : 'N/A',
      // EMAs
      ema9: round(ema9),
      ema21: round(ema21),
      ema50: round(ema50),
      sma200: round(sma200),
      aboveSma200: sma200 ? last > sma200 : null,
      trendAlignment: interpretTrend(last, ema9, ema21, ema50, sma200),
      // ATR y VWAP
      atr: round(atr),
      atrPct: atr && last ? round((atr / last) * 100) : null,
      vwap: round(vwap),
      aboveVwap: vwap ? last > vwap : null,
      // Resumen
      overallSignal: interpretation.signal,
      overallReason: interpretation.reason,
      bullishFactors: interpretation.bullish,
      bearishFactors: interpretation.bearish,
    };
  }, { label: `technicals:${symbol}`, retries: 2, baseMs: 1000 });
}

/**
 * Calcula indicadores para una lista de tickers en paralelo (con límite de concurrencia)
 * @param {string[]} symbols
 * @param {number} concurrency
 */
async function fetchTechnicalsForSymbols(symbols, concurrency = 5) {
  const results = {};
  const batches = chunk(symbols, concurrency);

  for (const batch of batches) {
    const settled = await Promise.allSettled(
      batch.map(sym => fetchTechnicals(sym))
    );
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        results[batch[i]] = result.value;
      } else {
        console.warn(`[Technicals] ${batch[i]} failed:`, result.reason?.message);
        results[batch[i]] = null;
      }
    });
  }

  return results;
}

// ─── Helpers de interpretación ─────────────────────────────────────────────────

function interpretRSI(rsi) {
  if (!rsi) return 'N/A';
  if (rsi >= 80) return 'SOBRECOMPRA EXTREMA';
  if (rsi >= 70) return 'SOBRECOMPRA';
  if (rsi >= 60) return 'FUERTE — tendencia alcista';
  if (rsi >= 50) return 'NEUTRAL-ALCISTA';
  if (rsi >= 40) return 'NEUTRAL-BAJISTA';
  if (rsi >= 30) return 'SOBREVENDIDO';
  return 'SOBREVENTA EXTREMA';
}

function interpretBBPosition(price, bb) {
  if (!bb || !price) return 'N/A';
  if (price >= bb.upper) return 'SOBRE BANDA SUPERIOR — sobreextendido';
  if (price <= bb.lower) return 'BAJO BANDA INFERIOR — posible rebote';
  const mid = (price - bb.lower) / (bb.upper - bb.lower);
  if (mid > 0.7) return 'TERCIO SUPERIOR';
  if (mid > 0.3) return 'ZONA MEDIA';
  return 'TERCIO INFERIOR';
}

function detectMACDCrossover(current, prev) {
  if (!current || !prev) return 'SIN DATOS';
  const currAbove = current.MACD > current.signal;
  const prevAbove = prev.MACD > prev.signal;
  if (currAbove && !prevAbove) return 'CRUCE ALCISTA RECIENTE ⚡';
  if (!currAbove && prevAbove) return 'CRUCE BAJISTA RECIENTE ⚠';
  if (currAbove) return 'ALCISTA (sin cruce reciente)';
  return 'BAJISTA (sin cruce reciente)';
}

function interpretTrend(price, ema9, ema21, ema50, sma200) {
  if (!price || !ema9 || !ema21 || !ema50) return 'DATOS INSUFICIENTES';
  const shortTrend = ema9 > ema21;
  const medTrend   = ema21 > ema50;
  const longTrend  = sma200 ? price > sma200 : null;

  if (shortTrend && medTrend && (longTrend !== false)) return 'ALCISTA CONFIRMADO (EMAs alineadas)';
  if (!shortTrend && !medTrend && (longTrend !== true)) return 'BAJISTA CONFIRMADO (EMAs alineadas)';
  if (shortTrend && !medTrend) return 'RECUPERACIÓN — EMA corta sobre media pero aún bajo EMA50';
  if (!shortTrend && medTrend) return 'DEBILITAMIENTO — pullback en tendencia alcista';
  return 'MIXTO';
}

function interpretIndicators({ rsi, macd, macdPrev, bb, last, ema9, ema21, ema50, sma200, vwap }) {
  const bullish = [];
  const bearish = [];

  // RSI
  if (rsi <= 35) bullish.push(`RSI sobrevendido (${round(rsi)}) — posible rebote`);
  if (rsi >= 65) bearish.push(`RSI sobrecomprado (${round(rsi)}) — posible techo`);
  if (rsi >= 50 && rsi < 65) bullish.push(`RSI en zona positiva (${round(rsi)})`);

  // MACD crossover
  if (macd && macdPrev) {
    if (macd.MACD > macd.signal && macdPrev.MACD <= macdPrev.signal)
      bullish.push('Cruce alcista de MACD ⚡');
    if (macd.MACD < macd.signal && macdPrev.MACD >= macdPrev.signal)
      bearish.push('Cruce bajista de MACD ⚠');
    if (macd.histogram > 0 && macd.histogram > macdPrev.histogram)
      bullish.push('Histograma MACD expandiéndose al alza');
    if (macd.histogram < 0 && macd.histogram < macdPrev.histogram)
      bearish.push('Histograma MACD expandiéndose a la baja');
  }

  // Bollinger Bands
  if (bb) {
    if (last <= bb.lower) bullish.push('Precio en banda inferior BB — rebote probable');
    if (last >= bb.upper) bearish.push('Precio en banda superior BB — extensión máxima');
  }

  // EMAs
  if (ema9 && ema21 && ema50) {
    if (last > ema9 && ema9 > ema21 && ema21 > ema50) bullish.push('EMAs perfectamente alineadas al alza');
    if (last < ema9 && ema9 < ema21 && ema21 < ema50) bearish.push('EMAs perfectamente alineadas a la baja');
    if (last > ema50) bullish.push(`Precio sobre EMA50 ($${round(ema50)})`);
    else bearish.push(`Precio bajo EMA50 ($${round(ema50)})`);
  }
  if (sma200) {
    if (last > sma200) bullish.push(`Sobre SMA200 ($${round(sma200)}) — tendencia larga alcista`);
    else bearish.push(`Bajo SMA200 ($${round(sma200)}) — tendencia larga bajista`);
  }

  // VWAP
  if (vwap) {
    if (last > vwap) bullish.push(`Sobre VWAP ($${round(vwap)})`);
    else bearish.push(`Bajo VWAP ($${round(vwap)})`);
  }

  const score = bullish.length - bearish.length;
  let signal;
  if (score >= 3) signal = 'ALCISTA FUERTE';
  else if (score >= 1) signal = 'ALCISTA';
  else if (score === 0) signal = 'NEUTRAL';
  else if (score >= -2) signal = 'BAJISTA';
  else signal = 'BAJISTA FUERTE';

  const reason = bullish.length > bearish.length
    ? `Predominan ${bullish.length} factores alcistas vs ${bearish.length} bajistas`
    : bearish.length > bullish.length
    ? `Predominan ${bearish.length} factores bajistas vs ${bullish.length} alcistas`
    : 'Señales mixtas — sin sesgo claro';

  return { signal, reason, bullish, bearish };
}

function estimateVWAP(recentQuotes) {
  if (!recentQuotes?.length) return null;
  let sumPV = 0, sumV = 0;
  for (const q of recentQuotes) {
    if (!q.high || !q.low || !q.close || !q.volume) continue;
    const typical = (q.high + q.low + q.close) / 3;
    sumPV += typical * q.volume;
    sumV += q.volume;
  }
  return sumV > 0 ? sumPV / sumV : null;
}

const lastOf = arr => arr?.[arr.length - 1] ?? null;
const round = (v, d = 2) => v != null ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : null;
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

module.exports = { fetchTechnicals, fetchTechnicalsForSymbols };
