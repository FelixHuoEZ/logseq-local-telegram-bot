import "@logseq/libs";
import { BlockEntity } from "@logseq/libs/dist/LSPlugin.user";

import { Message } from "typegram";
import { settings } from "./settings";

export {
  log,
  error,
  showMsg,
  showError,
  getDateString,
  getTimestampString,
  isMessageAuthorized,
  nameof,
  stringifyBlocks,
  initPageLogger,
  setPageLoggingEnabled,
  formatError,
};

const PROJECT_NAME = "Local Telegram Bot";
const LOG_PAGE_NAME = "Local Telegram Bot Log";
const BOT_TOKEN_REDACTION_REGEX = /\b[0-9]{8,10}:[a-zA-Z0-9_-]{35}\b/g;
let logPageUuid: string | null = null;
let logPageReady = false;
let logging = false;
let pageLoggingEnabled = false;

function format(message: string) {
  return `[${PROJECT_NAME}] ` + message;
}

function redactTokens(value: string) {
  return value.replace(BOT_TOKEN_REDACTION_REGEX, "<redacted>");
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const details: string[] = [];
    if (err.name) {
      details.push(`name=${err.name}`);
    }
    if (err.message) {
      details.push(`message=${err.message}`);
    }

    const extra = err as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: unknown;
      cause?: unknown;
    };

    if (extra.code) {
      details.push(`code=${String(extra.code)}`);
    }
    if (extra.status) {
      details.push(`status=${String(extra.status)}`);
    }
    if (extra.statusCode) {
      details.push(`statusCode=${String(extra.statusCode)}`);
    }
    if (extra.response) {
      const response = safeStringify(extra.response);
      if (response) {
        details.push(`response=${response}`);
      }
    }
    if (extra.cause) {
      details.push(`cause=${formatError(extra.cause)}`);
    }
    if (err.stack) {
      details.push(`stack=${err.stack.replace(/\s*\n\s*/g, " | ")}`);
    }

    return redactTokens(details.join("; ") || "unknown error");
  }

  if (typeof err === "string") {
    return redactTokens(err);
  }

  if (err && typeof err === "object") {
    const json = safeStringify(err);
    if (json) {
      return redactTokens(json);
    }
  }

  return redactTokens(String(err));
}

async function ensureLogPage() {
  if (logPageReady) {
    return;
  }

  try {
    let page = await logseq.Editor.getPage(LOG_PAGE_NAME);
    if (!page) {
      page = await logseq.Editor.createPage(
        LOG_PAGE_NAME,
        {},
        { createFirstBlock: true },
      );
    }

    if (page?.uuid) {
      logPageUuid = page.uuid;
      await logseq.Editor.insertBlock(
        page.uuid,
        `=== ${PROJECT_NAME} session start ${new Date().toISOString()} ===`,
        { sibling: false },
      );
      logPageReady = true;
    }
  } catch (e) {
    console.error(format(`failed to init log page: ${(e as Error).message}`));
  }
}

async function initPageLogger() {
  if (!pageLoggingEnabled) {
    return;
  }
  await ensureLogPage();
}

// Though it doesn't provide the name, at least it does compile check
// https://stackoverflow.com/a/50470026
function nameof<T>(name: Extract<keyof T, string>): string {
  return name;
}

function setPageLoggingEnabled(enabled: boolean) {
  pageLoggingEnabled = enabled;
}

function log(message: string) {
  console.log(format(message));
  appendLog("INFO", message);
}

function error(message: string) {
  console.error(format(message));
  appendLog("ERROR", message);
}

function appendLog(level: string, message: string) {
  if (!pageLoggingEnabled) {
    return;
  }
  if (logging) {
    return;
  }

  logging = true;
  (async () => {
    try {
      if (!logPageReady) {
        await ensureLogPage();
      }

      if (!logPageUuid) {
        return;
      }

      const line = `${new Date().toISOString()} [${level}] ${format(message)}`;
      await logseq.Editor.insertBlock(logPageUuid, line, { sibling: true });
    } catch (e) {
      console.error(format(`failed to append log: ${(e as Error).message}`));
    } finally {
      logging = false;
    }
  })();
}

function showMsg(message: string) {
  logseq.UI.showMsg(format(message));
}

function showError(message: string) {
  logseq.UI.showMsg(format(message), "error");
}

function getDateString(date: Date) {
  const d = {
    day: `${date.getDate()}`.padStart(2, "0"),
    month: `${date.getMonth() + 1}`.padStart(2, "0"),
    year: date.getFullYear(),
  };

  return `${d.year}${d.month}${d.day}`;
}

function getTimestampString(date: Date) {
  const t = {
    hour: `${date.getHours()}`.padStart(2, "0"),
    minute: `${date.getMinutes()}`.padStart(2, "0"),
  };

  return `${t.hour}:${t.minute}`;
}

function isMessageAuthorized(message: Message.ServiceMessage): boolean {
  if (!message.from?.username) {
    log("Invalid username from message");
    return false;
  }

  if (settings.authorizedUsers.length > 0) {
    if (!settings.authorizedUsers.includes(message.from.username)) {
      log(`Unauthorized username: ${message.from.username}`);
      return false;
    }
  }

  const chatIds = settings.chatIds;
  if (!(message.from.username in chatIds)) {
    chatIds[message.from.username] = message.chat.id;
  }

  settings.chatIds = chatIds;

  return true;
}

function convertBlocksToText(
  root: BlockEntity,
  addId: boolean,
  tab: string,
  indent: string,
): string {
  if (!root) {
    error("Block doesn't include content");
    return "";
  }

  let text = indent + root.content + (addId ? `(\`${root.uuid}\`)` : "") + "\n";
  if (root.children) {
    for (let child of root.children) {
      text += convertBlocksToText(
        child as BlockEntity,
        addId,
        tab,
        indent + tab,
      );
    }
  }

  return text;
}

function stringifyBlocks(root: BlockEntity, addId: boolean) {
  return convertBlocksToText(root, addId, "\t\t", "");
}
