const axios = require('axios');
const { withRetry } = require('../utils/retry');

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const HIGH_IMPACT_KEYWORDS = ['nonfarm','non-farm','cpi','pce','gdp','fomc','federal reserve','powell','interest rate','fed rate','unemployment','payroll','inflation','ppi','retail sales','ism manufacturing'];

async function fetchEconomicCalendar() {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) { console.warn('[EconCalendar] FINNHUB_API_KEY not set.'); return buildFallback('API key no configurada'); }
  console.log('[EconCalendar] Fetching economic calendar...');

  return withRetry(async () => {
    const today = formatDate(new Date());
    const tomorrow = formatDate(addDays(new Date(), 1));
    const response = await axios.get(`${FINNHUB_BASE}/calendar/economic`, {
      params: { from: today, to: tomorrow, token: apiKey }, timeout: 10000,
    });

    const events = response.data?.economicCalendar ?? [];
    if (!events.length) return { events: [], highImpact: false, hasEvents: false, summary: 'Sin eventos económicos relevantes hoy' };

    const classified = events.map(ev => ({
      event: ev.event, time: ev.time ?? 'TBD', country: ev.country ?? 'US',
      actual: ev.actual ?? null, estimate: ev.estimate ?? null, prev: ev.prev ?? null,
      impact: classifyImpact(ev), surprise: calculateSurprise(ev),
    })).filter(ev => ev.country === 'US');

    classified.sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[a.impact] ?? 3) - ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[b.impact] ?? 3));

    const highImpact = classified.filter(ev => ev.impact === 'HIGH');
    const now = new Date();
    const pending = classified.filter(ev => {
      if (!ev.time || ev.actual !== null) return false;
      try { return new Date(`${today}T${ev.time}`) > now; } catch { return false; }
    });

    console.log(`[EconCalendar] ${classified.length} events (${highImpact.length} high impact, ${pending.length} pending)`);
    return {
      events: classified.slice(0, 12), highImpactEvents: highImpact,
      pendingHighImpact: pending.filter(e => e.impact === 'HIGH'),
      highImpact: highImpact.length > 0, hasEvents: classified.length > 0,
      summary: buildSummary(classified, highImpact, pending),
      warningLevel: pending.filter(e => e.impact === 'HIGH').length > 0 ? 'HIGH' : highImpact.length > 0 ? 'MEDIUM' : 'LOW',
    };
  }, { label: 'economicCalendar', retries: 2 });
}

function classifyImpact(ev) {
  const name = (ev.event ?? '').toLowerCase();
  if (HIGH_IMPACT_KEYWORDS.some(k => name.includes(k))) return 'HIGH';
  if (ev.impact === 3 || ev.impact === 'high') return 'HIGH';
  if (ev.impact === 2 || ev.impact === 'medium') return 'MEDIUM';
  return 'LOW';
}

function calculateSurprise(ev) {
  if (ev.actual == null || ev.estimate == null) return null;
  const diff = parseFloat(ev.actual) - parseFloat(ev.estimate);
  if (Math.abs(diff) < 0.001) return 'EN LÍNEA';
  return diff > 0 ? `POSITIVO (+${diff.toFixed(2)})` : `NEGATIVO (${diff.toFixed(2)})`;
}

function buildSummary(all, highImpact, pending) {
  if (!all.length) return 'Sin eventos económicos relevantes hoy';
  const parts = [];
  const pendingHigh = pending.filter(e => e.impact === 'HIGH');
  if (pendingHigh.length > 0) parts.push(`⚠ ATENCIÓN: Eventos de alto impacto PENDIENTES hoy: ${pendingHigh.map(e => e.event).join(', ')}`);
  const releasedHigh = highImpact.filter(e => e.actual !== null);
  if (releasedHigh.length > 0) {
    const surprises = releasedHigh.filter(e => e.surprise && e.surprise !== 'EN LÍNEA');
    parts.push(surprises.length > 0
      ? `Datos ya publicados con sorpresa: ${surprises.map(e => `${e.event} (${e.surprise})`).join('; ')}`
      : `Datos de alto impacto publicados sin sorpresas significativas`);
  }
  if (!parts.length) parts.push(`${all.length} eventos económicos hoy, ninguno de alto impacto`);
  return parts.join(' | ');
}

function buildFallback(reason) {
  return { events: [], highImpactEvents: [], pendingHighImpact: [], highImpact: false, hasEvents: false, summary: `Calendario económico no disponible: ${reason}`, warningLevel: 'UNKNOWN' };
}

const formatDate = (d) => d.toISOString().split('T')[0];
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

module.exports = { fetchEconomicCalendar };
