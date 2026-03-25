const { fetchMarketData } = require('./marketData');
const { fetchNews } = require('./news');
const { fetchSentiment } = require('./sentiment');
const { fetchEconomicCalendar } = require('./economicCalendar');
const { fetchTechnicalsForSymbols } = require('./technicals');
const { flagEarningsRisk } = require('./earningsAndLiquidity');
const { analyzeWithClaude, runPhaseOne } = require('./claude');
const { sendPushNotification } = require('./push');
const { isMarketOpenToday } = require('../utils/holidays');
const { parallelWithFallback } = require('../utils/retry');

let isRunning = false;

/**
 * Pipeline completo de análisis con los 10 puntos de mejora:
 *
 * 1. Indicadores técnicos reales (RSI, MACD, BB, EMAs, ATR, VWAP)
 * 2. Calendario económico (Finnhub)
 * 3. Earnings calendar + filtro de liquidez
 * 4. Análisis en dos fases con Claude
 * 5. Datos pre-market
 * 6. Market breadth
 * 7. Retry logic con backoff exponencial
 * 8. Validación del output de Claude
 * 9. Memoria de análisis anteriores
 * 10. Score de liquidez mínima (en filterByLiquidity)
 */
async function runAnalysis({ manual = false } = {}) {
  if (isRunning) {
    console.log('[Orchestrator] Analysis already running, skipping.');
    return null;
  }

  isRunning = true;
  const startTime = Date.now();
  console.log(`\n[Orchestrator] ===== Starting Analysis v2 (${manual ? 'MANUAL' : 'AUTO'}) =====`);

  try {
    // Verificar si el mercado opera hoy (solo para análisis automáticos)
    if (!manual) {
      const marketStatus = isMarketOpenToday();
      if (!marketStatus.isOpen) {
        console.log(`[Orchestrator] Market closed today: ${marketStatus.reason}`);
        isRunning = false;
        return null;
      }
    }

    const delayMinutes = global.appState?.settings?.delayMinutes ?? 30;

    // ─── ETAPA 1: Datos primarios en paralelo ─────────────────────────────────
    // Todos con fallback individual — un fallo no rompe todo (PUNTO 7)
    console.log('[Orchestrator] Stage 1: Fetching primary data in parallel...');

    const [marketData, news, sentiment, economicCalendar] = await parallelWithFallback([
      {
        fn: () => fetchMarketData(),
        fallback: null,
        label: 'marketData',
      },
      {
        fn: () => fetchNews(),
        fallback: { headlines: [], error: 'News unavailable' },
        label: 'news',
      },
      {
        fn: () => fetchSentiment(),
        fallback: { score: null, rating: 'UNAVAILABLE', label: 'No disponible' },
        label: 'sentiment',
      },
      {
        // PUNTO 2: Calendario económico
        fn: () => fetchEconomicCalendar(),
        fallback: { events: [], highImpact: false, hasEvents: false, summary: 'No disponible', warningLevel: 'UNKNOWN' },
        label: 'economicCalendar',
      },
    ]);

    if (!marketData) {
      throw new Error('Market data fetch failed completely — cannot proceed without core data');
    }

    // ─── ETAPA 1.5: Fase 1 de Claude para identificar candidatos ──────────────
    // Necesitamos los candidatos ANTES de buscar sus técnicos (PUNTO 4)
    console.log('[Orchestrator] Stage 1.5: Phase 1 - Identifying candidates...');

    // PUNTO 9: Memoria de análisis anteriores
    const pastAnalyses = (global.appState?.analysisHistory ?? []).slice(0, 3);

    const phase1Result = await runPhaseOne({
      marketData,
      news,
      sentiment,
      economicCalendar,
      delayMinutes,
    }).catch(err => {
      console.error('[Orchestrator] Phase 1 failed:', err.message);
      return null;
    });

    // ─── ETAPA 2: Datos secundarios basados en candidatos de Fase 1 ───────────
    const candidateSymbols = phase1Result?.candidates?.map(c => c.ticker) ?? [];
    // Si no hay candidatos de fase 1, tomar top gainers + unusual volume como fallback
    const fallbackSymbols = [
      ...(marketData.gainers ?? []).slice(0, 5).map(g => g.symbol),
      ...(marketData.unusualVolume ?? []).slice(0, 3).map(u => u.symbol),
    ];
    const symbolsToAnalyze = candidateSymbols.length > 0
      ? [...new Set(candidateSymbols)]
      : [...new Set(fallbackSymbols)];

    console.log(`[Orchestrator] Stage 2: Fetching technicals + earnings for ${symbolsToAnalyze.length} symbols: ${symbolsToAnalyze.join(', ')}`);

    const [technicals, earningsRisk] = await parallelWithFallback([
      {
        // PUNTO 1: Indicadores técnicos
        fn: () => fetchTechnicalsForSymbols(symbolsToAnalyze),
        fallback: {},
        label: 'technicals',
      },
      {
        // PUNTO 3: Earnings risk
        fn: async () => {
          const riskMap = await flagEarningsRisk(symbolsToAnalyze);
          return riskMap;
        },
        fallback: new Map(),
        label: 'earningsRisk',
      },
    ]);

    // ─── ETAPA 3: Análisis completo con Claude (Fase 2) ───────────────────────
    console.log('[Orchestrator] Stage 3: Phase 2 - Deep analysis...');

    const analysis = await analyzeWithClaude({
      marketData,
      news,
      sentiment,
      economicCalendar,
      technicals: technicals ?? {},
      earningsRisk: earningsRisk ?? new Map(),
      delayMinutes,
      pastAnalyses,
    });

    // ─── ETAPA 4: Guardar y notificar ─────────────────────────────────────────
    const duration = Date.now() - startTime;
    const result = {
      ...analysis,
      _meta: {
        triggeredBy: manual ? 'manual' : 'auto',
        durationMs: duration,
        timestamp: new Date().toISOString(),
        symbolsAnalyzed: symbolsToAnalyze,
        dataQuality: {
          hasEconomicCalendar: economicCalendar?.hasEvents ?? false,
          hasNews: (news?.headlines?.length ?? 0) > 0,
          hasTechnicals: Object.values(technicals ?? {}).filter(Boolean).length,
          hasEarningsData: (earningsRisk instanceof Map) && earningsRisk.size > 0,
        },
      },
    };

    if (global.appState) {
      global.appState.latestAnalysis = result;
      global.appState.analysisHistory = [
        result,
        ...(global.appState.analysisHistory ?? []).slice(0, 9),
      ];
    }

    // Push notification
    const tokens = global.appState?.settings?.pushTokens ?? [];
    await sendPushNotification(tokens, analysis);

    console.log(`[Orchestrator] ===== Analysis Complete in ${(duration / 1000).toFixed(1)}s =====`);
    console.log(`[Orchestrator] Symbols: ${symbolsToAnalyze.join(', ')}`);
    console.log(`[Orchestrator] Recommendations: ${analysis.recommendations?.length ?? 0}`);
    console.log(`[Orchestrator] Should trade: ${analysis.shouldTrade}`);
    console.log('');

    return result;

  } catch (error) {
    console.error('[Orchestrator] Analysis failed:', error);

    const errorResult = {
      error: true,
      errorMessage: error.message,
      _meta: {
        triggeredBy: manual ? 'manual' : 'auto',
        timestamp: new Date().toISOString(),
      },
    };

    if (global.appState) {
      global.appState.latestAnalysis = errorResult;
    }

    throw error;

  } finally {
    isRunning = false;
  }
}

module.exports = { runAnalysis, isRunning: () => isRunning };
