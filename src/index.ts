import "@logseq/libs";
import { PageEntity, BlockEntity } from "@logseq/libs/dist/LSPlugin.user";

// 4.* has URL is not constructor error, fallback to 3.*
import { Telegraf, Context } from "telegraf";
import { marked } from "marked";

// internal
import {
  log,
  error,
  showError,
  getDateString,
  nameof,
  stringifyBlocks,
  initPageLogger,
} from "./utils";
import { runAtInterval, cancelJob } from "./timed-job";
import { settings, initializeSettings, Settings } from "./settings";
import { setupMessageHandlers } from "./message-handlers";
import {
  disableCustomizedCommands,
  enableCustomizedCommands,
  setupCommandHandlers,
} from "./command-handlers";
import { setupCommandPlayground } from "./command-playground";

type OperationHandler = (
  bot: Telegraf<Context>,
  blockId: string,
) => Promise<void>;

const ONE_DAY_IN_SECOND = 24 * 60 * 60;
const SCHEDULED_NOTIFICATION_JOB = "ScheduledTimedJob";
const DEADLINE_NOTIFICATION_JOB = "DeadlineNotificationJob";
const HEALTH_CHECK_INTERVAL_IN_MS = 60 * 1000;
const POLLING_STUCK_MULTIPLIER = 3;
const POLLING_STUCK_MIN_MS = 90 * 1000;
const POLLING_MONITOR_FLAG = "__localTelegramBotPollingMonitor";
const STOP_MAIN_BOT_TIMEOUT_MS = 10 * 1000;
const JOB_TYPES: { [key: string]: string } = {
  [SCHEDULED_NOTIFICATION_JOB]: "scheduled",
  [DEADLINE_NOTIFICATION_JOB]: "deadline",
};

let recoveringBot = false;
let healthCheckTimer: number | null = null;
let lastPollingStartAt: number | null = null;
let lastPollingCompleteAt: number | null = null;

const blockContextMenuHandlers: { [key: string]: OperationHandler } = {
  Send: handleSendOperation,
};

async function findTask(date: Date, type: string, status: string[]) {
  const dateString = getDateString(date);
  const ret: Array<PageEntity[]> | undefined = await logseq.DB.datascriptQuery(`
    [:find (pull ?b [*])
     :where
     [?b :block/${type} ?d]
     [(= ?d ${dateString})]
     [?b :block/marker ?marker]
     [(contains? #{${status.map((s) => '"' + s + '"').join(" ")}} ?marker)]]
    `);

  if (!ret) {
    log(`There are no tasks with ${type} for ${dateString}`);
    return [];
  }

  return ret.flat();
}

async function handleSendOperation(
  bot: Telegraf<Context>,
  blockId: string,
  addId: boolean = false,
) {
  if (Object.keys(settings.chatIds).length == 0) {
    showError('Authorized users need to "/register" first');
    return;
  }
  const root = await logseq.Editor.getBlock(blockId, { includeChildren: true });
  if (!root) {
    showError("Fail to get block");
    return;
  }

  const text = stringifyBlocks(root, false);
  const html = marked.parseInline(text);
  for (let key in settings.chatIds) {
    bot.telegram.sendMessage(settings.chatIds[key], html, {
      parse_mode: "HTML",
    });
    log("Send message");
  }
}

function setupBlockContextMenu(bot: Telegraf<Context>) {
  for (let key in blockContextMenuHandlers) {
    logseq.Editor.registerBlockContextMenuItem(
      `Local Telegram Bot: ${key}`,
      async (e) => {
        blockContextMenuHandlers[key](bot, e.uuid);
      },
    );
  }
}

function setupSlashCommand(bot: Telegraf<Context>) {}

function startTimedJob(bot: Telegraf<Context>, name: string, time: Date) {
  runAtInterval(name, time, ONE_DAY_IN_SECOND, async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tasks = await findTask(tomorrow, JOB_TYPES[name], [
      "TODO",
      "DOING",
      "NOW",
      "LATER",
      "WAITING",
    ]);
    for (let task of tasks) {
      handleSendOperation(bot, task.uuid);
    }
  });
}

