const ALARM_NAME = "refresh-fortnite-islands";
const DEFAULT_REFRESH_MINUTES = 5;
const ALLOWED_REFRESH_MINUTES = [1, 2, 5, 10];
const DATA_PARSER_VERSION = 6;
const OFFSCREEN_PATH = "offscreen.html";
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  notify24h: true,
  notifyAllTime: true,
  refreshMinutes: DEFAULT_REFRESH_MINUTES
};

let creatingOffscreenDocument = null;
let refreshAllPromise = null;

function normalizeCode(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 12) {
    throw new Error("Enter a valid 12-digit island code, for example 8257-3753-1968.");
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
}

function normalizeRefreshMinutes(value) {
  const minutes = Number(value);
  return ALLOWED_REFRESH_MINUTES.includes(minutes)
    ? minutes
    : DEFAULT_REFRESH_MINUTES;
}

function islandUrl(code) {
  return `https://fortnite.gg/island/${encodeURIComponent(code)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function toFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }

  if (typeof value !== "string") return NaN;

  const cleaned = value.trim().toUpperCase();
  if (!cleaned) return NaN;

  const suffix = cleaned.match(/([KMB])$/)?.[1] || "";
  let numeric = cleaned.replace(/[^\d.,-]/g, "");
  if (!numeric) return NaN;

  if (suffix) {
    const lastSeparator = Math.max(numeric.lastIndexOf("."), numeric.lastIndexOf(","));
    if (lastSeparator >= 0) {
      numeric = `${numeric.slice(0, lastSeparator).replace(/[.,]/g, "")}.${numeric
        .slice(lastSeparator + 1)
        .replace(/[.,]/g, "")}`;
    }
    const base = Number(numeric);
    const multiplier = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : 1e9;
    return Number.isFinite(base) ? Math.round(base * multiplier) : NaN;
  }

  const number = Number(numeric.replace(/[.,]/g, ""));
  return Number.isFinite(number) ? number : NaN;
}

function normalizeKey(key) {
  return String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collectMetricNumbers(value, output = []) {
  const direct = toFiniteNumber(value);
  if (Number.isFinite(direct)) {
    output.push(direct);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectMetricNumbers(item, output);
    return output;
  }

  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      collectMetricNumbers(value.value, output);
      return output;
    }

    for (const child of Object.values(value)) {
      collectMetricNumbers(child, output);
    }
  }

  return output;
}

function findNumbersForKeys(root, keyPredicate) {
  const values = [];
  const visited = new WeakSet();

  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (keyPredicate(normalizeKey(key))) {
        collectMetricNumbers(child, values);
      }
      visit(child);
    }
  }

  visit(root);
  return values.filter(Number.isFinite);
}

function findFirstStringForKeys(root, acceptedKeys) {
  const queue = [root];
  const visited = new WeakSet();

  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        acceptedKeys.includes(normalizeKey(key)) &&
        typeof child === "string" &&
        child.trim()
      ) {
        return child.trim();
      }
    }

    queue.push(...Object.values(value));
  }

  return "";
}

function findImageUrl(root) {
  const preferredKeys = [
    "thumbnailurl",
    "thumbnail",
    "imageurl",
    "image",
    "lobbyimageurl",
    "squareimageurl",
    "coverimageurl"
  ];

  const candidate = findFirstStringForKeys(root, preferredKeys);
  if (!candidate) return "";

  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get([
    "settings",
    "favorites",
    "favoriteOrder"
  ]);

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored.settings || {}),
    refreshMinutes: normalizeRefreshMinutes(stored.settings?.refreshMinutes)
  };

  const favorites = stored.favorites && typeof stored.favorites === "object"
    ? stored.favorites
    : {};

  const existingCodes = Object.keys(favorites);
  const requestedOrder = Array.isArray(stored.favoriteOrder)
    ? stored.favoriteOrder
    : [];

  const favoriteOrder = [
    ...requestedOrder.filter(
      (code, index) =>
        typeof code === "string" &&
        favorites[code] &&
        requestedOrder.indexOf(code) === index
    ),
    ...existingCodes
      .filter((code) => !requestedOrder.includes(code))
      .sort(
        (a, b) =>
          (favorites[a]?.addedAt || 0) - (favorites[b]?.addedAt || 0)
      )
  ];

  await chrome.storage.local.set({ settings, favorites, favoriteOrder });
  return { settings, favorites, favoriteOrder };
}

async function ensureAlarm(refreshMinutes, reset = false) {
  const minutes = normalizeRefreshMinutes(refreshMinutes);
  const alarm = await chrome.alarms.get(ALARM_NAME);
  const periodMatches =
    alarm && Math.abs(Number(alarm.periodInMinutes || 0) - minutes) < 0.001;

  if (!alarm || !periodMatches || reset) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: minutes,
      periodInMinutes: minutes
    });
  }

  return chrome.alarms.get(ALARM_NAME);
}

async function offscreenExists() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }

  const matchedClients = await clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  if (await offscreenExists()) return;

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["DOM_PARSER"],
    justification: "Read the public HTML of Fortnite.GG island pages."
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function parseIslandHtml(html, code) {
  await ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "PARSE_ISLAND_HTML",
    html,
    code
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The island data could not be parsed.");
  }

  return response.data;
}

function updateHistory(existingHistory, current, now) {
  const history = Array.isArray(existingHistory)
    ? existingHistory.filter(
        (entry) =>
          Array.isArray(entry) &&
          Number.isFinite(entry[0]) &&
          Number.isFinite(entry[1]) &&
          entry[0] >= now - HISTORY_WINDOW_MS
      )
    : [];

  if (Number.isFinite(current)) {
    const last = history.at(-1);
    if (!last || last[1] !== current || now - last[0] >= 2 * 60 * 1000) {
      history.push([now, current]);
    } else {
      last[0] = now;
    }
  }

  return history.slice(-400);
}

function getHistoryPeak(history) {
  const values = (history || [])
    .map((entry) => (Array.isArray(entry) ? entry[1] : NaN))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : NaN;
}

async function fetchIsland(code, existing = {}) {
  const url = islandUrl(code);
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "follow",
    headers: { Accept: "text/html,application/xhtml+xml" }
  });

  if (!response.ok) {
    throw new Error(`Fortnite.GG returned error ${response.status}.`);
  }

  const html = await response.text();
  if (!html || html.length < 500) {
    throw new Error("Fortnite.GG returned an empty or incomplete page.");
  }

  const parsed = await parseIslandHtml(html, code);
  const now = Date.now();
  const sameParser = existing?.parserVersion === DATA_PARSER_VERSION;

  const current = Number.isFinite(parsed?.stats?.current)
    ? parsed.stats.current
    : sameParser && Number.isFinite(existing?.stats?.current)
      ? existing.stats.current
      : NaN;

  const peak24 = Number.isFinite(parsed?.stats?.peak24)
    ? parsed.stats.peak24
    : sameParser && Number.isFinite(existing?.stats?.peak24)
      ? existing.stats.peak24
      : NaN;

  const allTime = Number.isFinite(parsed?.stats?.allTime)
    ? parsed.stats.allTime
    : sameParser && Number.isFinite(existing?.stats?.allTime)
      ? existing.stats.allTime
      : NaN;

  const missing = [];
  if (!Number.isFinite(current)) missing.push("current players");
  if (!Number.isFinite(peak24)) missing.push("24-hour peak");
  if (!Number.isFinite(allTime)) missing.push("all-time peak");

  if (missing.length === 3) {
    throw new Error("The Fortnite.GG page loaded, but no player statistics could be identified.");
  }

  const history = updateHistory(existing?.history, current, now);
  const warning = missing.length
    ? `Fortnite.GG did not expose ${missing.join(", ")} in this update. The last locally saved value is being shown when available.`
    : null;

  return {
    code,
    url,
    name: parsed.name || (sameParser ? existing.name : "") || `Island ${code}`,
    thumbnail: parsed.thumbnail || (sameParser ? existing.thumbnail : "") || "",
    stats: { current, peak24, allTime },
    peak24Source: "fortnite.gg",
    allTimeOccurredAt:
      Number.isFinite(parsed.allTimeOccurredAt) &&
      parsed.allTimeOccurredAt >= Date.UTC(2000, 0, 1)
        ? parsed.allTimeOccurredAt
        : sameParser &&
            Number.isFinite(existing?.allTimeOccurredAt) &&
            existing.allTimeOccurredAt >= Date.UTC(2000, 0, 1)
          ? existing.allTimeOccurredAt
          : null,
    allTimeDateLabel: typeof parsed.allTimeDateLabel === "string" && parsed.allTimeDateLabel
      ? parsed.allTimeDateLabel
      : sameParser && typeof existing?.allTimeDateLabel === "string"
        ? existing.allTimeDateLabel
        : "",
    history,
    parserVersion: DATA_PARSER_VERSION,
    updatedAt: now,
    error: null,
    warning,
    sourceWarnings: [],
    debug: parsed.debug || null
  };
}

async function createPeakNotification(record, type) {
  const code = record.code;
  const name = record.name || `Island ${code}`;
  const stats = record.stats;
  const notificationId = `fortnite-peak|${type}|${code}|${Date.now()}`;

  let title;
  let message;

  if (type === "both") {
    title = "New 24-hour peak and all-time record!";
    message = `${name} reached ${formatNumber(stats.allTime)} players.`;
  } else if (type === "all") {
    title = "New all-time record!";
    message = `${name} reached ${formatNumber(stats.allTime)} concurrent players.`;
  } else {
    title = "New 24-hour peak!";
    message = `${name} reached ${formatNumber(stats.peak24)} concurrent players.`;
  }

  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    contextMessage: code,
    priority: 2,
    buttons: [{ title: "Open on Fortnite.GG" }]
  });
}

function getNotificationPermissionLevel() {
  return new Promise((resolve, reject) => {
    chrome.notifications.getPermissionLevel((level) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(level);
    });
  });
}

function createChromeNotification(notificationId, options) {
  return new Promise((resolve, reject) => {
    chrome.notifications.create(notificationId, options, (createdId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(createdId);
    });
  });
}

function getActiveNotifications() {
  return new Promise((resolve, reject) => {
    chrome.notifications.getAll((notifications) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(notifications || {});
    });
  });
}

async function createTestNotification(delayMs = 900) {
  const permissionLevel = await getNotificationPermissionLevel();

  if (permissionLevel !== "granted") {
    throw new Error(
      "Notifications are blocked for this extension. Enable Google Chrome notifications in Windows Settings."
    );
  }

  // Wait until the extension popup has closed. This makes the test behave
  // like a real background peak alert instead of a popup-generated message.
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const notificationId = `fortnite-test|${Date.now()}`;

  const createdId = await createChromeNotification(notificationId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Notifications are working!",
    message: "Island Watcher can alert you while the popup is closed.",
    contextMessage: "Fortnite.GG Island Watcher",
    eventTime: Date.now(),
    priority: 2,
    requireInteraction: true,
    silent: false
  });

  return {
    notificationId: createdId,
    permissionLevel
  };
}

async function maybeNotify(oldRecord, newRecord, settings) {
  const oldStats = oldRecord?.stats;
  const newStats = newRecord?.stats;

  if (!oldStats || !newStats) return;

  // Uma atualização do parser vira apenas a nova referência inicial.
  if (oldRecord?.parserVersion !== newRecord?.parserVersion) return;

  const new24hRecord =
    Number.isFinite(oldStats.peak24) &&
    Number.isFinite(newStats.peak24) &&
    newStats.peak24 > oldStats.peak24;

  const newAllTimeRecord =
    Number.isFinite(oldStats.allTime) &&
    Number.isFinite(newStats.allTime) &&
    newStats.allTime > oldStats.allTime;

  const notify24 = settings.notify24h && new24hRecord;
  const notifyAll = settings.notifyAllTime && newAllTimeRecord;

  if (notify24 && notifyAll) {
    await createPeakNotification(newRecord, "both");
  } else if (notifyAll) {
    await createPeakNotification(newRecord, "all");
  } else if (notify24) {
    await createPeakNotification(newRecord, "24h");
  }
}

async function getFavorites() {
  const { favorites = {} } = await chrome.storage.local.get("favorites");
  return favorites && typeof favorites === "object" ? favorites : {};
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveFavorites(favorites) {
  await chrome.storage.local.set({ favorites });
}

async function getFavoriteOrder() {
  const { favoriteOrder = [] } = await chrome.storage.local.get("favoriteOrder");
  return Array.isArray(favoriteOrder) ? favoriteOrder : [];
}

async function saveFavoriteOrder(favoriteOrder) {
  await chrome.storage.local.set({ favoriteOrder });
}

async function refreshOne(code, allowNotifications = true) {
  const favorites = await getFavorites();
  const existing = favorites[code];

  if (!existing) {
    throw new Error("This island is no longer in your favorites.");
  }

  try {
    const fresh = await fetchIsland(code, existing);
    const updated = {
      ...existing,
      ...fresh,
      addedAt: existing.addedAt || Date.now(),
      lastAttemptAt: Date.now()
    };

    favorites[code] = updated;
    await saveFavorites(favorites);

    if (allowNotifications) {
      const settings = await getSettings();
      await maybeNotify(existing, updated, settings);
    }

    return updated;
  } catch (error) {
    const failed = {
      ...existing,
      error: error?.message || "Unknown error while updating the island.",
      warning: null,
      lastAttemptAt: Date.now()
    };
    favorites[code] = failed;
    await saveFavorites(favorites);
    return failed;
  }
}

async function refreshAll(allowNotifications = true) {
  if (refreshAllPromise) return refreshAllPromise;

  refreshAllPromise = (async () => {
    const favorites = await getFavorites();
    const codes = Object.keys(favorites);
    const results = [];
    const concurrency = 3;
    let index = 0;

    async function worker() {
      while (index < codes.length) {
        const currentIndex = index++;
        const code = codes[currentIndex];
        results[currentIndex] = await refreshOne(code, allowNotifications);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, codes.length) }, () => worker())
    );

    return results;
  })();

  try {
    return await refreshAllPromise;
  } finally {
    refreshAllPromise = null;
  }
}

async function getPublicState() {
  const { settings, favorites, favoriteOrder } = await ensureDefaults();
  const alarm = await ensureAlarm(settings.refreshMinutes);

  const favoriteList = favoriteOrder
    .map((code) => favorites[code])
    .filter(Boolean);

  return {
    settings,
    favorites: favoriteList,
    favoriteOrder,
    refreshMinutes: settings.refreshMinutes,
    nextRefreshAt:
      alarm?.scheduledTime || Date.now() + settings.refreshMinutes * 60 * 1000
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await ensureDefaults();
  await ensureAlarm(settings.refreshMinutes);
});

chrome.runtime.onStartup.addListener(async () => {
  const { settings } = await ensureDefaults();
  await ensureAlarm(settings.refreshMinutes);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await refreshAll(true);
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const [, , code] = notificationId.split("|");
  if (code) await chrome.tabs.create({ url: islandUrl(code) });
  await chrome.notifications.clear(notificationId);
});

chrome.notifications.onButtonClicked.addListener(async (notificationId) => {
  const [, , code] = notificationId.split("|");
  if (code) await chrome.tabs.create({ url: islandUrl(code) });
  await chrome.notifications.clear(notificationId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") return undefined;

  (async () => {
    switch (message.type) {
      case "GET_STATE":
        return { ok: true, state: await getPublicState() };

      case "ADD_FAVORITE": {
        const code = normalizeCode(message.code);
        const favorites = await getFavorites();

        if (!favorites[code]) {
          favorites[code] = {
            code,
            url: islandUrl(code),
            name: `Island ${code}`,
            thumbnail: "",
            stats: null,
            history: [],
            addedAt: Date.now(),
            updatedAt: null,
            lastAttemptAt: null,
            error: null,
            warning: null
          };

          const favoriteOrder = await getFavoriteOrder();
          if (!favoriteOrder.includes(code)) {
            favoriteOrder.push(code);
          }

          await chrome.storage.local.set({ favorites, favoriteOrder });
        }

        const favorite = await refreshOne(code, false);
        return {
          ok: true,
          favorite,
          warning: favorite.error || favorite.warning || null,
          state: await getPublicState()
        };
      }

      case "REMOVE_FAVORITE": {
        const code = normalizeCode(message.code);
        const favorites = await getFavorites();
        const favoriteOrder = await getFavoriteOrder();

        delete favorites[code];

        await chrome.storage.local.set({
          favorites,
          favoriteOrder: favoriteOrder.filter((item) => item !== code)
        });

        return { ok: true, state: await getPublicState() };
      }

      case "REORDER_FAVORITES": {
        const favorites = await getFavorites();
        const requestedOrder = Array.isArray(message.codes) ? message.codes : [];

        const sanitizedOrder = [
          ...requestedOrder.filter(
            (code, index) =>
              typeof code === "string" &&
              favorites[code] &&
              requestedOrder.indexOf(code) === index
          ),
          ...Object.keys(favorites).filter((code) => !requestedOrder.includes(code))
        ];

        await saveFavoriteOrder(sanitizedOrder);
        return { ok: true, state: await getPublicState() };
      }

      case "UPDATE_SETTINGS": {
        const current = await getSettings();
        const requestedRefreshMinutes =
          message.refreshMinutes === undefined
            ? current.refreshMinutes
            : normalizeRefreshMinutes(message.refreshMinutes);
        const refreshChanged = requestedRefreshMinutes !== current.refreshMinutes;

        const next = {
          ...current,
          ...(typeof message.notify24h === "boolean"
            ? { notify24h: message.notify24h }
            : {}),
          ...(typeof message.notifyAllTime === "boolean"
            ? { notifyAllTime: message.notifyAllTime }
            : {}),
          refreshMinutes: requestedRefreshMinutes
        };

        await chrome.storage.local.set({ settings: next });
        await ensureAlarm(next.refreshMinutes, refreshChanged);
        return { ok: true, state: await getPublicState() };
      }

      case "TEST_NOTIFICATION": {
        const delayMs = Number.isFinite(Number(message.delayMs))
          ? Math.max(0, Math.min(5000, Number(message.delayMs)))
          : 900;
        const notification = await createTestNotification(delayMs);
        return { ok: true, notification };
      }

      case "OPEN_NOTIFICATION_HELP": {
        const helpUrl = chrome.runtime.getURL("notification-help.html");
        await chrome.windows.create({
          url: helpUrl,
          type: "popup",
          width: 900,
          height: 820,
          focused: true
        });
        return { ok: true };
      }

      case "REFRESH_ALL": {
        await refreshAll(true);
        const { settings } = await ensureDefaults();
        // A manual refresh or popup-open refresh starts a fresh countdown.
        await ensureAlarm(settings.refreshMinutes, true);
        return { ok: true, state: await getPublicState() };
      }

      case "REFRESH_ONE": {
        const code = normalizeCode(message.code);
        await refreshOne(code, true);
        return { ok: true, state: await getPublicState() };
      }

      default:
        return { ok: false, error: "Unknown action." };
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "An unexpected error occurred."
      });
    });

  return true;
});

ensureDefaults()
  .then(({ settings }) => ensureAlarm(settings.refreshMinutes))
  .catch(console.error);
