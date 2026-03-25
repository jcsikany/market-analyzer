/**
 * Retry con backoff exponencial + jitter
 * Usado por todos los servicios para que un fallo puntual no rompa el análisis.
 */

/**
 * @param {Function} fn - función async a reintentar
 * @param {Object} opts
 * @param {number} opts.retries   - máximo de reintentos (default: 3)
 * @param {number} opts.baseMs    - delay base en ms (default: 800)
 * @param {number} opts.maxMs     - delay máximo en ms (default: 8000)
 * @param {string} opts.label     - nombre para los logs
 * @param {Function} opts.onRetry - callback opcional (attempt, error)
 */
async function withRetry(fn, {
  retries = 3,
  baseMs = 800,
  maxMs = 8000,
  label = 'operation',
  onRetry = null,
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === retries) break;

      // Backoff exponencial con jitter aleatorio (±20%)
      const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
      const jitter = exponential * (0.8 + Math.random() * 0.4);
      const delay = Math.round(jitter);

      console.warn(
        `[Retry][${label}] Attempt ${attempt + 1}/${retries} failed: ${err.message}. ` +
        `Retrying in ${delay}ms...`
      );

      if (onRetry) onRetry(attempt + 1, err);
      await sleep(delay);
    }
  }

  console.error(`[Retry][${label}] All ${retries} retries exhausted.`);
  throw lastError;
}

/**
 * Ejecuta múltiples promesas en paralelo con fallback individual.
 * A diferencia de Promise.all, si una falla devuelve el fallback en vez de rechazar todo.
 * @param {Array<{ fn: Function, fallback: any, label: string }>} tasks
 */
async function parallelWithFallback(tasks) {
  return Promise.all(
    tasks.map(async ({ fn, fallback, label }) => {
      try {
        return await fn();
      } catch (err) {
        console.error(`[ParallelFallback][${label}] Failed: ${err.message}. Using fallback.`);
        return fallback;
      }
    })
  );
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { withRetry, parallelWithFallback, sleep };
