const cron = require('node-cron');
const { getPool } = require('./../database');
const { createCheckpoint } = require('./checkpoints');
const logger = require('../logger');

const CHECKPOINT_SCHEDULE = process.env.CHECKPOINT_SCHEDULE || '0 2 * * *'; // Daily at 02:00 UTC

let checkpointTask = null;

/** Sign a checkpoint for every tenant that has events. */
async function runCheckpointJob() {
  const { rows } = await getPool().query('SELECT DISTINCT tenant_id FROM events');
  let created = 0;
  for (const row of rows) {
    const cp = await createCheckpoint(row.tenant_id);
    if (cp) created++;
  }
  logger.info({ created }, 'Checkpoint job complete');
  return created;
}

function startScheduler() {
  logger.info({ checkpointSchedule: CHECKPOINT_SCHEDULE }, 'Starting checkpoint scheduler');
  checkpointTask = cron.schedule(CHECKPOINT_SCHEDULE, async () => {
    try {
      await runCheckpointJob();
    } catch (error) {
      logger.error({ err: error }, 'Scheduled checkpoint job failed');
    }
  }, { scheduled: true, timezone: 'UTC' });
}

function stopScheduler() {
  if (checkpointTask) {
    checkpointTask.stop();
    checkpointTask = null;
  }
  logger.info('Scheduler stopped');
}

module.exports = { startScheduler, stopScheduler, runCheckpointJob };
