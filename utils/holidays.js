/**
 * NYSE Holiday Checker
 * Actualizar la lista cada año en diciembre para el siguiente año.
 * Fuente oficial: https://www.nyse.com/markets/hours-calendars
 */

const NYSE_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', // Año Nuevo
  '2025-01-20', // Martin Luther King Jr. Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independencia
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Navidad

  // 2026
  '2026-01-01', // Año Nuevo
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independencia (viernes, observado)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Navidad

  // 2027
  '2027-01-01', // Año Nuevo
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Presidents Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (viernes, observado)
  '2027-07-05', // Independencia (lunes, observado)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Navidad (viernes, observado)
]);

/**
 * Verifica si una fecha es feriado del NYSE
 * @param {Date} date - La fecha a verificar (en cualquier timezone)
 * @returns {boolean}
 */
function isNYSEHoliday(date) {
  // Convertir a ET para evaluar correctamente
  const etStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return NYSE_HOLIDAYS.has(etStr);
}

/**
 * Verifica si hoy es un día hábil en NYSE
 * @returns {{ isOpen: boolean, reason: string }}
 */
function isMarketOpenToday() {
  const now = new Date();
  
  // Día de la semana en ET (0=Dom, 6=Sab)
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = etDate.getDay();
  
  if (dayOfWeek === 0) return { isOpen: false, reason: 'Domingo' };
  if (dayOfWeek === 6) return { isOpen: false, reason: 'Sábado' };
  
  if (isNYSEHoliday(now)) {
    return { isOpen: false, reason: 'Feriado NYSE' };
  }
  
  return { isOpen: true, reason: 'Día hábil' };
}

module.exports = { isNYSEHoliday, isMarketOpenToday };
