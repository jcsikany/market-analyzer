const cron = require('node-cron');
const { runAnalysis } = require('./services/orchestrator');
const { isMarketOpenToday } = require('./utils/holidays');

let cronJob = null;

/**
 * Wall Street abre a las 9:30 AM ET.
 * Opciones de delay configurables: 15, 30, 45, 60 minutos.
 * → Ejecución a las: 9:45, 10:00, 10:15, 10:30 AM ET
 */
function delayToTime(delayMinutes) {
  const openHour = 9;
  const openMinute = 30;
  const totalMinutes = openHour * 60 + openMinute + delayMinutes;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return { hour, minute };
}

/**
 * Configura el cron job con el delay actual de settings
 */
function setupCron() {
  startCronWithDelay(global.appState?.settings?.delayMinutes ?? 30);
}

/**
 * Inicia (o reinicia) el cron con un nuevo delay
 * @param {number} delayMinutes - minutos después de la apertura (15, 30, 45, 60)
 */
function startCronWithDelay(delayMinutes) {
  // Detener cron anterior si existe
  if (cronJob) {
    cronJob.stop();
    console.log('[Scheduler] Previous cron stopped.');
  }

  const { hour, minute } = delayToTime(delayMinutes);
  const cronExpression = `${minute} ${hour} * * 1-5`; // Lun-Vie

  console.log(`[Scheduler] Setting up cron: ${cronExpression} ET (${hour}:${minute.toString().padStart(2,'0')} AM ET = ${delayMinutes}min after open)`);

  cronJob = cron.schedule(
    cronExpression,
    async () => {
      const { isOpen, reason } = isMarketOpenToday();
      
      if (!isOpen) {
        console.log(`[Scheduler] Skipping — market closed (${reason})`);
        return;
      }

      if (!global.appState?.settings?.enabled) {
        console.log('[Scheduler] Skipping — auto-analysis disabled');
        return;
      }

      console.log(`[Scheduler] Firing at ${hour}:${minute.toString().padStart(2,'0')} ET (${delayMinutes}min after open)`);
      
      try {
        await runAnalysis({ manual: false });
      } catch (err) {
        console.error('[Scheduler] Auto-analysis error:', err.message);
      }
    },
    {
      timezone: 'America/New_York',
      scheduled: true,
    }
  );

  console.log(`[Scheduler] Cron active. Next run: Mon-Fri at ${hour}:${minute.toString().padStart(2,'0')} AM ET`);
  return cronJob;
}

/**
 * Actualiza el delay y reinicia el cron
 * @param {number} newDelay
 */
function updateDelay(newDelay) {
  const allowed = [15, 30, 45, 60];
  if (!allowed.includes(newDelay)) {
    throw new Error(`Delay inválido. Valores permitidos: ${allowed.join(', ')}`);
  }
  console.log(`[Scheduler] Updating delay to ${newDelay} minutes`);
  startCronWithDelay(newDelay);
}

module.exports = { setupCron, updateDelay };
