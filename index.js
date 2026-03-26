require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { default: YahooFinance } = require('yahoo-finance2');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const { setupCron, updateDelay } = require('./scheduler');
const { runAnalysis, isRunning } = require('./services/orchestrator');
const db = require('./db');

// ─── Estado global de la aplicación ───────────────────────────────────────────
global.appState = {
  latestAnalysis: null,
  analysisHistory: [],
  settings: {
    delayMinutes: 30,
    enabled: true,
    pushTokens: [],
  },
};

// ─── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Auth middleware ────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  const provided = req.headers['x-api-secret'] || req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Existing Routes ────────────────────────────────────────────────────────

/** Health check */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasAnalysis: !!global.appState.latestAnalysis,
    isAnalyzing: isRunning(),
    settings: {
      delayMinutes: global.appState.settings.delayMinutes,
      enabled: global.appState.settings.enabled,
      devicesRegistered: global.appState.settings.pushTokens.length,
    },
  });
});

/** Obtener el último análisis */
app.get('/analysis/latest', (req, res) => {
  // Primero intentar cache en memoria, luego DB
  const analysis = global.appState.latestAnalysis || db.getLatestAnalysis();
  if (!analysis) {
    return res.json({
      analysis: null,
      message: 'Todavía no hay análisis. Presioná "Analizar Ahora" o esperá el horario automático.'
    });
  }
  res.json({ analysis });
});

/** Historial de análisis con filtros opcionales */
app.get('/analysis/history', (req, res) => {
  const { limit, offset, bias, ticker, outcome, from, to } = req.query;
  const history = db.getAnalysisHistory({
    limit: parseInt(limit) || 20,
    offset: parseInt(offset) || 0,
    bias, ticker, outcome, from, to,
  });
  res.json({ history });
});

/** Disparar análisis manual */
app.post('/analysis/trigger', requireSecret, async (req, res) => {
  if (isRunning()) {
    return res.status(409).json({
      error: 'Ya hay un análisis en curso. Esperá unos segundos.',
      isRunning: true
    });
  }

  res.json({
    message: 'Análisis iniciado. Tomará entre 15-30 segundos.',
    isRunning: true
  });

  runAnalysis({ manual: true }).catch(err => {
    console.error('[Server] Manual analysis error:', err.message);
  });
});

/** Estado del análisis (polling) */
app.get('/analysis/status', (req, res) => {
  res.json({
    isRunning: isRunning(),
    hasResult: !!global.appState.latestAnalysis,
    lastTimestamp: global.appState.latestAnalysis?._meta?.timestamp ?? null,
  });
});

/** Obtener settings */
app.get('/settings', (req, res) => {
  res.json({ settings: global.appState.settings });
});

/** Actualizar settings */
app.post('/settings', requireSecret, (req, res) => {
  const { delayMinutes, enabled } = req.body;

  if (delayMinutes !== undefined) {
    const delay = parseInt(delayMinutes);
    try {
      updateDelay(delay);
      global.appState.settings.delayMinutes = delay;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (enabled !== undefined) {
    global.appState.settings.enabled = Boolean(enabled);
    console.log(`[Settings] Auto-analysis ${global.appState.settings.enabled ? 'enabled' : 'disabled'}`);
  }

  res.json({
    message: 'Settings actualizados',
    settings: global.appState.settings
  });
});

/** Registrar push token */
app.post('/register-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requerido' });

  const tokens = global.appState.settings.pushTokens;
  if (!tokens.includes(token)) {
    tokens.push(token);
    console.log(`[Push] New token registered. Total: ${tokens.length}`);
  }
  res.json({ success: true, totalDevices: tokens.length });
});

/** Desregistrar push token */
app.delete('/register-token', (req, res) => {
  const { token } = req.body;
  const tokens = global.appState.settings.pushTokens;
  const idx = tokens.indexOf(token);
  if (idx > -1) tokens.splice(idx, 1);
  res.json({ success: true });
});

// ─── Nuevos endpoints: Recommendations ─────────────────────────────────────

/** Listar recomendaciones con filtros */
app.get('/recommendations', (req, res) => {
  const { outcome, ticker, limit, offset } = req.query;
  const recs = db.getRecommendations({
    outcome, ticker,
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0,
  });
  res.json({ recommendations: recs });
});

/** Obtener una recomendación por ID */
app.get('/recommendations/:id', (req, res) => {
  const rec = db.getRecommendation(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recomendación no encontrada' });
  res.json({ recommendation: rec });
});

/** Marcar recomendación como paper trade */
app.post('/recommendations/:id/paper-trade', (req, res) => {
  const rec = db.getRecommendation(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recomendación no encontrada' });
  db.setPaperTrade(req.params.id);
  res.json({ success: true, message: 'Paper trade registrado' });
});

/** Verificar outcome de una recomendación manualmente */
app.post('/recommendations/:id/check', requireSecret, async (req, res) => {
  try {
    const { checkSingleOutcome } = require('./services/outcomeChecker');
    const result = await checkSingleOutcome(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Nuevos endpoints: Performance ──────────────────────────────────────────

/** Stats de performance agregadas */
app.get('/performance', (req, res) => {
  const stats = db.getPerformanceStats();
  res.json({ performance: stats });
});

// ─── Nuevos endpoints: Paper Trades ──────────────────────────────────────────

/** Listar paper trades */
app.get('/paper-trades', (req, res) => {
  const trades = db.getPaperTrades();
  res.json({ trades });
});

/** Resumen de paper trading P&L */
app.get('/paper-trades/summary', (req, res) => {
  const summary = db.getPaperTradesSummary();
  res.json({ summary });
});

// ─── Nuevos endpoints: Charts ───────────────────────────────────────────────

/** Mini chart data para sparklines */
app.get('/chart/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const days = parseInt(req.query.days) || 5;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 1000));

      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - (days * 2));

      const result = await yahooFinance.chart(symbol, {
        period1: startDate,
        period2: endDate,
        interval: '1d',
      });

      const quotes = (result.quotes || []).slice(-days);
      const prices = quotes.map(q => q.close).filter(Boolean);
      const dates = quotes.map(q => q.date?.toISOString?.() || '');

      return res.json({ symbol, prices, dates });
    } catch (err) {
      if (attempt === 3) {
        console.error(`[Chart] Failed after 3 attempts for ${symbol}:`, err.message);
        return res.json({ symbol, prices: [], dates: [] }); // retorna vacío, no error 500
      }
    }
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  // Inicializar DB antes de todo
  await db.initDB();

  // Cargar último análisis de la DB
  const lastFromDb = db.getLatestAnalysis();
  if (lastFromDb) {
    global.appState.latestAnalysis = lastFromDb;
    console.log('[Server] Loaded latest analysis from DB');
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 Market Analyzer Server running on port ${PORT}`);
    console.log(`📅 Auto-analysis: Mon-Fri, ${global.appState.settings.delayMinutes}min after market open`);
    console.log(`🔑 API_SECRET: ${process.env.API_SECRET ? 'configured' : 'NOT configured (open access)'}\n`);

    setupCron();
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
