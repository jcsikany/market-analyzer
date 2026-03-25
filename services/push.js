const { Expo } = require('expo-server-sdk');

const expo = new Expo();

/**
 * Envía push notifications a todos los tokens registrados
 * @param {string[]} pushTokens - Array de Expo push tokens
 * @param {Object} analysis - Resultado del análisis de Claude
 */
async function sendPushNotification(pushTokens, analysis) {
  if (!pushTokens || pushTokens.length === 0) {
    console.log('[Push] No push tokens registered, skipping.');
    return;
  }

  const validTokens = pushTokens.filter(token => Expo.isExpoPushToken(token));

  if (validTokens.length === 0) {
    console.warn('[Push] No valid Expo push tokens found.');
    return;
  }

  // Construir el mensaje de notificación
  const { title, body, data } = buildNotificationContent(analysis);

  const messages = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
    priority: 'high',
    badge: 1,
  }));

  console.log(`[Push] Sending to ${validTokens.length} devices...`);

  // Enviar en chunks (límite de Expo)
  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];

  for (const chunk of chunks) {
    try {
      const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...chunkTickets);
    } catch (error) {
      console.error('[Push] Chunk send error:', error.message);
    }
  }

  // Log de resultados
  const errors = tickets.filter(t => t.status === 'error');
  const ok = tickets.filter(t => t.status === 'ok');
  console.log(`[Push] Sent: ${ok.length} OK, ${errors.length} errors.`);

  if (errors.length > 0) {
    errors.forEach(e => console.warn('[Push] Error:', e.message));
  }

  return { sent: ok.length, errors: errors.length };
}

/**
 * Construye el contenido de la notificación según el análisis
 */
function buildNotificationContent(analysis) {
  const { shouldTrade, marketBias, riskLevel, recommendations, marketSummary } = analysis;

  if (!shouldTrade || !recommendations || recommendations.length === 0) {
    return {
      title: '📊 Análisis de Mercado',
      body: `${biasEmoji(marketBias)} Mercado ${marketBias} · Riesgo ${riskLevel} · Hoy no hay setups claros`,
      data: { type: 'no_trade', analysis },
    };
  }

  const topRec = recommendations[0];
  const count = recommendations.length;
  const countText = count > 1 ? ` (+${count - 1} más)` : '';

  return {
    title: `🎯 ${topRec.ticker} — ${topRec.action} · ${topRec.confidence}`,
    body: `Entrada: ${topRec.entryLow}–${topRec.entryHigh} · Target: ${topRec.target} · R/R ${topRec.rrRatio}${countText}`,
    data: { type: 'recommendation', analysis },
  };
}

function biasEmoji(bias) {
  const map = { ALCISTA: '🟢', BAJISTA: '🔴', NEUTRAL: '⚪', MIXTO: '🟡' };
  return map[bias] ?? '📊';
}

module.exports = { sendPushNotification };
