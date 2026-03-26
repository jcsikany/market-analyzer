require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { setupCron, updateDelay } = require('./scheduler');
const { runAnalysis, isRunning } = require('./services/orchestrator');

// ─── Estado global de la aplicación ───────────────────────────────────────────
global.appState = {
  latestAnalysis: null,
  analysisHistory: [],
  settings: {
    delayMinutes: 30,       // Minutos después de la apertura de Wall Street
    enabled: true,          // Análisis automático activado
    pushTokens: [],         // Tokens de dispositivos registrados
  },
};

// ─── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Logging de requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Auth middleware (para endpoints sensibles) ────────────────────────────────
function requireSecret(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // Si no hay secret configurado, no bloquear
  const provided = req.headers['x-api-secret'] || req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Routes ────────────────────────────────────────────────────────────────────

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
  const analysis = global.appState.latestAnalysis;
  if (!analysis) {
    return res.json({
      analysis: null,
      message: 'Todavía no hay análisis. Presioná "Analizar Ahora" o esperá el horario automático.'
    });
  }
  res.json({ analysis });
});

/** Historial de análisis (últimos 10) */
app.get('/analysis/history', (req, res) => {
  res.json({ history: global.appState.analysisHistory });
});

/** Disparar análisis manual */
app.post('/analysis/trigger', requireSecret, async (req, res) => {
  if (isRunning()) {
    return res.status(409).json({
      error: 'Ya hay un análisis en curso. Esperá unos segundos.',
      isRunning: true
    });
  }

  // Responder inmediatamente y correr el análisis en background
  res.json({
    message: 'Análisis iniciado. Tomará entre 15-30 segundos.',
    isRunning: true
  });

  runAnalysis({ manual: true }).catch(err => {
    console.error('[Server] Manual analysis error:', err.message);
  });
});

/** Estado del análisis (polling mientras corre) */
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

/** Registrar push token de dispositivo */
app.post('/register-token', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token requerido' });
  }

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

// ─── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🚀 Market Analyzer Server running on port ${PORT}`);
  console.log(`📅 Auto-analysis: Mon-Fri, ${global.appState.settings.delayMinutes}min after market open`);
  console.log(`🔑 API_SECRET: ${process.env.API_SECRET ? 'configured' : 'NOT configured (open access)'}\n`);

  // Iniciar cron scheduler
  setupCron();
});

module.exports = app;
