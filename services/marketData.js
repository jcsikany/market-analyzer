const yahooFinance = require('yahoo-finance2').default;
const { withRetry, parallelWithFallback } = require('../utils/retry');
const { filterByLiquidity } = require('./earningsAndLiquidity');

yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

const INDICES = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', DIA: 'Dow Jones', IWM: 'Russell 2000' };

const SECTOR_ETFS = {
  XLK: 'Tecnología', XLF: 'Finanzas', XLE: 'Energía', XLV: 'Salud',
  XLI: 'Industrial', XLY: 'Consumo Disc.', XLP: 'Consumo Básico',
  XLU: 'Utilities', XLB: 'Materiales', XLRE: 'Real Estate', XLC: 'Comunicaciones',
};

function formatQuote(q) {
  if (!q) return null;
  return {
    symbol: q.symbol,
    price: q.regularMarketPrice ?? null,
    change: q.regularMarketChange ?? null,
    changePct: q.regularMarketChangePercent ?? null,
    volume: q.regularMarketVolume ?? null,
    avgVolume: q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? null,
    open: q.regularMarketOpen ?? null,
    prevClose: q.regularMarketPreviousClose ?? null,
    dayHigh: q.regularMarketDayHigh ?? null,
    dayLow: q.regularMarketDayLow ?? null,
    marketCap: q.marketCap ?? null,
    shortName: q.shortName ?? q.symbol,
    preMarketPrice: q.preMarketPrice ?? null,
    preMarketChange: q.preMarketChange ?? null,
    preMarketChangePct: q.preMarketChangePercent ?? null,
    postMarketPrice: q.postMarketPrice ?? null,
    postMarketChangePct: q.postMarketChangePercent ?? null,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
  };
}

function volumeRatio(q) {
  if (!q?.volume || !q?.avgVolume) return null;
  return parseFloat((q.volume / q.avgVolume).toFixed(2));
}

function analyzePreMarket(quoteMap) {
  const analysis = {};
  for (const [sym, name] of Object.entries(INDICES)) {
    const q = formatQuote(quoteMap[sym]);
    if (!q) continue;
    const prePct = q.preMarketChangePct;
    const openPct = q.open && q.prevClose ? ((q.open - q.prevClose) / q.prevClose) * 100 : null;
    let preVsOpen = null;
    if (prePct != null && openPct != null) {
      const diff = openPct - prePct;
      preVsOpen = diff > 0.2 ? 'FOLLOW-THROUGH — apertura confirmó pre-market'
        : diff < -0.2 ? 'FADE — apertura revirtió pre-market' : 'EN LÍNEA con pre-market';
    }
    analysis[sym] = {
      name, preMarketChangePct: prePct != null ? parseFloat(prePct.toFixed(2)) : null,
      preMarketSignal: interpretPreMarket(prePct),
      openGapPct: openPct != null ? parseFloat(openPct.toFixed(2)) : null,
      gapType: openPct != null ? classifyGap(openPct) : null, preVsOpen,
    };
  }
  const prePcts = Object.values(analysis).map(a => a.preMarketChangePct).filter(v => v != null);
  const avgPre = prePcts.length ? prePcts.reduce((a, b) => a + b, 0) / prePcts.length : null;
  return {
    byIndex: analysis,
    consensus: avgPre != null ? interpretPreMarket(avgPre) : 'NO DISPONIBLE',
    avgPreMarketPct: avgPre != null ? parseFloat(avgPre.toFixed(2)) : null,
  };
}

function interpretPreMarket(pct) {
  if (pct == null) return 'SIN DATOS';
  if (pct > 1.0) return 'MUY ALCISTA pre-market';
  if (pct > 0.3) return 'ALCISTA pre-market';
  if (pct > -0.3) return 'NEUTRO pre-market';
  if (pct > -1.0) return 'BAJISTA pre-market';
  return 'MUY BAJISTA pre-market';
}

function classifyGap(pct) {
  if (pct > 1.0) return 'GAP UP FUERTE';
  if (pct > 0.3) return 'GAP UP MODERADO';
  if (pct < -1.0) return 'GAP DOWN FUERTE';
  if (pct < -0.3) return 'GAP DOWN MODERADO';
  return 'SIN GAP SIGNIFICATIVO';
}

function computeBreadth(gainers, losers, mostActives, sectors) {
  const activesAdv = mostActives.filter(q => (q.changePct ?? 0) > 0).length;
  const activesTotal = mostActives.length;
  const activesAdvPct = activesTotal > 0 ? Math.round((activesAdv / activesTotal) * 100) : null;
  const volRatios = mostActives.map(q => volumeRatio(q)).filter(v => v != null);
  const avgVolRatio = volRatios.length ? parseFloat((volRatios.reduce((a, b) => a + b, 0) / volRatios.length).toFixed(2)) : null;

  let breadthSignal;
  if (activesAdvPct >= 70) breadthSignal = 'AMPLITUD FUERTE — rally con participación amplia';
  else if (activesAdvPct >= 55) breadthSignal = 'AMPLITUD MODERADA — mayoría de acciones acompaña';
  else if (activesAdvPct >= 45) breadthSignal = 'AMPLITUD NEUTRAL — mercado dividido';
  else if (activesAdvPct >= 30) breadthSignal = 'AMPLITUD DÉBIL — rally concentrado o distribución';
  else breadthSignal = 'AMPLITUD MUY DÉBIL — la mayoría de acciones baja';

  const greenSectors = sectors.filter(s => (s.changePct ?? 0) > 0).length;
  const sectorPct = Math.round((greenSectors / sectors.length) * 100);

  return {
    activesAdvancingPct: activesAdvPct, breadthSignal, avgVolumeRatio: avgVolRatio,
    volumeSignal: avgVolRatio > 1.5 ? 'VOLUMEN INUSUALMENTE ALTO' : avgVolRatio > 1.0 ? 'Volumen normal-alto' : 'Volumen bajo o normal',
    sectorBreadth: { green: greenSectors, total: sectors.length, pct: sectorPct,
      signal: sectorPct >= 80 ? 'AMPLITUD SECTORIAL MUY FUERTE' : sectorPct >= 60 ? 'AMPLITUD SECTORIAL FUERTE' : sectorPct >= 40 ? 'MIXTO' : 'AMPLITUD SECTORIAL DÉBIL' },
  };
}

