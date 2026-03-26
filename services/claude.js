const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('../utils/retry');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-6';

async function phaseOne({ marketData, news, sentiment, economicCalendar, macroData, delayMinutes }) {
  console.log('[Claude Phase 1] Identifying top candidates...');
  const prompt = buildPhaseOnePrompt({ marketData, news, sentiment, economicCalendar, macroData, delayMinutes });
  const message = await withRetry(() => client.messages.create({
    model: MODEL, max_tokens: 1024,
    system: `Sos un trader profesional de Wall Street con 20+ años de experiencia en análisis técnico y fundamental.
Tu tarea en esta fase es identificar los MEJORES CANDIDATOS del día — no hacer el análisis completo todavía.
Respondés SIEMPRE en JSON válido sin texto adicional ni markdown.`,
    messages: [{ role: 'user', content: prompt }],
  }), { label: 'claude-phase1', retries: 2 });
  return parseJSON(message.content[0]?.text, 'phase1');
}

async function phaseTwo({ phase1Result, technicals, earningsRisk, pastAnalyses }) {
  console.log('[Claude Phase 2] Deep analysis on candidates...');
  const prompt = buildPhaseTwoPrompt({ phase1Result, technicals, earningsRisk, pastAnalyses });
  const message = await withRetry(() => client.messages.create({
    model: MODEL, max_tokens: 2048,
    system: `Sos un trader profesional de Wall Street con 20+ años de experiencia.
Basándote en el preanalisis y los datos técnicos detallados, generás las recomendaciones FINALES con niveles precisos.
Respondés SIEMPRE en JSON válido sin texto adicional ni markdown.
Sos conservador: si un setup no es claro o el riesgo es alto, no lo incluís.`,
    messages: [{ role: 'user', content: prompt }],
  }), { label: 'claude-phase2', retries: 2 });
  return parseJSON(message.content[0]?.text, 'phase2');
}

async function analyzeWithClaude({ marketData, news, sentiment, economicCalendar, macroData, technicals, earningsRisk, insiderData, delayMinutes = 30, pastAnalyses = [] }) {
  const startTime = Date.now();
  const phase1 = await phaseOne({ marketData, news, sentiment, economicCalendar, macroData, delayMinutes });

  if (!phase1 || phase1.error) {
    throw new Error('Phase 1 analysis failed: ' + (phase1?.error || 'unknown'));
  }

  if (phase1.shouldTrade === false) {
    console.log('[Claude] Phase 1 says NO TRADE. Skipping Phase 2.');
    return buildFinalResult(phase1, [], earningsRisk, startTime);
  }

  const candidates = phase1.candidates ?? [];
  const candidateTechnicals = {};
  candidates.forEach(c => { if (technicals[c.ticker]) candidateTechnicals[c.ticker] = technicals[c.ticker]; });

  const phase2 = await phaseTwo({ phase1Result: phase1, technicals: candidateTechnicals, earningsRisk, insiderData, macroData, pastAnalyses });

  if (!phase2 || phase2.error) console.warn('[Claude] Phase 2 failed, using Phase 1 context only.');

  const validatedRecs = validateAndFixRecommendations(phase2?.recommendations ?? []);
  const finalRecs = applyEarningsWarnings(validatedRecs, earningsRisk);

  return {
    marketSummary: phase2?.marketSummary ?? phase1.marketSummary,
    marketBias: phase2?.marketBias ?? phase1.marketBias,
    riskLevel: phase2?.riskLevel ?? phase1.riskLevel,
    shouldTrade: phase2?.shouldTrade ?? phase1.shouldTrade,
    noTradeReason: phase2?.noTradeReason ?? phase1.noTradeReason,
    dominantSectors: phase2?.dominantSectors ?? phase1.dominantSectors ?? [],
    keyTheme: phase2?.keyTheme ?? phase1.keyTheme,
    recommendations: finalRecs,
    phase1Candidates: candidates,
    generatedAt: new Date().toISOString(),
    analysisMs: Date.now() - startTime,
  };
}

