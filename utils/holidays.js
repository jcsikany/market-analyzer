const NYSE_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
  '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
  '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24',
]);

function isNYSEHoliday(date) {
  const etStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return NYSE_HOLIDAYS.has(etStr);
}

function isMarketOpenToday() {
  const now = new Date();
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = etDate.getDay();

  if (dayOfWeek === 0) return { isOpen: false, reason: 'Domingo' };
  if (dayOfWeek === 6) return { isOpen: false, reason: 'Sábado' };
  if (isNYSEHoliday(now)) return { isOpen: false, reason: 'Feriado NYSE' };

  return { isOpen: true, reason: 'Día hábil' };
}

module.exports = { isNYSEHoliday, isMarketOpenToday };
