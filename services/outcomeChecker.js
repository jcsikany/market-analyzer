const { default: YahooFinance } = require('yahoo-finance2');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const db = require('../db');

/**
 * Verifica los outcomes de todas las recomendaciones PENDING cuyo timeHorizon ya expiró.
 * Se ejecuta diariamente a las 4:30 PM ET vía cron.
 */
async function checkOutcomes() {
  console.log('[OutcomeChecker] Starting outcome verification...');
  const pending = db.getPendingExpiredRecommendations();

  if (pending.length === 0) {
    console.log('[OutcomeChecker] No pending recommendations to check.');
    return;
  }

  console.log(`[OutcomeChecker] Checking ${pending.length} recommendations...`);
  let checked = 0;

  for (const rec of pending) {
    try {
      const outcome = await evaluateOutcome(rec);
      db.updateRecommendationOutcome(rec._id, outcome);
      console.log(`[OutcomeChecker] ${rec.ticker}: ${outcome.outcome} (price: $${outcome.price?.toFixed(2) ?? 'N/A'})`);
      checked++;
    } catch (err) {
      console.error(`[OutcomeChecker] Error checking ${rec.ticker}:`, err.message);
    }
  }

  console.log(`[OutcomeChecker] Checked ${checked}/${pending.length} recommendations.`);

  // Recalcular stats de performance
  computeAndSaveStats();
}

/**
 * Verifica una sola recomendación por ID (para el endpoint manual).
 */
async function checkSingleOutcome(recId) {
  const rec = db.getRecommendation(recId);
  if (!rec) throw new Error('Recommendation not found');
  if (rec.outcome !== 'PENDING') {
    return { message: 'Already resolved', outcome: rec.outcome };
  }

  const outcome = await evaluateOutcome(rec);
  db.updateRecommendationOutcome(rec._id, outcome);
  return outcome;
}

/**
 * Evalúa el outcome de una recomendación usando datos OHLC históricos.
 */
async function evaluateOutcome(rec) {
  const { ticker, action, target, stopLoss, entryLow, entryHigh, generatedAt, timeHorizon } = rec;
  const entry = (entryLow + entryHigh) / 2;

  const startDate = new Date(generatedAt);
  const daysToCheck = db.parseTimeHorizon(timeHorizon);
  const endDate = new Date(startDate.getTime() + (daysToCheck + 2) * 24 * 60 * 60 * 1000); // +2 for weekends
  const now = new Date();
  const effectiveEnd = endDate > now ? now : endDate;

  let quotes;
  try {
    const result = await yahooFinance.chart(ticker, {
      period1: startDate.toISOString().split('T')[0],
      period2: effectiveEnd.toISOString().split('T')[0],
      interval: '1d',
    });
    quotes = result.quotes || [];
  } catch (err) {
    return {
      outcome: 'EXPIRED',
      price: null,
      details: { error: `Could not fetch data: ${err.message}` },
    };
  }

  if (quotes.length === 0) {
    return {
      outcome: 'EXPIRED',
      price: null,
      details: { error: 'No price data available for the period' },
    };
  }

  const isBuy = (action || '').toUpperCase() !== 'SHORT';
  const lastQuote = quotes[quotes.length - 1];
  const currentPrice = lastQuote.close;

  let hitTarget = false;
  let hitStop = false;
  let targetDay = -1;
  let stopDay = -1;
  let highestPrice = -Infinity;
  let lowestPrice = Infinity;

  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i];
    if (!q.high || !q.low) continue;

    highestPrice = Math.max(highestPrice, q.high);
    lowestPrice = Math.min(lowestPrice, q.low);

    if (isBuy) {
      if (!hitTarget && q.high >= target) { hitTarget = true; targetDay = i; }
      if (!hitStop && q.low <= stopLoss) { hitStop = true; stopDay = i; }
    } else {
      // SHORT: target is below entry, stop is above
      if (!hitTarget && q.low <= target) { hitTarget = true; targetDay = i; }
      if (!hitStop && q.high >= stopLoss) { hitStop = true; stopDay = i; }
    }
  }

  // Calcular ganancia/pérdida real
  const actualChangePct = ((currentPrice - entry) / entry) * 100 * (isBuy ? 1 : -1);

  // Determinar outcome
  let outcome;
  if (hitTarget && hitStop) {
    // Ambos tocados - el que ocurrió primero gana, si mismo día = PARTIAL
    if (targetDay < stopDay) outcome = 'HIT_TARGET';
    else if (stopDay < targetDay) outcome = 'STOPPED_OUT';
    else outcome = 'PARTIAL';
  } else if (hitTarget) {
    outcome = 'HIT_TARGET';
  } else if (hitStop) {
    outcome = 'STOPPED_OUT';
  } else {
    // Ninguno tocado - verificar si se movió >50% hacia target
    const distToTarget = Math.abs(target - entry);
    const currentDist = isBuy
      ? Math.max(0, highestPrice - entry)
      : Math.max(0, entry - lowestPrice);

    if (distToTarget > 0 && (currentDist / distToTarget) >= 0.5) {
      outcome = 'PARTIAL';
    } else {
      outcome = 'EXPIRED';
    }
  }

  // Calcular ganancia/pérdida según outcome
  let actualGainPct = 0;
  let actualLossPct = 0;
  if (outcome === 'HIT_TARGET') {
    actualGainPct = Math.abs(((target - entry) / entry) * 100);
  } else if (outcome === 'STOPPED_OUT') {
    actualLossPct = Math.abs(((entry - stopLoss) / entry) * 100);
  } else {
    // Para PARTIAL y EXPIRED, usar cambio real
    if (actualChangePct > 0) actualGainPct = actualChangePct;
    else actualLossPct = Math.abs(actualChangePct);
  }

  return {
    outcome,
    price: currentPrice,
    details: {
      highestPrice,
      lowestPrice,
      daysHeld: quotes.length,
      hitTarget,
      hitStop,
      targetDay,
      stopDay,
      actualChangePct: parseFloat(actualChangePct.toFixed(2)),
      actualGainPct: parseFloat(actualGainPct.toFixed(2)),
      actualLossPct: parseFloat(actualLossPct.toFixed(2)),
    },
  };
}

