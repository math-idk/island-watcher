const elements = {
  addMenuButton: document.querySelector("#addMenuButton"),
  settingsButton: document.querySelector("#settingsButton"),
  addPanel: document.querySelector("#addPanel"),
  settingsPanel: document.querySelector("#settingsPanel"),
  addForm: document.querySelector("#addForm"),
  islandCode: document.querySelector("#islandCode"),
  addButton: document.querySelector("#addButton"),
  addStatus: document.querySelector("#addStatus"),
  settingsStatus: document.querySelector("#settingsStatus"),
  refreshButton: document.querySelector("#refreshButton"),
  testNotificationButton: document.querySelector("#testNotificationButton"),
  notificationHelpButton: document.querySelector("#notificationHelpButton"),
  notify24h: document.querySelector("#notify24h"),
  notifyAllTime: document.querySelector("#notifyAllTime"),
  intervalButtons: Array.from(document.querySelectorAll(".interval-button")),
  countdownText: document.querySelector("#countdownText"),
  favoritesList: document.querySelector("#favoritesList"),
  favoriteTemplate: document.querySelector("#favoriteTemplate"),
  lastUpdated: document.querySelector("#lastUpdated")
};

let currentState = {
  settings: {
    notify24h: true,
    notifyAllTime: true,
    refreshMinutes: 5
  },
  favorites: [],
  favoriteOrder: [],
  nextRefreshAt: null
};

let addPanelOpen = false;
let settingsPanelOpen = false;
let countdownTimer = null;
let countdownSyncPending = false;
let stateReloadTimer = null;
let draggedCode = null;
let dragWasActive = false;

function formatCodeInput(value) {
  const digits = String(value).replace(/\D/g, "").slice(0, 12);
  return [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8, 12)]
    .filter(Boolean)
    .join("-");
}

function extractIslandCode(value) {
  const raw = String(value ?? "").trim();
  const dashedMatch = raw.match(/(?:^|\D)(\d{4})-(\d{4})-(\d{4})(?:\D|$)/);

  if (dashedMatch) {
    return `${dashedMatch[1]}-${dashedMatch[2]}-${dashedMatch[3]}`;
  }

  if (/^\d{12}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  }

  throw new Error(
    "Enter a valid island code or a Fortnite.GG / Fortnite.com island link."
  );
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("en-US").format(value)
    : "—";
}

function formatAllTimeAge(timestamp) {
  const numericTimestamp = Number(timestamp);

  // null becomes 0 in JavaScript, which would incorrectly point to 1970.
  // Only accept realistic timestamps from the year 2000 onward.
  if (
    timestamp === null ||
    timestamp === undefined ||
    timestamp === "" ||
    !Number.isFinite(numericTimestamp) ||
    numericTimestamp < Date.UTC(2000, 0, 1)
  ) {
    return "";
  }

  const elapsed = Math.max(0, Date.now() - numericTimestamp);
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);
  const years = Math.floor(days / 365.2425);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  if (days < 365) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setFormStatus(message = "", type = "") {
  elements.addStatus.textContent = message;
  elements.addStatus.className = `form-status ${type}`.trim();
}

function setSettingsStatus(message = "", type = "") {
  elements.settingsStatus.textContent = message;
  elements.settingsStatus.className = `form-status settings-status ${type}`.trim();
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "The extension could not complete the action.");
  }
  return response;
}

function openIsland(code) {
  chrome.tabs.create({
    url: `https://fortnite.gg/island/${encodeURIComponent(code)}`
  });
}

function hasFavorites() {
  return Boolean(currentState.favorites?.length);
}

function syncPanels() {
  if (!hasFavorites()) {
    addPanelOpen = true;
  }

  elements.addPanel.hidden = !addPanelOpen;
  elements.settingsPanel.hidden = !settingsPanelOpen;

  elements.addMenuButton.classList.toggle("active", addPanelOpen);
  elements.settingsButton.classList.toggle("active", settingsPanelOpen);
  elements.addMenuButton.setAttribute("aria-expanded", String(addPanelOpen));
  elements.settingsButton.setAttribute("aria-expanded", String(settingsPanelOpen));
}

