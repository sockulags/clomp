const cron = require('node-cron');
const { getPool } = require('./../database');
const { createCheckpoint } = require('./checkpoints');
const anchoring = require('./anchoring');
const logger = require('../logger');

const notifications = require('./notifications');

const CHECKPOINT_SCHEDULE = process.env.CHECKPOINT_SCHEDULE || '0 2 * * *'; // Daily at 02:00 UTC
const NOTIFY_SCHEDULE = process.env.NOTIFY_SCHEDULE || '0 6 * * *'; // Daily at 06:00 UTC

let checkpointTask = null;
let notifyTask = null;

// Advisory-lock namespace for scheduled jobs. The chain-append path locks per
// tenant with the single-key form (pg_advisory_xact_lock(hashtext(tenantId))
// in services/chain.js); jobs use the two-key (classid, objid) form, which
// lives in a separate keyspace in PostgreSQL, so job locks can never collide
// with per-tenant chain locks.
const JOB_LOCK_NAMESPACE = 'clomp:jobs';

/**
 * Run a scheduled job under a PostgreSQL advisory lock so that, when several
 * backend replicas share one database, each scheduled run executes on exactly
 * one of them. `pg_try_advisory_lock` does not block: replicas that lose the
 * race skip the run instead of queueing up behind it.
 *
 * Session-level advisory locks belong to one connection, so the lock is taken
 * and released on the same dedicated client, held for the whole job.
 *
 * Returns { ran, result }: ran=false means another instance held the lock.
 */
async function runExclusively(jobName, fn) {
  const client = await getPool().connect();
  let locked = false;
  try {
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
      [JOB_LOCK_NAMESPACE, jobName]
    );
    locked = rows[0].locked === true;
    if (!locked) {
      logger.info({ job: jobName }, 'Skipping scheduled job: another instance holds the lock');
      return { ran: false, result: null };
    }
    const result = await fn();
    return { ran: true, result };
  } finally {
    if (locked) {
      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
          [JOB_LOCK_NAMESPACE, jobName]
        );
        client.release();
      } catch (err) {
        // Destroy the connection rather than returning it to the pool: a
        // session-level advisory lock lives until its session ends, and a
        // pooled connection still holding the lock would block every future
        // run of this job.
        logger.error({ err, job: jobName }, 'Failed to release job lock; discarding connection');
        client.release(err);
      }
    } else {
      client.release();
    }
  }
}

/** Sign a checkpoint for every tenant that has events. */
async function runCheckpointJob() {
  const { rows } = await getPool().query('SELECT DISTINCT tenant_id FROM events');
  let created = 0;
  for (const row of rows) {
    const cp = await createCheckpoint(row.tenant_id);
    if (cp) {
      created++;
      if (anchoring.isConfigured()) await anchoring.anchorCheckpoint(cp);
    }
  }
  logger.info({ created }, 'Checkpoint job complete');
  return created;
}

/**
 * Register a cron job that always runs under the named advisory lock.
 * Every scheduled job must go through this so single-runner behavior is
 * structural, not a per-call-site convention.
 */
function scheduleExclusive(schedule, jobName, fn) {
  return cron.schedule(schedule, async () => {
    try {
      await runExclusively(jobName, fn);
    } catch (error) {
      logger.error({ err: error, job: jobName }, 'Scheduled job failed');
    }
  }, { scheduled: true, timezone: 'UTC' });
}

function startScheduler() {
  logger.info({ checkpointSchedule: CHECKPOINT_SCHEDULE }, 'Starting checkpoint scheduler');
  checkpointTask = scheduleExclusive(CHECKPOINT_SCHEDULE, 'checkpoint', runCheckpointJob);

  if (notifications.isConfigured()) {
    logger.info({ notifySchedule: NOTIFY_SCHEDULE }, 'Starting overdue-control notification scheduler');
    notifyTask = scheduleExclusive(NOTIFY_SCHEDULE, 'overdue-notify',
      () => notifications.runOverdueNotificationJob());
  }
}

function stopScheduler() {
  if (checkpointTask) {
    checkpointTask.stop();
    checkpointTask = null;
  }
  if (notifyTask) {
    notifyTask.stop();
    notifyTask = null;
  }
  logger.info('Scheduler stopped');
}

module.exports = { startScheduler, stopScheduler, runCheckpointJob, runExclusively };
