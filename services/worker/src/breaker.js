// A tiny circuit breaker.
// If an external service (like RDAP) fails several times in a row, we stop
// calling it for a cooldown period instead of making every job wait for a
// timeout. After the cooldown we try again.

export class CircuitBreaker {
  constructor(name, { failureThreshold = 5, cooldownMs = 60_000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openedAt = 0;
  }

  isOpen() {
    if (this.failures < this.failureThreshold) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      this.failures = this.failureThreshold - 1; // half-open: allow one trial call
      return false;
    }
    return true;
  }

  // Runs fn. Returns null (without calling fn) while the breaker is open.
  async call(fn) {
    if (this.isOpen()) return null;
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      this.failures += 1;
      if (this.failures >= this.failureThreshold) {
        this.openedAt = Date.now();
        console.error(JSON.stringify({ level: 'warn', msg: `circuit opened for ${this.name}`, err: err.message }));
      }
      return null;
    }
  }
}
