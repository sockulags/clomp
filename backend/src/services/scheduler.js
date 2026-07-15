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

function startScheduler() {
  logger.info({ checkpointSchedule: CHECKPOINT_SCHEDULE }, 'Starting checkpoint scheduler');
  checkpointTask = cron.schedule(CHECKPOINT_SCHEDULE, async () => {
    try {
      await runCheckpointJob();
    } catch (error) {
      logger.error({ err: error }, 'Scheduled checkpoint job failed');
    }
  }, { scheduled: true, timezone: 'UTC' });

  if (notifications.isConfigured()) {
    logger.info({ notifySchedule: NOTIFY_SCHEDULE }, 'Starting overdue-control notification scheduler');
    notifyTask = cron.schedule(NOTIFY_SCHEDULE, async () => {
      try {
        await notifications.runOverdueNotificationJob();
      } catch (error) {
        logger.error({ err: error }, 'Scheduled notification job failed');
      }
    }, { scheduled: true, timezone: 'UTC' });
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

module.exports = { startScheduler, stopScheduler, runCheckpointJob };