function validateAndFixRecommendations(recs) {
  if (!Array.isArray(recs)) return [];
  return recs.map(rec => {
    const issues = [];
    let fixed = { ...rec };
    const entry = (rec.entryLow + rec.entryHigh) / 2;

    if (rec.action === 'COMPRAR' && rec.target <= rec.entryHigh) {
      issues.push(`Target $${rec.target} ≤ entrada $${rec.entryHigh} — inválido`);
      fixed.target = parseFloat((rec.entryHigh * 1.05).toFixed(2));
    }
    if (rec.action === 'COMPRAR' && rec.stopLoss >= rec.entryLow) {
      issues.push(`Stop $${rec.stopLoss} ≥ entrada $${rec.entryLow} — inválido`);
      fixed.stopLoss = parseFloat((rec.entryLow * 0.97).toFixed(2));
    }

    if (fixed.target && fixed.stopLoss && entry) {
      const potGain = ((fixed.target - entry) / entry) * 100;
      const potLoss = ((entry - fixed.stopLoss) / entry) * 100;
      const rrCalculated = potGain / potLoss;
      const declaredRR = parseFloat(rec.rrRatio?.replace(':1', '') ?? '0');

      if (Math.abs(rrCalculated - declaredRR) / declaredRR > 0.30) {
        issues.push(`R/R declarado ${rec.rrRatio} vs calculado ${rrCalculated.toFixed(1)}:1 — corregido`);
      }
      fixed.rrRatio = `${rrCalculated.toFixed(1)}:1`;
      fixed.potentialGainPct = `${potGain.toFixed(1)}%`;
      fixed.potentialLossPct = `${potLoss.toFixed(1)}%`;

      if (rrCalculated < 1.5) {
        console.warn(`[Validation] Dropping ${rec.ticker}: R/R ${rrCalculated.toFixed(2)}:1 < 1.5 minimum`);
        return null;
      }
    }

    if (issues.length > 0) {
      console.log(`[Validation] ${rec.ticker}: ${issues.join(' | ')}`);
      fixed.validationNotes = issues;
    }
    return fixed;
  }).filter(Boolean);
}

function applyEarningsWarnings(recs, earningsRisk) {
  if (!earningsRisk || !(earningsRisk instanceof Map)) return recs;
  return recs.map(rec => {
    const earnings = earningsRisk.get(rec.ticker);
    if (!earnings) return rec;
    return {
      ...rec,
      earningsRisk: { level: earnings.risk, date: earnings.earningsDate, message: earnings.message },
      riskWarnings: [earnings.message, ...(rec.riskWarnings ?? [])],
      confidence: earnings.risk === 'CRÍTICO' ? 'MEDIA' : rec.confidence,
    };
  });
}

function buildFinalResult(phase1, recs, earningsRisk, startTime) {
  return {
    marketSummary: phase1.marketSummary,
    marketBias: phase1.marketBias,
    riskLevel: phase1.riskLevel,
    shouldTrade: false,
    noTradeReason: phase1.noTradeReason,
    dominantSectors: phase1.dominantSectors ?? [],
    keyTheme: phase1.keyTheme,
    recommendations: [],
    generatedAt: new Date().toISOString(),
    analysisMs: Date.now() - startTime,
  };
}

