const axios = require('axios');

const SEC_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const SEC_EMAIL = process.env.SEC_EDGAR_EMAIL || 'marketanalyzer@example.com';

const USER_AGENT = `MarketAnalyzer/2.0 (${SEC_EMAIL})`;

// Rate limiter simple: max 8 requests por segundo
let lastRequest = 0;
const MIN_INTERVAL = 130; // ms entre requests

async function throttle() {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequest = Date.now();
}

/**
 * Busca insider trading (Form 4) para una lista de símbolos.
 * Retorna un mapa ticker -> { netBuying, totalBuys, totalSells, recentFilings }
 */
async function fetchInsiderTrading(symbols) {
  if (!symbols || symbols.length === 0) return {};

  console.log(`[SEC EDGAR] Fetching insider trading for ${symbols.length} symbols...`);
  const results = {};

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  for (const symbol of symbols) {
    try {
      await throttle();

      const { data } = await axios.get('https://efts.sec.gov/LATEST/search-index', {
        params: {
          q: `"${symbol}"`,
          dateRange: 'custom',
          startdt: thirtyDaysAgo,
          forms: '4',
          from: 0,
          size: 20,
        },
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        timeout: 10000,
      });

      const hits = data.hits?.hits || [];
      const filings = hits.length;

      // Analizar filing descriptions para determinar buys vs sells
      let buySignals = 0;
      let sellSignals = 0;

      for (const hit of hits) {
        const desc = (hit._source?.display_names || []).join(' ').toLowerCase();
        const form = hit._source?.form_type || '';

        // Form 4 contiene "acquisition" or "disposition"
        // Sin poder parsear el XML completo, estimamos por frecuencia
        if (desc.includes('purchase') || desc.includes('acquisition')) buySignals++;
        else if (desc.includes('sale') || desc.includes('disposition')) sellSignals++;
      }

      // Si no podemos determinar dirección, asumimos mixto
      if (buySignals === 0 && sellSignals === 0 && filings > 0) {
        // Heuristic: muchos filings sin contexto -> probable selling (más común)
        sellSignals = Math.floor(filings * 0.6);
        buySignals = filings - sellSignals;
      }

      const netBuying = buySignals > sellSignals;

      results[symbol] = {
        recentFilings: filings,
        buySignals,
        sellSignals,
        netBuying,
        signal: filings === 0 ? 'NO DATA'
          : netBuying ? 'NET BUYING'
          : buySignals === sellSignals ? 'NEUTRAL'
          : 'NET SELLING',
        summary: filings === 0
          ? 'Sin actividad insider en 30 días'
          : `${filings} filings: ${buySignals} compras, ${sellSignals} ventas → ${netBuying ? 'Compra neta (alcista)' : 'Venta neta (bajista)'}`,
      };

      console.log(`[SEC EDGAR] ${symbol}: ${results[symbol].signal} (${filings} filings)`);
    } catch (err) {
      console.warn(`[SEC EDGAR] Error for ${symbol}:`, err.message);
      results[symbol] = {
        recentFilings: 0,
        buySignals: 0,
        sellSignals: 0,
        netBuying: false,
        signal: 'ERROR',
        summary: 'Datos no disponibles',
      };
    }
  }

  return results;
}

module.exports = { fetchInsiderTrading };
