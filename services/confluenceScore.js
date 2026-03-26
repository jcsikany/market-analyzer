/**
 * Calcula un score de confluencia (0-7) para cada recomendación.
 * Cada factor independiente que confirma la señal suma 1 punto.
 */
function computeConfluence(rec, technicals, macroData, insiderData, sentiment) {
  const factors = [];
  const action = (rec.action || '').toUpperCase();
  const isBuy = action !== 'SHORT';
  const ticker = rec.ticker;
  const tech = technicals?.[ticker];

  // Factor 1: RSI confirma dirección
  if (tech?.rsi != null) {
    const rsi = parseFloat(tech.rsi);
    if (isBuy) {
      const met = rsi < 70; // No sobrecomprado para compra
      factors.push({
        name: 'RSI',
        met,
        detail: met
          ? `RSI ${rsi.toFixed(0)} — no sobrecomprado, favorable para compra`
          : `RSI ${rsi.toFixed(0)} — sobrecomprado, riesgo de reversión`,
      });
    } else {
      const met = rsi > 30; // No sobrevendido para short
      factors.push({
        name: 'RSI',
        met,
        detail: met
          ? `RSI ${rsi.toFixed(0)} — no sobrevendido, favorable para short`
          : `RSI ${rsi.toFixed(0)} — sobrevendido, riesgo de rebote`,
      });
    }
  } else {
    factors.push({ name: 'RSI', met: false, detail: 'Sin datos de RSI' });
  }

  // Factor 2: MACD confirma dirección
  if (tech?.macdHistogram != null) {
    const histogram = parseFloat(tech.macdHistogram);
    const met = isBuy ? histogram > 0 : histogram < 0;
    factors.push({
      name: 'MACD',
      met,
      detail: met
        ? `MACD histograma ${histogram > 0 ? 'positivo' : 'negativo'} — confirma dirección`
        : `MACD histograma ${histogram > 0 ? 'positivo' : 'negativo'} — en contra`,
    });
  } else {
    factors.push({ name: 'MACD', met: false, detail: 'Sin datos de MACD' });
  }

  // Factor 3: Volumen sobre promedio
  if (tech?.volumeRatio != null || tech?.volume != null) {
    const volRatio = tech.volumeRatio || 1;
    const met = volRatio > 1.2;
    factors.push({
      name: 'Volumen',
      met,
      detail: met
        ? `Volumen ${volRatio.toFixed(1)}x el promedio — interés institucional`
        : `Volumen normal (${volRatio.toFixed(1)}x) — sin confirmación de volumen`,
    });
  } else {
    factors.push({ name: 'Volumen', met: false, detail: 'Sin datos de volumen' });
  }

  // Factor 4: Alineación de EMAs
  if (tech?.trendAlignment) {
    const alignment = tech.trendAlignment.toUpperCase();
    const met = isBuy
      ? alignment.includes('ALCISTA') || alignment.includes('BULLISH')
      : alignment.includes('BAJISTA') || alignment.includes('BEARISH');
    factors.push({
      name: 'EMAs',
      met,
      detail: met
        ? `EMAs alineadas a favor: ${tech.trendAlignment}`
        : `EMAs no confirman: ${tech.trendAlignment}`,
    });
  } else {
    factors.push({ name: 'EMAs', met: false, detail: 'Sin datos de EMAs' });
  }

  // Factor 5: Sentimiento (Fear & Greed)
  if (sentiment?.score != null) {
    const score = sentiment.score;
    let met;
    if (isBuy) {
      // Para compra: No queremos codicia extrema (>80) — contrarian
      // Ideal: miedo o neutral (oportunidad de compra)
      met = score < 75;
    } else {
      // Para short: No queremos miedo extremo (<20) — contrarian
      met = score > 25;
    }
    factors.push({
      name: 'Sentimiento',
      met,
      detail: met
        ? `F&G ${score} (${sentiment.rating}) — sentimiento favorable`
        : `F&G ${score} (${sentiment.rating}) — sentimiento extremo, riesgo contrarian`,
    });
  } else {
    factors.push({ name: 'Sentimiento', met: false, detail: 'Sin datos de Fear & Greed' });
  }

  // Factor 6: Macro (FRED)
  if (macroData?.macroSignal) {
    const signal = macroData.macroSignal.signal;
    const met = isBuy
      ? signal === 'FAVORABLE' || signal === 'NEUTRAL'
      : signal === 'RISK_OFF' || signal === 'CAUTIOUS';
    factors.push({
      name: 'Macro',
      met,
      detail: met
        ? `Señal macro ${signal} — entorno favorable`
        : `Señal macro ${signal} — entorno desfavorable para esta dirección`,
    });
  } else {
    factors.push({ name: 'Macro', met: false, detail: 'Sin datos macroeconómicos' });
  }

  // Factor 7: Insider trading (SEC EDGAR)
  if (insiderData?.[ticker]) {
    const insider = insiderData[ticker];
    let met;
    if (insider.signal === 'NO DATA') {
      met = true; // Sin data = neutral, no penalizar
    } else if (isBuy) {
      met = insider.signal !== 'NET SELLING'; // Para compra: no venta neta
    } else {
      met = insider.signal !== 'NET BUYING'; // Para short: no compra neta
    }
    factors.push({
      name: 'Insiders',
      met,
      detail: insider.summary,
    });
  } else {
    factors.push({ name: 'Insiders', met: false, detail: 'Sin datos de insider trading' });
  }

  // Calcular score final
  const score = factors.filter(f => f.met).length;
  const total = factors.length;

  let interpretation;
  if (score >= 6) interpretation = 'CONFLUENCIA FUERTE';
  else if (score >= 4) interpretation = 'CONFLUENCIA MODERADA';
  else if (score >= 2) interpretation = 'CONFLUENCIA DÉBIL';
  else interpretation = 'SIN CONFLUENCIA';

  return {
    score,
    total,
    interpretation,
    factors,
  };
}

module.exports = { computeConfluence };