/**
 * Calcula y guarda stats de performance agregadas.
 */
function computeAndSaveStats() {
  const all = db.getRecommendations({ limit: 1000 });
  const resolved = all.filter(r => r.outcome !== 'PENDING');

  if (resolved.length === 0) {
    console.log('[OutcomeChecker] No resolved recommendations for stats.');
    return;
  }

  const wins = resolved.filter(r => r.outcome === 'HIT_TARGET');
  const losses = resolved.filter(r => r.outcome === 'STOPPED_OUT');
  const partials = resolved.filter(r => r.outcome === 'PARTIAL');
  const expired = resolved.filter(r => r.outcome === 'EXPIRED');

  const gains = wins.map(r => r.outcomeDetails?.actualGainPct || parseFloat(r.potentialGainPct) || 0);
  const lossesPct = losses.map(r => r.outcomeDetails?.actualLossPct || parseFloat(r.potentialLossPct) || 0);

  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
  const avgLoss = lossesPct.length > 0 ? lossesPct.reduce((a, b) => a + b, 0) / lossesPct.length : 0;
  const totalGain = gains.reduce((a, b) => a + b, 0);
  const totalLoss = lossesPct.reduce((a, b) => a + b, 0);
  const profitFactor = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? Infinity : 0;

  // Best and worst trades
  const allWithPnl = resolved.map(r => ({
    ticker: r.ticker,
    outcome: r.outcome,
    pnl: r.outcome === 'HIT_TARGET'
      ? (r.outcomeDetails?.actualGainPct || parseFloat(r.potentialGainPct) || 0)
      : -(r.outcomeDetails?.actualLossPct || parseFloat(r.potentialLossPct) || 0),
    date: r.generatedAt,
  }));

  allWithPnl.sort((a, b) => b.pnl - a.pnl);
  const bestTrade = allWithPnl[0] || null;
  const worstTrade = allWithPnl[allWithPnl.length - 1] || null;

  const stats = {
    totalRecs: resolved.length,
    wins: wins.length,
    losses: losses.length,
    partials: partials.length,
    expired: expired.length,
    avgGainPct: parseFloat(avgGain.toFixed(2)),
    avgLossPct: parseFloat(avgLoss.toFixed(2)),
    winRate: parseFloat(((wins.length / resolved.length) * 100).toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    bestTrade,
    worstTrade,
  };

  db.savePerformanceStats(stats);
  console.log(`[OutcomeChecker] Stats saved: ${stats.wins}W / ${stats.losses}L / ${stats.partials}P / ${stats.expired}E (${stats.winRate}% WR)`);
}

module.exports = { checkOutcomes, checkSingleOutcome, computeAndSaveStats };