function buildMemoryContext(pastAnalyses) {
  if (!pastAnalyses?.length) return '';
  const recent = pastAnalyses.slice(0, 3);
  const lines = recent.map(a => {
    const date = new Date(a.generatedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const recs = (a.recommendations ?? []).map(r =>
      `${r.ticker} (entrada ~$${r.entryLow}-${r.entryHigh}, target $${r.target}, stop $${r.stopLoss})`
    ).join(', ') || 'Sin recomendaciones';
    return `  [${date}] Bias: ${a.marketBias} | Riesgo: ${a.riskLevel} | Recomendaciones: ${recs}`;
  });
  return `\n═══════════════════════════════════════\n🧠 CONTEXTO DE ANÁLISIS ANTERIORES (últimos ${recent.length} días hábiles)\n═══════════════════════════════════════\n${lines.join('\n')}\n\nUsá este contexto para identificar tendencias y ajustar el sesgo.\n`;
}

function buildPhaseOnePrompt({ marketData, news, sentiment, economicCalendar, macroData, delayMinutes }) {
  const etTime = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
  const { indices, vix, sectors, gainers, unusualVolume, gapAnalysis, preMarket, breadth } = marketData;

  const indicesSection = Object.entries(indices).map(([sym, d]) => {
    const gap = gapAnalysis[sym];
    const pre = preMarket?.byIndex?.[sym];
    return `  ${sym}: $${d.price?.toFixed(2)} ${fmtPct(d.changePct)} | Gap: ${gap?.direction ?? 'N/A'} ${gap?.gap ?? ''}% | Pre-mkt: ${fmtPct(pre?.preMarketChangePct)} (${pre?.preVsOpen ?? 'N/A'})`;
  }).join('\n');

  const sectorsSection = sectors.map(s => `  ${s.name.padEnd(18)}: ${fmtPct(s.changePct)}`).join('\n');
  const gainersSection = gainers.slice(0, 8).map(g => `  ${g.symbol.padEnd(8)} ${fmtPct(g.changePct).padStart(8)} | $${g.price?.toFixed(2)} | Vol: ${fmtVol(g.volume)}`).join('\n');
  const unusualVolSection = unusualVolume.slice(0, 8).map(g => `  ${g.symbol.padEnd(8)} ${fmtPct(g.changePct).padStart(8)} | Vol ratio: ${g.volumeRatio}x`).join('\n');
  const newsSection = (news.headlines ?? []).slice(0, 12).map(n => `  [${n.sentiment}] ${n.title} (${n.source})`).join('\n');
  const econSection = economicCalendar?.events?.length
    ? economicCalendar.events.slice(0, 8).map(e => `  [${e.impact}] ${e.event} ${e.time} — ${e.actual != null ? `Actual: ${e.actual}` : 'Pendiente'} ${e.surprise ? `(${e.surprise})` : ''}`).join('\n')
    : '  Sin eventos económicos relevantes hoy';

  return `ANÁLISIS DE MERCADO — FASE 1: IDENTIFICACIÓN DE CANDIDATOS
Hora ET: ${etTime} (${delayMinutes}min después de apertura)

ÍNDICES PRINCIPALES
${indicesSection}

Pre-market consensus: ${preMarket?.consensus ?? 'N/A'} | Avg: ${fmtPct(preMarket?.avgPreMarketPct)}
Amplitud: ${breadth?.breadthSignal ?? 'N/A'} | Sectores en verde: ${breadth?.sectorBreadth?.pct ?? 'N/A'}%
VIX: ${vix ? `${vix.value?.toFixed(2)} (${fmtPct(vix.changePct)}) → ${vix.interpretation}` : 'N/A'}
Fear & Greed: ${sentiment.score != null ? `${sentiment.score}/100 — ${sentiment.rating}` : 'N/A'}

SECTORES (mejor → peor)
${sectorsSection}

MAYORES GANADORAS
${gainersSection}

VOLUMEN INUSUAL (>2x promedio)
${unusualVolSection || '  Sin volumen inusual'}

CALENDARIO ECONÓMICO HOY
${econSection}
${economicCalendar?.summary ? `→ ${economicCalendar.summary}` : ''}

NOTICIAS (últimas 18h)
${newsSection}
${macroData?.summary ? `\nENTORNO MACROECONÓMICO (FRED)\n  ${macroData.summary}\n  Señal: ${macroData.macroSignal?.signal ?? 'N/A'}\n  ${(macroData.macroSignal?.reasons ?? []).map(r => '  → ' + r).join('\n') || ''}` : ''}

INSTRUCCIONES FASE 1:
Analizá el contexto global y seleccioná hasta 5 candidatos con mayor potencial.
En esta fase NO calculés niveles exactos — solo identificá los mejores setups.
Sé selectivo: preferís 2 candidatos sólidos a 5 mediocres.

RESPONDÉ SOLO CON ESTE JSON:
{
  "marketSummary": "Resumen ejecutivo en 2-3 oraciones",
  "marketBias": "ALCISTA|BAJISTA|NEUTRAL|MIXTO",
  "riskLevel": "BAJO|MEDIO|ALTO|EXTREMO",
  "shouldTrade": true,
  "noTradeReason": null,
  "dominantSectors": ["sector1"],
  "keyTheme": "Tema principal del día",
  "candidates": [
    {
      "ticker": "AAPL",
      "name": "Apple Inc.",
      "type": "ACCIÓN|ETF",
      "whyCandidate": "Razón concisa por qué es candidato hoy",
      "catalystType": "TÉCNICO|FUNDAMENTAL|AMBOS|MOMENTUM",
      "urgency": "ALTA|MEDIA"
    }
  ]
}`;
}

function buildPhaseTwoPrompt({ phase1Result, technicals, earningsRisk, insiderData, macroData, pastAnalyses }) {
  const memoryContext = buildMemoryContext(pastAnalyses);
  const techSection = Object.entries(technicals).map(([sym, t]) => {
    if (!t) return `  ${sym}: Datos técnicos no disponibles`;
    const earningsInfo = earningsRisk instanceof Map && earningsRisk.has(sym)
      ? `\n  ⚠ EARNINGS: ${earningsRisk.get(sym).message}` : '';
    return `
  ── ${sym} ──────────────────────────
  Precio actual: $${t.currentPrice} | ATR(14): $${t.atr} (${t.atrPct}% del precio)
  RSI(14): ${t.rsi} → ${t.rsiSignal}
  MACD: Línea ${t.macdLine} | Señal ${t.macdSignal} | Histograma ${t.macdHistogram} → ${t.macdCrossover}
  Bollinger Bands: Upper $${t.bbUpper} | Mid $${t.bbMiddle} | Lower $${t.bbLower} → ${t.bbPosition}
  EMAs: 9=$${t.ema9} | 21=$${t.ema21} | 50=$${t.ema50} | 200=$${t.sma200 ?? 'N/A'}
  Tendencia EMAs: ${t.trendAlignment}
  VWAP estimado: $${t.vwap} | Precio ${t.aboveVwap ? 'SOBRE' : 'BAJO'} VWAP
  Señal general: ${t.overallSignal} — ${t.overallReason}
  Factores alcistas: ${(t.bullishFactors ?? []).join('; ') || 'Ninguno'}
  Factores bajistas: ${(t.bearishFactors ?? []).join('; ') || 'Ninguno'}${earningsInfo}`;
  }).join('\n');

  const candidatesContext = (phase1Result.candidates ?? []).map(c =>
    `  ${c.ticker} (${c.name}): ${c.whyCandidate} [${c.catalystType}]`
  ).join('\n');

  return `ANÁLISIS DE MERCADO — FASE 2: RECOMENDACIONES FINALES
${memoryContext}

CONTEXTO FASE 1:
Bias: ${phase1Result.marketBias} | Riesgo: ${phase1Result.riskLevel}
Tema: ${phase1Result.keyTheme}
${phase1Result.marketSummary}

CANDIDATOS SELECCIONADOS EN FASE 1:
${candidatesContext}

DATOS TÉCNICOS DETALLADOS DE LOS CANDIDATOS:
${techSection || 'No hay datos técnicos disponibles'}
${macroData?.summary ? `\nENTORNO MACROECONÓMICO\n  ${macroData.summary}` : ''}
${insiderData && Object.keys(insiderData).length > 0 ? `\nACTIVIDAD INSIDER (últimos 30 días)\n${Object.entries(insiderData).map(([sym, d]) => `  ${sym}: ${d.summary}`).join('\n')}` : ''}

INSTRUCCIONES FASE 2:
Usá TODOS los datos técnicos para determinar niveles EXACTOS. Máximo 3 recomendaciones.

RESPONDÉ SOLO CON ESTE JSON:
{
  "marketSummary": "Resumen final actualizado",
  "marketBias": "ALCISTA|BAJISTA|NEUTRAL|MIXTO",
  "riskLevel": "BAJO|MEDIO|ALTO|EXTREMO",
  "shouldTrade": true,
  "noTradeReason": null,
  "dominantSectors": ["sector"],
  "keyTheme": "Tema del día",
  "recommendations": [
    {
      "ticker": "TICKER", "name": "Nombre", "type": "ACCIÓN|ETF", "action": "COMPRAR",
      "currentPrice": 0.00, "entryLow": 0.00, "entryHigh": 0.00,
      "target": 0.00, "stopLoss": 0.00, "rrRatio": "X.X:1",
      "potentialGainPct": "X.X%", "potentialLossPct": "X.X%",
      "confidence": "ALTA|MEDIA", "timeHorizon": "INTRADAY|1-3 DÍAS",
      "catalyst": "Catalizador principal", "technicalSetup": "Setup técnico detallado",
      "keyPoints": ["punto1", "punto2", "punto3"],
      "riskWarnings": ["advertencia si aplica"]
    }
  ]
}`;
}

function parseJSON(text, phase) {
  if (!text) return { error: 'Empty response' };
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch { /* fall */ } }
    console.error(`[Claude] JSON parse error in ${phase}:`, text.slice(0, 200));
    return { error: `Parse error in ${phase}` };
  }
}

const fmtPct = (v) => v == null ? 'N/A' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtVol = (v) => {
  if (!v) return 'N/A';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
};

async function runPhaseOne({ marketData, news, sentiment, economicCalendar, delayMinutes = 30 }) {
  return phaseOne({ marketData, news, sentiment, economicCalendar, delayMinutes });
}

module.exports = { analyzeWithClaude, runPhaseOne };