async function fetchMarketData() {
  console.log('[MarketData] Fetching market data...');
  const allSymbols = [...Object.keys(INDICES), ...Object.keys(SECTOR_ETFS), '^VIX'];

  const quotesRaw = await withRetry(
    () => yahooFinance.quote(allSymbols),
    { label: 'quotes-main', retries: 3, baseMs: 1000 }
  );

  const quotesArr = Array.isArray(quotesRaw) ? quotesRaw : [quotesRaw];
  const quoteMap = {};
  quotesArr.forEach(q => { if (q?.symbol) quoteMap[q.symbol] = q; });

  const indices = {};
  for (const [sym, name] of Object.entries(INDICES)) {
    const q = formatQuote(quoteMap[sym]);
    if (q) indices[sym] = { ...q, name };
  }

  const vixRaw = quoteMap['^VIX'];
  const vix = vixRaw ? {
    value: vixRaw.regularMarketPrice, change: vixRaw.regularMarketChange,
    changePct: vixRaw.regularMarketChangePercent, interpretation: interpretVIX(vixRaw.regularMarketPrice),
  } : null;

  const sectorsMap = {};
  for (const [sym, name] of Object.entries(SECTOR_ETFS)) {
    const q = formatQuote(quoteMap[sym]);
    if (q) sectorsMap[sym] = { ...q, name };
  }
  const sectors = Object.entries(sectorsMap)
    .sort(([, a], [, b]) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .map(([sym, data]) => ({ sym, ...data }));

  const [gainersRes, losersRes, activesRes] = await parallelWithFallback([
    { fn: () => withRetry(() => yahooFinance.screener({ scrIds: 'day_gainers', count: 20, region: 'US', lang: 'en-US' }), { label: 'gainers' }), fallback: { quotes: [] }, label: 'gainers' },
    { fn: () => withRetry(() => yahooFinance.screener({ scrIds: 'day_losers', count: 15, region: 'US', lang: 'en-US' }), { label: 'losers' }), fallback: { quotes: [] }, label: 'losers' },
    { fn: () => withRetry(() => yahooFinance.screener({ scrIds: 'most_actives', count: 20, region: 'US', lang: 'en-US' }), { label: 'actives' }), fallback: { quotes: [] }, label: 'actives' },
  ]);

  const rawGainers = (gainersRes?.quotes ?? []).map(formatQuote).filter(Boolean);
  const rawLosers  = (losersRes?.quotes ?? []).map(formatQuote).filter(Boolean);
  const rawActives = (activesRes?.quotes ?? []).map(formatQuote).filter(Boolean);

  const { passed: gainers }     = filterByLiquidity(rawGainers);
  const { passed: losers }      = filterByLiquidity(rawLosers);
  const { passed: mostActives } = filterByLiquidity(rawActives);

  const preMarket = analyzePreMarket(quoteMap);

  const seen = new Set();
  const unusualVolume = [...gainers, ...mostActives]
    .filter(q => { const r = volumeRatio(q); if (r == null || r < 2.0 || seen.has(q.symbol)) return false; seen.add(q.symbol); return true; })
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, 10)
    .map(q => ({ ...q, volumeRatio: volumeRatio(q) }));

  const gapAnalysis = {};
  for (const [sym] of Object.entries(INDICES)) {
    const q = indices[sym];
    if (q?.open && q?.prevClose) {
      const gap = ((q.open - q.prevClose) / q.prevClose) * 100;
      gapAnalysis[sym] = { gap: parseFloat(gap.toFixed(2)), direction: gap > 0.2 ? 'GAP UP' : gap < -0.2 ? 'GAP DOWN' : 'FLAT' };
    }
  }

  const breadth = computeBreadth(gainers, losers, mostActives, sectors);

  console.log('[MarketData] Done.');
  return { timestamp: new Date().toISOString(), indices, vix, sectors, gainers: gainers.slice(0, 12), losers: losers.slice(0, 8), mostActives: mostActives.slice(0, 12), unusualVolume, gapAnalysis, preMarket, breadth };
}

function interpretVIX(value) {
  if (!value) return 'N/A';
  if (value < 12) return 'Complacencia extrema';
  if (value < 15) return 'Calmo — baja volatilidad';
  if (value < 20) return 'Normal — volatilidad moderada';
  if (value < 25) return 'Elevado — ansiedad en el mercado';
  if (value < 30) return 'Alto — mercado nervioso';
  if (value < 40) return 'Muy alto — miedo significativo';
  return 'Extremo — pánico en el mercado';
}

module.exports = { fetchMarketData };
