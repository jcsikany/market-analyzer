const { Expo } = require('expo-server-sdk');

const expo = new Expo();

async function sendPushNotification(pushTokens, analysis) {
  if (!pushTokens || pushTokens.length === 0) { console.log('[Push] No push tokens registered, skipping.'); return; }

  const validTokens = pushTokens.filter(token => Expo.isExpoPushToken(token));
  if (validTokens.length === 0) { console.warn('[Push] No valid Expo push tokens found.'); return; }

  const { title, body, data } = buildNotificationContent(analysis);
  const messages = validTokens.map(token => ({ to: token, sound: 'default', title, body, data, priority: 'high', badge: 1 }));
  console.log(`[Push] Sending to ${validTokens.length} devices...`);

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  for (const chunk of chunks) {
    try { tickets.push(...await expo.sendPushNotificationsAsync(chunk)); }
    catch (error) { console.error('[Push] Chunk send error:', error.message); }
  }

  const errors = tickets.filter(t => t.status === 'error');
  const ok = tickets.filter(t => t.status === 'ok');
  console.log(`[Push] Sent: ${ok.length} OK, ${errors.length} errors.`);
  if (errors.length > 0) errors.forEach(e => console.warn('[Push] Error:', e.message));
  return { sent: ok.length, errors: errors.length };
}

function buildNotificationContent(analysis) {
  const { shouldTrade, marketBias, riskLevel, recommendations } = analysis;
  if (!shouldTrade || !recommendations || recommendations.length === 0) {
    return {
      title: '📊 Análisis de Mercado',
      body: `${biasEmoji(marketBias)} Mercado ${marketBias} · Riesgo ${riskLevel} · Hoy no hay setups claros`,
      data: { type: 'no_trade', analysis },
    };
  }
  const topRec = recommendations[0];
  const countText = recommendations.length > 1 ? ` (+${recommendations.length - 1} más)` : '';
  return {
    title: `🎯 ${topRec.ticker} — ${topRec.action} · ${topRec.confidence}`,
    body: `Entrada: ${topRec.entryLow}–${topRec.entryHigh} · Target: ${topRec.target} · R/R ${topRec.rrRatio}${countText}`,
    data: { type: 'recommendation', analysis },
  };
}

function biasEmoji(bias) {
  return { ALCISTA: '🟢', BAJISTA: '🔴', NEUTRAL: '⚪', MIXTO: '🟡' }[bias] ?? '📊';
}

module.exports = { sendPushNotification };
