const { default: YahooFinance } = require('yahoo-finance2');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const { RSI, MACD, BollingerBands, EMA, SMA, ATR } = require('technicalindicators');
const { withRetry } = require('../utils/retry');

async function fetchTechnicals(symbol, days = 60) {
  return withRetry(async () => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const chart = await yahooFinance.chart(symbol, { period1: startDate, period2: endDate, interval: '1d' });
    const quotes = chart?.quotes ?? [];
    if (quotes.length < 20) throw new Error(`Not enough data for ${symbol}: ${quotes.length} candles`);

    const closes = quotes.map(q => q.close).filter(Boolean);
    const highs  = quotes.map(q => q.high).filter(Boolean);
    const lows   = quotes.map(q => q.low).filter(Boolean);
    const vols   = quotes.map(q => q.volume).filter(Boolean);

    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];

    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiValues[rsiValues.length - 1];
    const rsiPrev = rsiValues[rsiValues.length - 2];

    const macdValues = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    const macd = macdValues[macdValues.length - 1];
    const macdPrev = macdValues[macdValues.length - 2];

    const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const bb = bbValues[bbValues.length - 1];

    const ema9  = lastOf(EMA.calculate({ values: closes, period: 9 }));
    const ema21 = lastOf(EMA.calculate({ values: closes, period: 21 }));
    const ema50 = lastOf(EMA.calculate({ values: closes, period: 50 }));
    const sma200 = closes.length >= 200 ? lastOf(SMA.calculate({ values: closes, period: 200 })) : null;

    const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr = lastOf(atrValues);
    const vwap = estimateVWAP(quotes.slice(-5));
    const interpretation = interpretIndicators({ rsi, macd, macdPrev, bb, last, ema9, ema21, ema50, sma200, vwap });

    return {
      symbol, currentPrice: last, prevClose: prev,
      rsi: round(rsi), rsiPrev: round(rsiPrev), rsiSignal: interpretRSI(rsi),
      macdLine: round(macd?.MACD), macdSignal: round(macd?.signal), macdHistogram: round(macd?.histogram),
      macdHistPrev: round(macdPrev?.histogram), macdCrossover: detectMACDCrossover(macd, macdPrev),
      bbUpper: round(bb?.upper), bbMiddle: round(bb?.middle), bbLower: round(bb?.lower),
      bbWidth: bb ? round(((bb.upper - bb.lower) / bb.middle) * 100) : null,
      bbPosition: bb ? interpretBBPosition(last, bb) : 'N/A',
      ema9: round(ema9), ema21: round(ema21), ema50: round(ema50), sma200: round(sma200),
      aboveSma200: sma200 ? last > sma200 : null,
      trendAlignment: interpretTrend(last, ema9, ema21, ema50, sma200),
      atr: round(atr), atrPct: atr && last ? round((atr / last) * 100) : null,
      vwap: round(vwap), aboveVwap: vwap ? last > vwap : null,
      overallSignal: interpretation.signal, overallReason: interpretation.reason,
      bullishFactors: interpretation.bullish, bearishFactors: interpretation.bearish,
    };
  }, { label: `technicals:${symbol}`, retries: 2, baseMs: 1000 });
}

async function fetchTechnicalsForSymbols(symbols, concurrency = 5) {
  const results = {};
  const batches = chunk(symbols, concurrency);
  for (const batch of batches) {
    const settled = await Promise.allSettled(batch.map(sym => fetchTechnicals(sym)));
    settled.forEach((result, i) => {
      results[batch[i]] = result.status === 'fulfilled' ? result.value : null;
      if (result.status === 'rejected') console.warn(`[Technicals] ${batch[i]} failed:`, result.reason?.message);
    });
  }
  return results;
}

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
  return currAbove ? 'ALCISTA (sin cruce reciente)' : 'BAJISTA (sin cruce reciente)';
}

function interpretTrend(price, ema9, ema21, ema50, sma200) {
  if (!price || !ema9 || !ema21 || !ema50) return 'DATOS INSUFICIENTES';
  const shortTrend = ema9 > ema21;
  const medTrend = ema21 > ema50;
  const longTrend = sma200 ? price > sma200 : null;
  if (shortTrend && medTrend && (longTrend !== false)) return 'ALCISTA CONFIRMADO (EMAs alineadas)';
  if (!shortTrend && !medTrend && (longTrend !== true)) return 'BAJISTA CONFIRMADO (EMAs alineadas)';
  if (shortTrend && !medTrend) return 'RECUPERACIÓN — EMA corta sobre media pero aún bajo EMA50';
  if (!shortTrend && medTrend) return 'DEBILITAMIENTO — pullback en tendencia alcista';
  return 'MIXTO';
}

function interpretIndicators({ rsi, macd, macdPrev, bb, last, ema9, ema21, ema50, sma200, vwap }) {
  const bullish = [], bearish = [];
  if (rsi <= 35) bullish.push(`RSI sobrevendido (${round(rsi)}) — posible rebote`);
  if (rsi >= 65) bearish.push(`RSI sobrecomprado (${round(rsi)}) — posible techo`);
  if (rsi >= 50 && rsi < 65) bullish.push(`RSI en zona positiva (${round(rsi)})`);
  if (macd && macdPrev) {
    if (macd.MACD > macd.signal && macdPrev.MACD <= macdPrev.signal) bullish.push('Cruce alcista de MACD ⚡');
    if (macd.MACD < macd.signal && macdPrev.MACD >= macdPrev.signal) bearish.push('Cruce bajista de MACD ⚠');
    if (macd.histogram > 0 && macd.histogram > macdPrev.histogram) bullish.push('Histograma MACD expandiéndose al alza');
    if (macd.histogram < 0 && macd.histogram < macdPrev.histogram) bearish.push('Histograma MACD expandiéndose a la baja');
  }
  if (bb) {
    if (last <= bb.lower) bullish.push('Precio en banda inferior BB — rebote probable');
    if (last >= bb.upper) bearish.push('Precio en banda superior BB — extensión máxima');
  }
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
  if (vwap) {
    if (last > vwap) bullish.push(`Sobre VWAP ($${round(vwap)})`);
    else bearish.push(`Bajo VWAP ($${round(vwap)})`);
  }
  const score = bullish.length - bearish.length;
  let signal = score >= 3 ? 'ALCISTA FUERTE' : score >= 1 ? 'ALCISTA' : score === 0 ? 'NEUTRAL' : score >= -2 ? 'BAJISTA' : 'BAJISTA FUERTE';
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