function updateTimedJob(
  bot: Telegraf<Context>,
  name: string,
  time: Date | null,
) {
  cancelJob(name);
  if (time) {
    startTimedJob(bot, name, time);
  }
}

function startTimedJobs(bot: Telegraf<Context>) {
  if (settings.scheduledNotificationTime) {
    startTimedJob(
      bot,
      SCHEDULED_NOTIFICATION_JOB,
      settings.scheduledNotificationTime,
    );
  }

  if (settings.deadlineNotificationTime) {
    startTimedJob(
      bot,
      DEADLINE_NOTIFICATION_JOB,
      settings.deadlineNotificationTime,
    );
  }
}

function stopTimedJobs() {
  cancelJob(SCHEDULED_NOTIFICATION_JOB);
  cancelJob(DEADLINE_NOTIFICATION_JOB);
}

function startHealthCheck(bot: Telegraf<Context>) {
  if (healthCheckTimer) {
    return;
  }

  healthCheckTimer = window.setInterval(async () => {
    log("health check: polling tick");
    // only recover main bot with valid token
    if (!settings.isMainBot || !settings.botToken) {
      return;
    }

    // Telegraf v3 sets polling.started to false after fatal polling errors
    if (!(bot as any).polling?.started) {
      log("health check: polling stopped, recovering bot");
      await recoverBot(bot);
      return;
    }

    const stuckReason = getPollingStuckReason(bot);
    if (stuckReason) {
      log(`health check: polling stuck (${stuckReason}), recovering bot`);
      await recoverBot(bot);
    }
  }, HEALTH_CHECK_INTERVAL_IN_MS);
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function attachPollingMonitor(bot: Telegraf<Context>) {
  const telegram = bot.telegram as any;
  if (!telegram || telegram[POLLING_MONITOR_FLAG]) {
    return;
  }

  const originalGetUpdates = telegram.getUpdates?.bind(telegram);
  if (!originalGetUpdates) {
    return;
  }

  telegram.getUpdates = async (...args: any[]) => {
    lastPollingStartAt = Date.now();
    try {
      return await originalGetUpdates(...args);
    } finally {
      lastPollingCompleteAt = Date.now();
    }
  };
  telegram[POLLING_MONITOR_FLAG] = true;
}

function getPollingStuckReason(bot: Telegraf<Context>): string | null {
  const polling = (bot as any).polling;
  if (!polling?.started) {
    return null;
  }

  if (!lastPollingStartAt && !lastPollingCompleteAt) {
    return null;
  }

  const timeoutSec =
    typeof polling.timeout === "number" && polling.timeout > 0
      ? polling.timeout
      : 30;
  const thresholdMs = Math.max(
    timeoutSec * 1000 * POLLING_STUCK_MULTIPLIER,
    POLLING_STUCK_MIN_MS,
  );
  const now = Date.now();

  if (
    lastPollingStartAt &&
    (!lastPollingCompleteAt || lastPollingStartAt > lastPollingCompleteAt)
  ) {
    const pendingMs = now - lastPollingStartAt;
    if (pendingMs > thresholdMs) {
      return `getUpdates pending for ${Math.round(pendingMs / 1000)}s`;
    }
    return null;
  }

  if (lastPollingCompleteAt) {
    const idleMs = now - lastPollingCompleteAt;
    if (idleMs > thresholdMs) {
      return `no getUpdates completion for ${Math.round(idleMs / 1000)}s`;
    }
  }

  return null;
}

function setupMarked(bot: Telegraf<Context>) {
  const renderer = new marked.Renderer();
  renderer.image = (href, title, text) => {
    return `<a href="${href}">${title ? title : "&#8288;"}</a>`;
  };

  marked.use({ renderer });
}

async function startMainBot(bot: Telegraf<Context>) {
  try {
    // bot.launch can't catch all exception
    // use getMe first
    await bot.telegram.getMe();
    await bot.launch();
  } catch (e) {
    error("bot failed to launch");
    showError("Bot Token is not valid");
    logseq.showSettingsUI();

    // rethrow to stop the process
    throw e;
  }

  startTimedJobs(bot);
  startHealthCheck(bot);

  if (settings.enableCustomizedCommand) {
    enableCustomizedCommands();
  } else {
    disableCustomizedCommands();
  }

  log("bot has started as Main Bot");
}

async function stopMainBot(bot: Telegraf<Context>) {
  disableCustomizedCommands();
  stopTimedJobs();
  stopHealthCheck();
  const stopResult = await Promise.race([
    bot
      .stop()
      .then(() => ({ status: "stopped" as const }))
      .catch((e) => {
        error(`failed to stop bot: ${(e as Error).message}`);
        return { status: "failed" as const };
      }),
    new Promise<{ status: "timeout" }>((resolve) =>
      window.setTimeout(
        () => resolve({ status: "timeout" }),
        STOP_MAIN_BOT_TIMEOUT_MS,
      ),
    ),
  ]);

  if (stopResult.status === "timeout") {
    error(
      `bot stop timed out after ${Math.round(
        STOP_MAIN_BOT_TIMEOUT_MS / 1000,
      )}s, continuing restart`,
    );
  } else if (stopResult.status === "stopped") {
    log("bot has stopped as Main Bot");
  }
}

async function recoverBot(bot: Telegraf<Context>) {
  if (recoveringBot) {
    log("bot is already recovering");
    return;
  }

  if (!settings.botToken) {
    log("skip recovering bot: bot token is not set");
    return;
  }

  recoveringBot = true;
  try {
    await stopMainBot(bot);
  } catch (e) {
    error(`failed to stop bot when recovering: ${(<Error>e).message}`);
  }

  try {
    await start(bot);
  } catch (e) {
    error(`failed to restart bot when recovering: ${(<Error>e).message}`);
  } finally {
    recoveringBot = false;
  }
}

function setupBot(bot: Telegraf<Context>) {
  // command should be before message
  setupCommandHandlers(bot);

  // need this to handle photo renderer for non-Main bot
  setupMessageHandlers(bot);

  // logseq operation
  setupBlockContextMenu(bot);
  setupSlashCommand(bot);

  setupCommandPlayground();

  // setupMarked(bot);

  startHealthCheck(bot);
}

// this is called only when botToken is valid in format
async function start(bot: Telegraf<Context>) {
  if (bot.token) {
    log("try to stop the old bot");
    await stopMainBot(bot);
  }

  bot.token = settings.botToken;
  attachPollingMonitor(bot);

  if (settings.enableCustomizedCommand) {
    enableCustomizedCommands();
  }

  if (settings.isMainBot) {
    await startMainBot(bot);
  }

  log("bot is ready");
}

async function main() {
  await initPageLogger();
  const bot = new Telegraf<Context>("");

  bot.catch(async (err, ctx) => {
    error(`bot caught an error: ${(<Error>err).message}`);
    await recoverBot(bot);
  });

  // logseq.settings is NOT available until now
  initializeSettings((name) => {
    switch (name) {
      case nameof<Settings>("botToken"):
        start(bot);
        break;

      case nameof<Settings>("isMainBot"):
        if (bot.token) {
          if (settings.isMainBot) {
            startMainBot(bot);
          } else {
            stopMainBot(bot);
          }
        }
        break;

      case nameof<Settings>("scheduledNotificationTime"):
        updateTimedJob(
          bot,
          SCHEDULED_NOTIFICATION_JOB,
          settings.scheduledNotificationTime,
        );
        break;

      case nameof<Settings>("deadlineNotificationTime"):
        updateTimedJob(
          bot,
          DEADLINE_NOTIFICATION_JOB,
          settings.deadlineNotificationTime,
        );
        break;

      case nameof<Settings>("enableCustomizedCommand"):
        if (settings.enableCustomizedCommand) {
          enableCustomizedCommands();
        } else {
          disableCustomizedCommands();
        }
        break;
    }
  });

  setupBot(bot);

  if (!settings.botToken) {
    showError("Bot Token is not valid");
    logseq.showSettingsUI();
    return;
  }

  start(bot);
}

// bootstrap
logseq.ready(main).catch(console.error);
