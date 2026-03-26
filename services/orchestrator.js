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

async function runAnalysis({ manual = false } = {}) {
  if (isRunning) {
    console.log('[Orchestrator] Analysis already running, skipping.');
    return null;
  }

  isRunning = true;
  const startTime = Date.now();
  console.log(`\n[Orchestrator] ===== Starting Analysis v2 (${manual ? 'MANUAL' : 'AUTO'}) =====`);

  try {
    if (!manual) {
      const marketStatus = isMarketOpenToday();
      if (!marketStatus.isOpen) {
        console.log(`[Orchestrator] Market closed today: ${marketStatus.reason}`);
        isRunning = false;
        return null;
      }
    }

    const delayMinutes = global.appState?.settings?.delayMinutes ?? 30;

    console.log('[Orchestrator] Stage 1: Fetching primary data in parallel...');

    const [marketData, news, sentiment, economicCalendar] = await parallelWithFallback([
      { fn: () => fetchMarketData(), fallback: null, label: 'marketData' },
      { fn: () => fetchNews(), fallback: { headlines: [], error: 'News unavailable' }, label: 'news' },
      { fn: () => fetchSentiment(), fallback: { score: null, rating: 'UNAVAILABLE', label: 'No disponible' }, label: 'sentiment' },
      { fn: () => fetchEconomicCalendar(), fallback: { events: [], highImpact: false, hasEvents: false, summary: 'No disponible', warningLevel: 'UNKNOWN' }, label: 'economicCalendar' },
    ]);

    if (!marketData) {
      throw new Error('Market data fetch failed completely — cannot proceed without core data');
    }

    console.log('[Orchestrator] Stage 1.5: Phase 1 - Identifying candidates...');

    const pastAnalyses = (global.appState?.analysisHistory ?? []).slice(0, 3);

    const phase1Result = await runPhaseOne({
      marketData, news, sentiment, economicCalendar, delayMinutes,
    }).catch(err => {
      console.error('[Orchestrator] Phase 1 failed:', err.message);
      return null;
    });

    const candidateSymbols = phase1Result?.candidates?.map(c => c.ticker) ?? [];
    const fallbackSymbols = [
      ...(marketData.gainers ?? []).slice(0, 5).map(g => g.symbol),
      ...(marketData.unusualVolume ?? []).slice(0, 3).map(u => u.symbol),
    ];
    const symbolsToAnalyze = candidateSymbols.length > 0
      ? [...new Set(candidateSymbols)]
      : [...new Set(fallbackSymbols)];

    console.log(`[Orchestrator] Stage 2: Fetching technicals + earnings for ${symbolsToAnalyze.length} symbols: ${symbolsToAnalyze.join(', ')}`);

    const [technicals, earningsRisk] = await parallelWithFallback([
      { fn: () => fetchTechnicalsForSymbols(symbolsToAnalyze), fallback: {}, label: 'technicals' },
      { fn: async () => flagEarningsRisk(symbolsToAnalyze), fallback: new Map(), label: 'earningsRisk' },
    ]);

    console.log('[Orchestrator] Stage 3: Phase 2 - Deep analysis...');

    const analysis = await analyzeWithClaude({
      marketData, news, sentiment, economicCalendar,
      technicals: technicals ?? {},
      earningsRisk: earningsRisk ?? new Map(),
      delayMinutes, pastAnalyses,
    });

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
      global.appState.analysisHistory = [result, ...(global.appState.analysisHistory ?? []).slice(0, 9)];
    }

    const tokens = global.appState?.settings?.pushTokens ?? [];
    await sendPushNotification(tokens, analysis);

    console.log(`[Orchestrator] ===== Analysis Complete in ${(duration / 1000).toFixed(1)}s =====`);
    console.log(`[Orchestrator] Symbols: ${symbolsToAnalyze.join(', ')}`);
    console.log(`[Orchestrator] Recommendations: ${analysis.recommendations?.length ?? 0}`);
    console.log(`[Orchestrator] Should trade: ${analysis.shouldTrade}`);

    return result;

  } catch (error) {
    console.error('[Orchestrator] Analysis failed:', error);

    const errorResult = {
      error: true,
      errorMessage: error.message,
      _meta: { triggeredBy: manual ? 'manual' : 'auto', timestamp: new Date().toISOString() },
    };

    if (global.appState) global.appState.latestAnalysis = errorResult;
    throw error;

  } finally {
    isRunning = false;
  }
}

module.exports = { runAnalysis, isRunning: () => isRunning };
