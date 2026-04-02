const initSqlJs = require('sql.js');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── Inicialización ──────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'market-analyzer.db');
let db = null;

// Guardar a disco periódicamente
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (db) {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    }
  }, 2000);
}

// Init síncrono via promise bloqueante al require (se resuelve antes de que el server arranque)
let initPromise = null;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[DB] Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database');
  }

  // Crear tablas
  db.run(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      market_bias TEXT,
      risk_level TEXT,
      should_trade INTEGER NOT NULL DEFAULT 0,
      no_trade_reason TEXT,
      market_summary TEXT,
      key_theme TEXT,
      dominant_sectors TEXT,
      duration_ms INTEGER,
      data_quality TEXT,
      full_json TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      analysis_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      name TEXT,
      action TEXT,
      entry_low REAL,
      entry_high REAL,
      target REAL,
      stop_loss REAL,
      rr_ratio TEXT,
      confidence TEXT,
      time_horizon TEXT,
      catalyst TEXT,
      technical_setup TEXT,
      key_points TEXT,
      risk_warnings TEXT,
      potential_gain_pct TEXT,
      potential_loss_pct TEXT,
      generated_at TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'PENDING',
      outcome_checked_at TEXT,
      outcome_price REAL,
      outcome_details TEXT,
      confluence_score INTEGER,
      confluence_details TEXT,
      paper_trade_taken INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (analysis_id) REFERENCES analyses(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS performance_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL,
      total_recs INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      partials INTEGER NOT NULL DEFAULT 0,
      expired INTEGER NOT NULL DEFAULT 0,
      avg_gain_pct REAL,
      avg_loss_pct REAL,
      win_rate REAL,
      profit_factor REAL,
      best_trade TEXT,
      worst_trade TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      token TEXT PRIMARY KEY,
      registered_at TEXT NOT NULL
    )
  `);

  // Crear índices
  try { db.run('CREATE INDEX IF NOT EXISTS idx_rec_outcome ON recommendations(outcome)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_rec_ticker ON recommendations(ticker)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_rec_analysis ON recommendations(analysis_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_analyses_timestamp ON analyses(timestamp DESC)'); } catch {}

  // Guardar DB inicial a disco
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));

  console.log('[DB] SQLite initialized at', DB_PATH);
  return db;
}

// Helper: ejecutar query y obtener filas como objetos
function queryAll(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function runSql(sql, params = []) {
  if (!db) return;
  db.run(sql, params);
  scheduleSave();
}

// ─── Funciones públicas ──────────────────────────────────────────────────────

function saveAnalysis(result) {
  const meta = result._meta || {};
  const timestamp = meta.timestamp || new Date().toISOString();

  runSql(`
    INSERT INTO analyses (timestamp, triggered_by, market_bias, risk_level, should_trade,
      no_trade_reason, market_summary, key_theme, dominant_sectors, duration_ms, data_quality, full_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    timestamp,
    meta.triggeredBy || 'manual',
    result.marketBias || null,
    result.riskLevel || null,
    result.shouldTrade ? 1 : 0,
    result.noTradeReason || null,
    result.marketSummary || null,
    result.keyTheme || null,
    JSON.stringify(result.dominantSectors || []),
    meta.durationMs || null,
    JSON.stringify(meta.dataQuality || {}),
    JSON.stringify(result),
  ]);

  // Obtener el ID del análisis recién insertado
  const analysisId = queryOne('SELECT last_insert_rowid() as id')?.id;

  const recs = result.recommendations || [];
  const recsWithIds = recs.map(rec => {
    const recId = randomUUID();
    runSql(`
      INSERT INTO recommendations (id, analysis_id, ticker, name, action, entry_low, entry_high,
        target, stop_loss, rr_ratio, confidence, time_horizon, catalyst, technical_setup,
        key_points, risk_warnings, potential_gain_pct, potential_loss_pct, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      recId, analysisId,
      rec.ticker || '', rec.name || '', rec.action || '',
      rec.entryLow ?? null, rec.entryHigh ?? null,
      rec.target ?? null, rec.stopLoss ?? null,
      rec.rrRatio || null, rec.confidence || null, rec.timeHorizon || null,
      rec.catalyst || null, rec.technicalSetup || null,
      JSON.stringify(rec.keyPoints || []), JSON.stringify(rec.riskWarnings || []),
      rec.potentialGainPct || null, rec.potentialLossPct || null,
      timestamp,
    ]);
    return { ...rec, _id: recId };
  });

  console.log(`[DB] Saved analysis #${analysisId} with ${recsWithIds.length} recommendations`);

  return {
    ...result,
    _dbId: analysisId,
    recommendations: recsWithIds,
  };
}

function getLatestAnalysis() {
  const row = queryOne('SELECT * FROM analyses ORDER BY id DESC LIMIT 1');
  if (!row) return null;
  return hydrateAnalysis(row);
}

function getAnalysisHistory({ limit = 20, offset = 0, bias, ticker, outcome, from, to } = {}) {
  let sql = 'SELECT * FROM analyses WHERE 1=1';
  const params = [];

  if (bias) { sql += ' AND market_bias = ?'; params.push(bias); }
  if (from) { sql += ' AND timestamp >= ?'; params.push(from); }
  if (to) { sql += ' AND timestamp <= ?'; params.push(to); }
  if (ticker) { sql += ' AND id IN (SELECT analysis_id FROM recommendations WHERE ticker = ?)'; params.push(ticker.toUpperCase()); }
  if (outcome) { sql += ' AND id IN (SELECT analysis_id FROM recommendations WHERE outcome = ?)'; params.push(outcome); }

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return queryAll(sql, params).map(hydrateAnalysis);
}

function getRecommendations({ outcome, ticker, limit = 50, offset = 0 } = {}) {
  let sql = 'SELECT * FROM recommendations WHERE 1=1';
  const params = [];

  if (outcome) { sql += ' AND outcome = ?'; params.push(outcome); }
  if (ticker) { sql += ' AND ticker = ?'; params.push(ticker.toUpperCase()); }

  sql += ' ORDER BY generated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return queryAll(sql, params).map(hydrateRecommendation);
}

function getRecommendation(id) {
  const row = queryOne('SELECT * FROM recommendations WHERE id = ?', [id]);
  return row ? hydrateRecommendation(row) : null;
}

function getPendingExpiredRecommendations() {
  const rows = queryAll("SELECT * FROM recommendations WHERE outcome = 'PENDING'");
  const now = new Date();

  return rows.filter(row => {
    const genDate = new Date(row.generated_at);
    const daysToWait = parseTimeHorizon(row.time_horizon || '');
    const checkDate = new Date(genDate.getTime() + daysToWait * 24 * 60 * 60 * 1000);
    return now >= checkDate;
  }).map(hydrateRecommendation);
}

function updateRecommendationOutcome(id, { outcome, price, details }) {
  runSql(`
    UPDATE recommendations SET outcome = ?, outcome_checked_at = ?,
      outcome_price = ?, outcome_details = ? WHERE id = ?
  `, [outcome, new Date().toISOString(), price ?? null, JSON.stringify(details || {}), id]);
}

function setPaperTrade(id) {
  runSql('UPDATE recommendations SET paper_trade_taken = 1 WHERE id = ?', [id]);
}

function updateConfluence(id, score, details) {
  runSql('UPDATE recommendations SET confluence_score = ?, confluence_details = ? WHERE id = ?',
    [score, JSON.stringify(details || {}), id]);
}

function savePerformanceStats(stats) {
  runSql(`
    INSERT INTO performance_stats (computed_at, total_recs, wins, losses, partials, expired,
      avg_gain_pct, avg_loss_pct, win_rate, profit_factor, best_trade, worst_trade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    new Date().toISOString(),
    stats.totalRecs || 0, stats.wins || 0, stats.losses || 0,
    stats.partials || 0, stats.expired || 0,
    stats.avgGainPct ?? null, stats.avgLossPct ?? null,
    stats.winRate ?? null, stats.profitFactor ?? null,
    JSON.stringify(stats.bestTrade || null), JSON.stringify(stats.worstTrade || null),
  ]);
}

function getPerformanceStats() {
  const row = queryOne('SELECT * FROM performance_stats ORDER BY id DESC LIMIT 1');
  if (!row) return null;
  return {
    computedAt: row.computed_at,
    totalRecs: row.total_recs,
    wins: row.wins,
    losses: row.losses,
    partials: row.partials,
    expired: row.expired,
    avgGainPct: row.avg_gain_pct,
    avgLossPct: row.avg_loss_pct,
    winRate: row.win_rate,
    profitFactor: row.profit_factor,
    bestTrade: safeParseJSON(row.best_trade),
    worstTrade: safeParseJSON(row.worst_trade),
  };
}

function getPaperTrades() {
  return queryAll('SELECT * FROM recommendations WHERE paper_trade_taken = 1 ORDER BY generated_at DESC')
    .map(hydrateRecommendation);
}

function getPaperTradesSummary() {
  const trades = getPaperTrades();
  const resolved = trades.filter(t => t.outcome !== 'PENDING');

  if (resolved.length === 0) {
    return { totalTaken: trades.length, resolved: 0, wins: 0, losses: 0, netPnlPct: 0, winRate: 0 };
  }

  const wins = resolved.filter(t => t.outcome === 'HIT_TARGET');
  const losses = resolved.filter(t => t.outcome === 'STOPPED_OUT');

  const totalGain = wins.reduce((sum, t) => {
    const details = t.outcomeDetails || {};
    return sum + (details.actualGainPct || parseFloat(t.potentialGainPct) || 0);
  }, 0);

  const totalLoss = losses.reduce((sum, t) => {
    const details = t.outcomeDetails || {};
    return sum + (details.actualLossPct || parseFloat(t.potentialLossPct) || 0);
  }, 0);

  return {
    totalTaken: trades.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    partials: resolved.filter(t => t.outcome === 'PARTIAL').length,
    expired: resolved.filter(t => t.outcome === 'EXPIRED').length,
    netPnlPct: parseFloat((totalGain - totalLoss).toFixed(2)),
    winRate: parseFloat(((wins.length / resolved.length) * 100).toFixed(1)),
  };
}

// ─── Helpers internos ────────────────────────────────────────────────────────

function hydrateAnalysis(row) {
  const full = safeParseJSON(row.full_json) || {};
  const recs = queryAll('SELECT * FROM recommendations WHERE analysis_id = ? ORDER BY confidence DESC', [row.id])
    .map(hydrateRecommendation);

  return {
    ...full,
    _dbId: row.id,
    recommendations: recs,
  };
}

function hydrateRecommendation(row) {
  return {
    _id: row.id,
    ticker: row.ticker,
    name: row.name,
    action: row.action,
    entryLow: row.entry_low,
    entryHigh: row.entry_high,
    target: row.target,
    stopLoss: row.stop_loss,
    rrRatio: row.rr_ratio,
    confidence: row.confidence,
    timeHorizon: row.time_horizon,
    catalyst: row.catalyst,
    technicalSetup: row.technical_setup,
    keyPoints: safeParseJSON(row.key_points) || [],
    riskWarnings: safeParseJSON(row.risk_warnings) || [],
    potentialGainPct: row.potential_gain_pct,
    potentialLossPct: row.potential_loss_pct,
    generatedAt: row.generated_at,
    outcome: row.outcome,
    outcomeCheckedAt: row.outcome_checked_at,
    outcomePrice: row.outcome_price,
    outcomeDetails: safeParseJSON(row.outcome_details),
    confluenceScore: row.confluence_score,
    confluenceDetails: safeParseJSON(row.confluence_details),
    paperTradeTaken: !!row.paper_trade_taken,
  };
}

function parseTimeHorizon(horizon) {
  const h = (horizon || '').toUpperCase();
  if (h.includes('INTRADAY') || h.includes('INTRADÍA')) return 1;
  if (h.includes('1-3')) return 3;
  if (h.includes('1-2 SEMANA') || h.includes('SWING')) return 14;
  if (h.includes('2-4 SEMANA')) return 28;
  return 5;
}

function safeParseJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

// ─── Push Tokens ────────────────────────────────────────────────────────────

function savePushToken(token) {
  runSql('INSERT OR IGNORE INTO push_tokens (token, registered_at) VALUES (?, ?)', [token, new Date().toISOString()]);
}

function removePushToken(token) {
  runSql('DELETE FROM push_tokens WHERE token = ?', [token]);
}

function getAllPushTokens() {
  return queryAll('SELECT token FROM push_tokens').map(r => r.token);
}

// ─── Export ──────────────────────────────────────────────────────────────────

// initDB() debe llamarse antes de usar cualquier función
module.exports = {
  initDB,
  saveAnalysis,
  getLatestAnalysis,
  getAnalysisHistory,
  getRecommendations,
  getRecommendation,
  getPendingExpiredRecommendations,
  updateRecommendationOutcome,
  setPaperTrade,
  updateConfluence,
  savePerformanceStats,
  getPerformanceStats,
  getPaperTrades,
  getPaperTradesSummary,
  parseTimeHorizon,
  savePushToken,
  removePushToken,
  getAllPushTokens,
};
