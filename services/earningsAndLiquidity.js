const yahooFinance = require('yahoo-finance2').default;
const { withRetry } = require('../utils/retry');

yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

// ─── Filtros de liquidez mínima (Punto 10) ─────────────────────────────────────
const LIQUIDITY_FILTERS = {
  minAvgVolume: 500_000,   // Mínimo 500K shares/día promedio
  minPrice: 10,            // Mínimo $10 por acción (evitar penny stocks)
  minMarketCap: 500_000_000, // Mínimo $500M market cap
};

/**
 * Verifica si un ticker pasa los filtros mínimos de liquidez.
 * @param {Object} quote - quote de Yahoo Finance (formateado)
 * @returns {{ passes: boolean, reason: string }}
 */
function checkLiquidity(quote) {
  if (!quote) return { passes: false, reason: 'Sin datos de cotización' };

  if (quote.price && quote.price < LIQUIDITY_FILTERS.minPrice) {
    return { passes: false, reason: `Precio $${quote.price} < mínimo $${LIQUIDITY_FILTERS.minPrice}` };
  }

  if (quote.avgVolume && quote.avgVolume < LIQUIDITY_FILTERS.minAvgVolume) {
    const vol = (quote.avgVolume / 1000).toFixed(0);
    return { passes: false, reason: `Volumen promedio ${vol}K < mínimo 500K` };
  }

  if (quote.marketCap && quote.marketCap < LIQUIDITY_FILTERS.minMarketCap) {
    const mc = (quote.marketCap / 1_000_000).toFixed(0);
    return { passes: false, reason: `Market cap $${mc}M < mínimo $500M` };
  }

  return { passes: true, reason: 'Liquidez OK' };
}

/**
 * Filtra una lista de quotes por liquidez mínima
 * @param {Array} quotes - array de quotes formateados
 * @returns {{ passed: Array, rejected: Array }}
 */
function filterByLiquidity(quotes) {
  const passed = [];
  const rejected = [];

  for (const q of quotes) {
    const check = checkLiquidity(q);
    if (check.passes) {
      passed.push(q);
    } else {
      rejected.push({ ...q, rejectedReason: check.reason });
      console.log(`[Liquidity] Filtered out ${q.symbol}: ${check.reason}`);
    }
  }

  return { passed, rejected };
}

// ─── Earnings Calendar (Punto 3) ──────────────────────────────────────────────

/**
 * Obtiene el calendario de earnings de los próximos 2 días para una lista de symbols.
 * Usa Yahoo Finance quoteSummary con módulo calendarEvents.
 * @param {string[]} symbols
 */
async function fetchEarningsCalendar(symbols) {
  if (!symbols?.length) return { earningsToday: [], earningsTomorrow: [], earningsThisWeek: [] };

  console.log(`[Earnings] Checking earnings calendar for ${symbols.length} symbols...`);

  const today = new Date();
  const todayStr = formatDate(today);
  const tomorrowStr = formatDate(addDays(today, 1));
  const in3Days = formatDate(addDays(today, 3));

  const earningsToday = [];
  const earningsTomorrow = [];
  const earningsThisWeek = [];

  // Limitar concurrencia — Yahoo Finance se queja si hacemos muchas requests juntas
  const BATCH_SIZE = 8;
  const batches = chunk(symbols, BATCH_SIZE);

  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(sym => fetchEarningsForSymbol(sym))
    );

    results.forEach((result, i) => {
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
    const summary = await yahooFinance.quoteSummary(symbol, {
      modules: ['calendarEvents', 'defaultKeyStatistics'],
    });

    const cal = summary?.calendarEvents;
    const earningsArr = cal?.earnings?.earningsDate ?? [];

    if (!earningsArr.length) return null;

    // Yahoo devuelve fechas como objetos Date o timestamps
    const nextEarnings = earningsArr[0];
    const earningsDate = nextEarnings instanceof Date
      ? formatDate(nextEarnings)
      : formatDate(new Date(nextEarnings));

    return {
      symbol,
      earningsDate,
      epsEstimate: cal?.earnings?.earningsAverage ?? null,
      revenueEstimate: cal?.earnings?.revenueAverage ?? null,
      when: cal?.earnings?.earningsDate?.length > 1 ? 'range' : 'exact',
    };
  }, { label: `earnings:${symbol}`, retries: 1, baseMs: 500 }).catch(() => null);
}

/**
 * Para un análisis dado, marca qué tickers candidatos reportan earnings pronto.
 * Esto es crítico — operar antes de earnings es ruleta rusa.
 * @param {string[]} symbols
 * @returns {Map<string, Object>} mapa symbol → info de earnings si aplica
 */
async function flagEarningsRisk(symbols) {
  const { earningsToday, earningsTomorrow, earningsThisWeek } = await fetchEarningsCalendar(symbols);

  const riskMap = new Map();

  earningsToday.forEach(e => riskMap.set(e.symbol, {
    ...e, risk: 'CRÍTICO', message: '⚠ REPORTA HOY — operar es ruleta rusa',
  }));
  earningsTomorrow.forEach(e => riskMap.set(e.symbol, {
    ...e, risk: 'ALTO', message: '⚠ Reporta mañana — alta volatilidad esperada',
  }));
  earningsThisWeek.forEach(e => {
    if (!riskMap.has(e.symbol)) riskMap.set(e.symbol, {
      ...e, risk: 'MEDIO', message: `Reporta el ${e.earningsDate} — considerar en el sizing`,
    });
  });

  return riskMap;
}

const formatDate = (d) => d.toISOString().split('T')[0];
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

module.exports = { fetchEarningsCalendar, flagEarningsRisk, checkLiquidity, filterByLiquidity, LIQUIDITY_FILTERS };