function updateCountdown() {
  const nextRefreshAt = Number(currentState.nextRefreshAt);

  if (!Number.isFinite(nextRefreshAt)) {
    elements.countdownText.textContent = "Next update in --:--";
    return;
  }

  const remaining = nextRefreshAt - Date.now();
  elements.countdownText.textContent = `Next update in ${formatCountdown(remaining)}`;

  if (remaining <= 0 && !countdownSyncPending) {
    countdownSyncPending = true;
    window.setTimeout(async () => {
      try {
        await loadState();
      } catch {
        // The next storage update will synchronize the timer.
      } finally {
        countdownSyncPending = false;
      }
    }, 700);
  }
}

function startCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }
  updateCountdown();
  countdownTimer = window.setInterval(updateCountdown, 1000);
}

async function saveCurrentFavoriteOrder() {
  const codes = Array.from(
    elements.favoritesList.querySelectorAll(".favorite-card")
  )
    .map((card) => card.dataset.code)
    .filter(Boolean);

  if (!codes.length) return;

  try {
    const response = await sendMessage({
      type: "REORDER_FAVORITES",
      codes
    });
    currentState = response.state;
  } catch (error) {
    setFormStatus(error.message, "error");
    await loadState();
  }
}

function getDragAfterElement(container, clientY) {
  const cards = [
    ...container.querySelectorAll(".favorite-card:not(.dragging)")
  ];

  return cards.reduce(
    (closest, card) => {
      const box = card.getBoundingClientRect();
      const offset = clientY - box.top - box.height / 2;

      if (offset < 0 && offset > closest.offset) {
        return { offset, element: card };
      }

      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function createEmptyState() {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML = `
    <strong>No favorite islands yet</strong>
    Add your first island above to start tracking player counts.
  `;
  return empty;
}

function renderFavorite(favorite) {
  const fragment = elements.favoriteTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".favorite-card");
  const thumbnail = fragment.querySelector(".thumbnail");
  const name = fragment.querySelector(".map-name");
  const code = fragment.querySelector(".map-code");
  const current = fragment.querySelector(".current-value");
  const peak24 = fragment.querySelector(".peak24-value");
  const allTime = fragment.querySelector(".alltime-value");
  const allTimeAge = fragment.querySelector(".alltime-age");
  const status = fragment.querySelector(".card-status");
  const dragHandle = fragment.querySelector(".drag-handle");
  const removeButton = fragment.querySelector(".remove-button");

  card.dataset.code = favorite.code;

  name.textContent = favorite.name || `Island ${favorite.code}`;
  code.textContent = favorite.code;

  thumbnail.src = favorite.thumbnail || "icons/icon48.png";
  thumbnail.alt = favorite.name ? `${favorite.name} thumbnail` : "Island thumbnail";
  thumbnail.addEventListener("error", () => {
    if (!thumbnail.src.endsWith("/icons/icon48.png")) {
      thumbnail.src = "icons/icon48.png";
    }
  }, { once: true });

  current.textContent = formatNumber(favorite.stats?.current);
  peak24.textContent = formatNumber(favorite.stats?.peak24);
  allTime.textContent = formatNumber(favorite.stats?.allTime);
  const ageText = formatAllTimeAge(favorite.allTimeOccurredAt);
  const dateText = typeof favorite.allTimeDateLabel === "string"
    ? favorite.allTimeDateLabel.trim()
    : "";
  allTimeAge.textContent = ageText || dateText;
  allTimeAge.hidden = !(ageText || dateText);

  if (favorite.error) {
    status.textContent = favorite.error;
    status.classList.add("error");
    card.title = favorite.error;
  } else if (favorite.updatedAt) {
    status.textContent = `Updated at ${formatTime(favorite.updatedAt)}`;
    if (favorite.warning) {
      status.classList.add("warning");
      card.title = favorite.warning;
    }
  } else {
    status.textContent = "Waiting for the first update…";
  }

  card.addEventListener("click", () => {
    if (dragWasActive) {
      dragWasActive = false;
      return;
    }
    openIsland(favorite.code);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openIsland(favorite.code);
    }
  });

  dragHandle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  dragHandle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  dragHandle.addEventListener("dragstart", (event) => {
    draggedCode = favorite.code;
    dragWasActive = true;
    card.classList.add("dragging");

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", favorite.code);
  });

  dragHandle.addEventListener("dragend", async () => {
    card.classList.remove("dragging");
    for (const item of elements.favoritesList.querySelectorAll(".drag-over")) {
      item.classList.remove("drag-over");
    }

    draggedCode = null;
    await saveCurrentFavoriteOrder();

    window.setTimeout(() => {
      dragWasActive = false;
    }, 120);
  });

  removeButton.addEventListener("click", async (event) => {
    event.stopPropagation();

    const confirmed = confirm(
      `Remove ${favorite.name || favorite.code} from your favorites?`
    );
    if (!confirmed) return;

    removeButton.disabled = true;

    try {
      const response = await sendMessage({
        type: "REMOVE_FAVORITE",
        code: favorite.code
      });
      currentState = response.state;
      render();
    } catch (error) {
      setFormStatus(error.message, "error");
      removeButton.disabled = false;
    }
  });

  return fragment;
}

function renderIntervals() {
  const selected = Number(currentState.settings?.refreshMinutes || 5);

  for (const button of elements.intervalButtons) {
    const active = Number(button.dataset.minutes) === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }
}

function render() {
  elements.notify24h.checked = Boolean(currentState.settings?.notify24h);
  elements.notifyAllTime.checked = Boolean(currentState.settings?.notifyAllTime);
  renderIntervals();
  syncPanels();
  elements.favoritesList.replaceChildren();

  const favorites = currentState.favorites || [];

  if (!favorites.length) {
    elements.favoritesList.append(createEmptyState());
    elements.lastUpdated.textContent = "";
    startCountdown();
    return;
  }

  for (const favorite of favorites) {
    elements.favoritesList.append(renderFavorite(favorite));
  }

  const latestUpdate = Math.max(
    0,
    ...favorites.map((favorite) => favorite.updatedAt || 0)
  );

  elements.lastUpdated.textContent = latestUpdate
    ? `Last updated: ${formatTime(latestUpdate)}`
    : "";

  startCountdown();
}

async function loadState() {
  const response = await sendMessage({ type: "GET_STATE" });
  currentState = response.state;
  render();
}

async function refreshAll() {
  elements.refreshButton.disabled = true;
  elements.refreshButton.classList.add("loading");
  elements.refreshButton.title = "Refreshing…";

  try {
    const response = await sendMessage({ type: "REFRESH_ALL" });
    currentState = response.state;
    render();
  } catch (error) {
    setFormStatus(error.message, "error");
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.classList.remove("loading");
    elements.refreshButton.title = "Refresh now";
  }
}

async function saveNotificationSettings() {
  try {
    const response = await sendMessage({
      type: "UPDATE_SETTINGS",
      notify24h: elements.notify24h.checked,
      notifyAllTime: elements.notifyAllTime.checked
    });
    currentState = response.state;
    render();
    setSettingsStatus("Notification preferences saved.", "success");
  } catch (error) {
    setSettingsStatus(error.message, "error");
    await loadState();
  }
}

async function saveRefreshInterval(minutes) {
  try {
    const response = await sendMessage({
      type: "UPDATE_SETTINGS",
      refreshMinutes: minutes
    });
    currentState = response.state;
    render();
    setSettingsStatus(
      `Refresh interval set to ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
      "success"
    );
  } catch (error) {
    setSettingsStatus(error.message, "error");
    await loadState();
  }
}

function scheduleStateReload() {
  clearTimeout(stateReloadTimer);
  stateReloadTimer = window.setTimeout(() => {
    loadState().catch(() => {});
  }, 150);
}

elements.addMenuButton.addEventListener("click", () => {
  if (!hasFavorites()) {
    addPanelOpen = true;
  } else {
    addPanelOpen = !addPanelOpen;
    if (addPanelOpen) settingsPanelOpen = false;
  }

  syncPanels();
  if (addPanelOpen) elements.islandCode.focus();
});

elements.settingsButton.addEventListener("click", () => {
  settingsPanelOpen = !settingsPanelOpen;
  if (settingsPanelOpen && hasFavorites()) addPanelOpen = false;
  setSettingsStatus();
  syncPanels();
});

elements.islandCode.addEventListener("input", () => {
  const value = elements.islandCode.value;
  if (/^[\d\s-]*$/.test(value)) {
    elements.islandCode.value = formatCodeInput(value);
  }
  setFormStatus();
});

elements.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  let code;
  try {
    code = extractIslandCode(elements.islandCode.value);
  } catch (error) {
    setFormStatus(error.message, "error");
    return;
  }

  elements.addButton.disabled = true;
  elements.islandCode.disabled = true;
  setFormStatus("Loading the island from Fortnite.GG…");

  try {
    const response = await sendMessage({
      type: "ADD_FAVORITE",
      code
    });

    currentState = response.state;
    elements.islandCode.value = "";
    addPanelOpen = false;

    if (response.warning) {
      const isError = Boolean(response.favorite?.error);
      setFormStatus(
        isError
          ? `The island was saved, but it could not be updated: ${response.warning}`
          : `Island added. ${response.warning}`,
        isError ? "error" : "warning"
      );
    } else {
      setFormStatus("Island added to favorites.", "success");
    }

    render();
  } catch (error) {
    setFormStatus(error.message, "error");
  } finally {
    elements.addButton.disabled = false;
    elements.islandCode.disabled = false;
  }
});

elements.favoritesList.addEventListener("dragover", (event) => {
  if (!draggedCode) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";

  const draggingCard = elements.favoritesList.querySelector(".favorite-card.dragging");
  if (!draggingCard) return;

  const afterElement = getDragAfterElement(elements.favoritesList, event.clientY);

  for (const item of elements.favoritesList.querySelectorAll(".drag-over")) {
    item.classList.remove("drag-over");
  }

  if (afterElement) {
    afterElement.classList.add("drag-over");
    elements.favoritesList.insertBefore(draggingCard, afterElement);
  } else {
    elements.favoritesList.appendChild(draggingCard);
  }
});

elements.favoritesList.addEventListener("drop", (event) => {
  if (!draggedCode) return;
  event.preventDefault();
});

elements.refreshButton.addEventListener("click", refreshAll);
elements.notify24h.addEventListener("change", saveNotificationSettings);
elements.notifyAllTime.addEventListener("change", saveNotificationSettings);

elements.testNotificationButton.addEventListener("click", () => {
  elements.testNotificationButton.disabled = true;
  setSettingsStatus("Closing the popup and sending a background test…", "success");

  chrome.runtime.sendMessage({ type: "TEST_NOTIFICATION" }).catch(() => {
    // The popup may close before the response returns. The background task
    // continues and will display an error in its service-worker console if needed.
  });

  window.setTimeout(() => window.close(), 180);
});

elements.notificationHelpButton.addEventListener("click", async () => {
  elements.notificationHelpButton.disabled = true;

  try {
    await sendMessage({ type: "OPEN_NOTIFICATION_HELP" });
    window.close();
  } catch (error) {
    setSettingsStatus(error.message, "error");
    elements.notificationHelpButton.disabled = false;
  }
});

for (const button of elements.intervalButtons) {
  button.addEventListener("click", () => {
    saveRefreshInterval(Number(button.dataset.minutes));
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    (changes.favorites || changes.settings || changes.favoriteOrder)
  ) {
    scheduleStateReload();
  }
});

(async () => {
  try {
    // Show locally saved values immediately, then always request fresh data
    // whenever the popup is opened.
    await loadState();
    if (hasFavorites()) {
      await refreshAll();
    }
  } catch (error) {
    setFormStatus(error.message, "error");
  }
})();
