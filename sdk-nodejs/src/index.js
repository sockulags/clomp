const axios = require('axios');

// Track live client instances so the optional shutdown handlers can flush them all
const clientInstances = new Set();
let shutdownHandlersRegistered = false;

/**
 * clomp Node.js client — records tamper-evident audit events.
 *
 * const Clomp = require('@clomp/sdk-node');
 * const clomp = new Clomp({
 *   apiUrl: 'http://localhost:3001',
 *   apiKey: 'clomp_live_...',
 *   defaultActor: { type: 'service', id: 'billing-api' }
 * });
 * clomp.record('access.revoked', { target: { type: 'user', id: 'u-42' } });
 * await clomp.flush();
 */
class Clomp {
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || process.env.CLOMP_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.CLOMP_API_KEY;
    this.defaultActor = options.defaultActor || null;

    if (!this.apiKey) {
      console.warn('clomp SDK: No API key provided. Events will not be sent.');
    }

    // FIFO queue: arrival order at the server defines chain order, so events
    // are always sent one at a time, oldest first.
    this.queue = [];
    this.maxQueueLength = options.maxQueueLength || 1000;
    this.flushInterval = options.flushInterval ?? 2000;
    this.timeoutMs = options.timeoutMs || 10000;
    this._flushing = null;

    // Start periodic flush. The timer is unref'd so the SDK never keeps the
    // host process alive on its own.
    if (this.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.flushInterval);
      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }

    clientInstances.add(this);
  }

  /**
   * Optionally register SIGINT/SIGTERM handlers that flush all client
   * instances before the process terminates.
   *
   * Opt-in: the SDK never installs process-wide handlers on its own, and the
   * handlers never call process.exit(). After flushing (max 2 seconds), the
   * signal is re-raised so the default termination behavior is preserved.
   */
  static registerShutdownHandlers() {
    if (shutdownHandlersRegistered) {
      return;
    }
    shutdownHandlersRegistered = true;

    const flushAll = async () => {
      const flushPromises = Array.from(clientInstances).map(instance =>
        instance.destroy().catch(err => {
          if (process.env.CLOMP_DEBUG) {
            console.error('clomp SDK: Error flushing events on shutdown:', err.message);
          }
        })
      );
      await Promise.race([
        Promise.all(flushPromises),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, async () => {
        await flushAll();
        process.kill(process.pid, signal);
      });
    }
  }

  /**
   * Queue an audit event.
   *
   * @param {string} action - namespaced action, e.g. "access.review.completed"
   * @param {object} [fields]
   * @param {object} [fields.actor]   - { type, id, ... }; falls back to defaultActor
   * @param {object} [fields.target]  - { type, id, ... }
   * @param {object} [fields.context] - free-form metadata
   * @param {Array}  [fields.evidence] - [{ filename, sha256, size }]
   * @param {string|Date} [fields.occurredAt] - when it happened (default: now)
   */
  record(action, fields = {}) {
    try {
      const actor = fields.actor || this.defaultActor;
      if (!action || !actor || !actor.type || !actor.id) {
        throw new Error('record() needs an action and an actor with { type, id } (or a defaultActor)');
      }

      const event = {
        action,
        actor,
        target: fields.target,
        context: fields.context,
        evidence: fields.evidence,
        occurred_at: fields.occurredAt ? new Date(fields.occurredAt).toISOString() : undefined
      };

      if (this.queue.length >= this.maxQueueLength) {
        // Drop the oldest event rather than growing without bound; an audit
        // SDK must never take the host application down with it.
        this.queue.shift();
        if (process.env.CLOMP_DEBUG) {
          console.warn('clomp SDK: queue full, dropped oldest event');
        }
      }
      this.queue.push(event);
    } catch (error) {
      // SDK errors should never crash the app
      console.error('clomp SDK: Failed to queue event:', error.message);
    }
  }

  /**
   * Send all queued events, oldest first. Events that fail to send stay at
   * the front of the queue and are retried on the next flush.
   */
  async flush() {
    if (this._flushing) return this._flushing;
    this._flushing = this._drain().finally(() => {
      this._flushing = null;
    });
    return this._flushing;
  }

  async _drain() {
    if (!this.apiKey) return;

    while (this.queue.length > 0) {
      const event = this.queue[0];
      try {
        await axios.post(`${this.apiUrl}/api/events`, event, {
          headers: {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json'
          },
          timeout: this.timeoutMs
        });
        this.queue.shift();
      } catch (error) {
        const status = error.response?.status;
        if (status && status >= 400 && status < 500 && status !== 429) {
          // Rejected permanently (validation/auth) — drop it, don't wedge the queue.
          this.queue.shift();
          if (process.env.CLOMP_DEBUG) {
            console.error(`clomp SDK: event rejected (${status}):`, error.response?.data?.error || error.message);
          }
        } else {
          // Network trouble or rate limit — keep the event and retry later.
          if (process.env.CLOMP_DEBUG) {
            console.error('clomp SDK: send failed, will retry:', error.message);
          }
          break;
        }
      }
    }
  }

  /**
   * Destroy the client: stop the flush timer and flush pending events.
   * Await this during application shutdown to ensure delivery.
   */
  async destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    clientInstances.delete(this);
    await this.flush();
  }
}

module.exports = Clomp;
