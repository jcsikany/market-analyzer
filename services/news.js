const axios = require('axios');
const { withRetry } = require('../utils/retry');

const NEWS_API_BASE = 'https://newsapi.org/v2';

/**
 * Queries para cubrir todo lo relevante del mercado
 */
const NEWS_QUERIES = [
  'stock market Wall Street earnings',
  'Federal Reserve interest rates inflation',
  'S&P 500 Nasdaq market today',
];

/**
 * Fuentes financieras confiables
 */
const FINANCIAL_SOURCES = [
  'bloomberg',
  'the-wall-street-journal',
  'financial-times',
  'cnbc',
  'reuters',
  'business-insider',
  'fortune',
  'the-economist',
].join(',');

/**
 * Obtiene noticias financieras relevantes de las últimas 18 horas
 */
async function fetchNews() {
  const apiKey = process.env.NEWS_API_KEY;
  
  if (!apiKey) {
    console.warn('[News] NEWS_API_KEY no configurada, saltando noticias.');
    return { headlines: [], error: 'API key no configurada' };
  }

  console.log('[News] Fetching news...');

  try {
    const since = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();

    const [response, queryResponse] = await Promise.all([
      withRetry(() => axios.get(`${NEWS_API_BASE}/top-headlines`, {
        params: { sources: FINANCIAL_SOURCES, apiKey, pageSize: 20, language: 'en' },
        timeout: 10000,
      }), { label: 'news-headlines', retries: 2 }),
      withRetry(() => axios.get(`${NEWS_API_BASE}/everything`, {
        params: {
          q: 'stock market OR earnings OR Federal Reserve OR "Wall Street"',
          language: 'en', sortBy: 'publishedAt', from: since, pageSize: 15, apiKey,
        },
        timeout: 10000,
      }), { label: 'news-everything', retries: 2 }),
    ]);

    const queryArticles = queryResponse.data?.articles ?? [];

    // Combinar y deduplicar por título
    const seenTitles = new Set();
    const allArticles = [...articles, ...queryArticles].filter(a => {
      if (!a.title || a.title === '[Removed]') return false;
      const key = a.title.slice(0, 60);
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });

    // Formatear para el prompt
    const headlines = allArticles.slice(0, 20).map(a => ({
      title: a.title,
      source: a.source?.name ?? 'Unknown',
      publishedAt: a.publishedAt,
      description: a.description ? a.description.slice(0, 150) : '',
      sentiment: guessSentiment(a.title),
    }));

    console.log(`[News] Got ${headlines.length} articles.`);
    return { headlines };

  } catch (error) {
    console.error('[News] Error:', error.message);
    return { headlines: [], error: error.message };
  }
}

/**
 * Análisis de sentimiento básico por palabras clave
 */
function guessSentiment(title) {
  if (!title) return 'NEUTRAL';
  const lower = title.toLowerCase();
  
  const bullish = ['surge', 'rally', 'gain', 'rise', 'beat', 'record', 'high', 'growth',
    'strong', 'boost', 'jump', 'soar', 'upgrade', 'buy', 'bullish', 'recovery'];
  const bearish = ['fall', 'drop', 'decline', 'crash', 'plunge', 'miss', 'low', 'weak',
    'concern', 'worry', 'fear', 'sell', 'downgrade', 'bearish', 'recession', 'cut', 'loss'];

  const bullScore = bullish.filter(w => lower.includes(w)).length;
  const bearScore = bearish.filter(w => lower.includes(w)).length;

  if (bullScore > bearScore) return 'POSITIVO';
  if (bearScore > bullScore) return 'NEGATIVO';
  return 'NEUTRAL';
}

module.exports = { fetchNews };
