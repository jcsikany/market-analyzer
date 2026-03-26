const yahooFinance = require('yahoo-finance2').default;
const { withRetry } = require('../utils/retry');

yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

const LIQUIDITY_FILTERS = {
  minAvgVolume: 500_000, minPrice: 10, minMarketCap: 500_000_000,
};

function checkLiquidity(quote) {
  if (!quote) return { passes: false, reason: 'Sin datos de cotización' };
  if (quote.price && quote.price < LIQUIDITY_FILTERS.minPrice)
    return { passes: false, reason: `Precio $${quote.price} < mínimo $${LIQUIDITY_FILTERS.minPrice}` };
  if (quote.avgVolume && quote.avgVolume < LIQUIDITY_FILTERS.minAvgVolume)
    return { passes: false, reason: `Volumen promedio ${(quote.avgVolume / 1000).toFixed(0)}K < mínimo 500K` };
  if (quote.marketCap && quote.marketCap < LIQUIDITY_FILTERS.minMarketCap)
    return { passes: false, reason: `Market cap $${(quote.marketCap / 1_000_000).toFixed(0)}M < mínimo $500M` };
  return { passes: true, reason: 'Liquidez OK' };
}

function filterByLiquidity(quotes) {
  const passed = [], rejected = [];
  for (const q of quotes) {
    const check = checkLiquidity(q);
    if (check.passes) { passed.push(q); }
    else { rejected.push({ ...q, rejectedReason: check.reason }); console.log(`[Liquidity] Filtered out ${q.symbol}: ${check.reason}`); }
  }
  return { passed, rejected };
}

async function fetchEarningsCalendar(symbols) {
  if (!symbols?.length) return { earningsToday: [], earningsTomorrow: [], earningsThisWeek: [] };
  console.log(`[Earnings] Checking earnings calendar for ${symbols.length} symbols...`);

  const today = new Date();
  const todayStr = formatDate(today);
  const tomorrowStr = formatDate(addDays(today, 1));
  const in3Days = formatDate(addDays(today, 3));
  const earningsToday = [], earningsTomorrow = [], earningsThisWeek = [];

  const batches = chunk(symbols, 8);
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map(sym => fetchEarningsForSymbol(sym)));
    results.forEach((result) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const { symbol, earningsDate, epsEstimate, revenueEstimate, when } = result.value;
      if (!earningsDate) return;
      const info = { symbol, earningsDate, epsEstimate, revenueEstimate, when };
      if (earningsDate === todayStr) earningsToday.push(info);
      else if (earningsDate === tomorrowStr) earningsTomorrow.push(info);
      else if (earningsDate <= in3Days) earningsThisWeek.push(info);
    });
  }

  console.log(`[Earnings] Today: ${earningsToday.length}, Tomorrow: ${earningsTomorrow.length}, This week: ${earningsThisWeek.length}`);
  return { earningsToday, earningsTomorrow, earningsThisWeek };
}

async function fetchEarningsForSymbol(symbol) {
  return withRetry(async () => {
    const summary = await yahooFinance.quoteSummary(symbol, { modules: ['calendarEvents', 'defaultKeyStatistics'] });
    const cal = summary?.calendarEvents;
    const earningsArr = cal?.earnings?.earningsDate ?? [];
    if (!earningsArr.length) return null;
    const nextEarnings = earningsArr[0];
    const earningsDate = nextEarnings instanceof Date ? formatDate(nextEarnings) : formatDate(new Date(nextEarnings));
    return { symbol, earningsDate, epsEstimate: cal?.earnings?.earningsAverage ?? null, revenueEstimate: cal?.earnings?.revenueAverage ?? null, when: cal?.earnings?.earningsDate?.length > 1 ? 'range' : 'exact' };
  }, { label: `earnings:${symbol}`, retries: 1, baseMs: 500 }).catch(() => null);
}

async function flagEarningsRisk(symbols) {
  const { earningsToday, earningsTomorrow, earningsThisWeek } = await fetchEarningsCalendar(symbols);
  const riskMap = new Map();
  earningsToday.forEach(e => riskMap.set(e.symbol, { ...e, risk: 'CRÍTICO', message: '⚠ REPORTA HOY — operar es ruleta rusa' }));
  earningsTomorrow.forEach(e => riskMap.set(e.symbol, { ...e, risk: 'ALTO', message: '⚠ Reporta mañana — alta volatilidad esperada' }));
  earningsThisWeek.forEach(e => { if (!riskMap.has(e.symbol)) riskMap.set(e.symbol, { ...e, risk: 'MEDIO', message: `Reporta el ${e.earningsDate} — considerar en el sizing` }); });
  return riskMap;
}

const formatDate = (d) => d.toISOString().split('T')[0];
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

module.exports = { fetchEarningsCalendar, flagEarningsRisk, checkLiquidity, filterByLiquidity, LIQUIDITY_FILTERS };
