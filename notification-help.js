const elements = {
  platformBadge: document.querySelector("#platformBadge"),
  permissionBadge: document.querySelector("#permissionBadge"),
  permissionValue: document.querySelector("#permissionValue"),
  platformValue: document.querySelector("#platformValue"),
  activeValue: document.querySelector("#activeValue"),
  sendTestButton: document.querySelector("#sendTestButton"),
  openChromeNotificationsButton: document.querySelector("#openChromeNotificationsButton"),
  openExtensionsButton: document.querySelector("#openExtensionsButton"),
  copyDiagnosticsButton: document.querySelector("#copyDiagnosticsButton"),
  toolStatus: document.querySelector("#toolStatus"),
  tabButtons: Array.from(document.querySelectorAll(".tab-button")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel"))
};

let diagnostics = {
  platform: "Unknown",
  platformKey: "recommended",
  permission: "unknown",
  activeNotifications: 0,
  userAgent: navigator.userAgent,
  extensionVersion: chrome.runtime.getManifest().version,
  extensionId: chrome.runtime.id
};

function setStatus(message = "", type = "") {
  elements.toolStatus.textContent = message;
  elements.toolStatus.className = `tool-status ${type}`.trim();
}

function detectPlatform() {
  const source = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();

  if (source.includes("win")) {
    return { name: "Windows", key: "windows" };
  }
  if (source.includes("mac")) {
    return { name: "macOS", key: "macos" };
  }
  if (source.includes("linux") || source.includes("x11")) {
    return { name: "Linux", key: "linux" };
  }
  return { name: "Unknown platform", key: "recommended" };
}

function activateTab(tabId, scroll = false) {
  for (const button of elements.tabButtons) {
    button.classList.toggle("active", button.dataset.tab === tabId);
  }
  for (const panel of elements.tabPanels) {
    panel.classList.toggle("active", panel.id === tabId);
  }
  if (scroll) {
    document.querySelector(".tab-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function openUrl(url) {
  try {
    await chrome.tabs.create({ url });
  } catch (error) {
    setStatus(`Could not open the page: ${error.message}`, "error");
  }
}

async function readDiagnostics() {
  const platform = detectPlatform();
  diagnostics.platform = platform.name;
  diagnostics.platformKey = platform.key;

  try {
    diagnostics.permission = await chrome.notifications.getPermissionLevel();
    const active = await chrome.notifications.getAll();
    diagnostics.activeNotifications = Object.keys(active || {}).length;
  } catch (error) {
    diagnostics.permission = `error: ${error.message}`;
    diagnostics.activeNotifications = "unknown";
  }

  elements.platformBadge.textContent = platform.name;
  elements.platformValue.textContent = platform.name;
  elements.permissionValue.textContent = diagnostics.permission;
  elements.activeValue.textContent = String(diagnostics.activeNotifications);

  elements.permissionBadge.classList.remove("neutral", "error");
  if (diagnostics.permission === "granted") {
    elements.permissionBadge.textContent = "Extension permission: granted";
  } else {
    elements.permissionBadge.textContent = `Extension permission: ${diagnostics.permission}`;
    elements.permissionBadge.classList.add("error");
  }

  // Keep Recommended visible first, but visually guide the user to their OS tab.
  const matchingButton = elements.tabButtons.find(
    (button) => button.dataset.tab === platform.key
  );
  if (matchingButton && platform.key !== "recommended") {
    matchingButton.title = `Detected system: ${platform.name}`;
  }
}

elements.sendTestButton.addEventListener("click", async () => {
  elements.sendTestButton.disabled = true;
  setStatus("Sending a test notification…");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_NOTIFICATION",
      delayMs: 0
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The test could not be created.");
    }

    setStatus(
      "Test created. Wait five seconds, then check both the banner area and notification center/history.",
      "success"
    );
    await readDiagnostics();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.sendTestButton.disabled = false;
  }
});

elements.openChromeNotificationsButton.addEventListener("click", () => {
  openUrl("chrome://settings/content/notifications");
});

elements.openExtensionsButton.addEventListener("click", () => {
  openUrl("chrome://extensions/");
});

elements.copyDiagnosticsButton.addEventListener("click", async () => {
  const report = [
    "Island Watcher notification diagnostics",
    `Generated: ${new Date().toLocaleString()}`,
    `Platform: ${diagnostics.platform}`,
    `Extension notification permission: ${diagnostics.permission}`,
    `Active extension notifications: ${diagnostics.activeNotifications}`,
    `Extension version: ${diagnostics.extensionVersion}`,
    `Extension ID: ${diagnostics.extensionId}`,
    `User agent: ${diagnostics.userAgent}`
  ].join("\n");

  try {
    await navigator.clipboard.writeText(report);
    setStatus("Diagnostics copied to the clipboard.", "success");
  } catch (error) {
    setStatus(`Could not copy diagnostics: ${error.message}`, "error");
  }
});

for (const button of elements.tabButtons) {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
}

for (const button of document.querySelectorAll("[data-internal-url]")) {
  button.addEventListener("click", () => openUrl(button.dataset.internalUrl));
}

for (const link of document.querySelectorAll("[data-external-url]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openUrl(link.dataset.externalUrl);
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      const original = button.textContent;
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1300);
    } catch (error) {
      setStatus(`Could not copy command: ${error.message}`, "error");
    }
  });
}

readDiagnostics();
