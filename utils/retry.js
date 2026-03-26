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
