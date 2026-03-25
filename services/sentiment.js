const axios = require('axios');

/**
 * CNN Fear & Greed Index (endpoint no oficial, funciona sin auth)
 * Escala: 0-100 (0=miedo extremo, 100=codicia extrema)
 */
async function fetchSentiment() {
  console.log('[Sentiment] Fetching Fear & Greed index...');

  try {
    const response = await axios.get(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MarketAnalyzer/1.0)',
          'Referer': 'https://www.cnn.com/markets/fear-and-greed',
        },
      }
    );

    const data = response.data;
    const current = data?.fear_and_greed;

    if (!current) throw new Error('Invalid F&G response');

    const score = Math.round(parseFloat(current.score));
    const rating = current.rating ?? classifyFearGreed(score);
    const previousClose = data?.fear_and_greed_historical?.data?.[0]?.y ?? null;
    const weekAgo = data?.fear_and_greed_historical?.data?.[7]?.y ?? null;

    return {
      score,
      rating: normalizeRating(rating),
      label: labelFearGreed(score),
      emoji: emojiFearGreed(score),
      previousClose: previousClose ? Math.round(previousClose) : null,
      weekAgo: weekAgo ? Math.round(weekAgo) : null,
      trend: getTrend(score, previousClose),
    };

  } catch (error) {
    console.warn('[Sentiment] F&G index unavailable:', error.message);
    // Fallback — no bloquear el análisis por esto
    return {
      score: null,
      rating: 'UNAVAILABLE',
      label: 'No disponible',
      emoji: '❓',
      error: error.message,
    };
  }
}

function classifyFearGreed(score) {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 40) return 'Fear';
  if (score <= 60) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

function normalizeRating(rating) {
  const map = {
    'Extreme Fear': 'MIEDO EXTREMO',
    'Fear': 'MIEDO',
    'Neutral': 'NEUTRAL',
    'Greed': 'CODICIA',
    'Extreme Greed': 'CODICIA EXTREMA',
  };
  return map[rating] ?? rating;
}

function labelFearGreed(score) {
  if (!score && score !== 0) return 'No disponible';
  if (score <= 25) return 'Miedo Extremo — posible oportunidad de compra contrarian';
  if (score <= 40) return 'Miedo — mercado cauteloso';
  if (score <= 60) return 'Neutral — sin sesgo claro';
  if (score <= 75) return 'Codicia — mercado optimista';
  return 'Codicia Extrema — precaución, posible techo';
}

function emojiFearGreed(score) {
  if (!score && score !== 0) return '❓';
  if (score <= 25) return '😱';
  if (score <= 40) return '😨';
  if (score <= 60) return '😐';
  if (score <= 75) return '😄';
  return '🤑';
}

function getTrend(current, previous) {
  if (!current || !previous) return 'ESTABLE';
  const diff = current - previous;
  if (diff > 5) return 'SUBIENDO';
  if (diff < -5) return 'BAJANDO';
  return 'ESTABLE';
}

module.exports = { fetchSentiment };
