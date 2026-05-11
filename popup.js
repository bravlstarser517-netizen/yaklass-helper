// Popup UI logic: settings, controls, status, log.

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  apiKeys: [],
  model: "gemini-flash-latest",
  speed: "normal",
  autoNext: true,
};

const STATS_DEFAULT = { solved: 0, errors: 0, status: "stopped" };

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await refreshStatus();
  attachHandlers();
  startStatusPolling();
});

function parseKeys(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  // Migration: accept legacy single-key "apiKey" field.
  let keys = Array.isArray(data.apiKeys) ? data.apiKeys : [];
  if (!keys.length && typeof data.apiKey === "string" && data.apiKey) {
    keys = [data.apiKey.trim()];
  }
  $("apiKeys").value = keys.join("\n");
  $("model").value = data.model || DEFAULTS.model;
  $("speed").value = data.speed || DEFAULTS.speed;
  $("autoNext").checked = data.autoNext !== false;
}

async function saveSettings() {
  const settings = {
    apiKeys: parseKeys($("apiKeys").value),
    model: $("model").value,
    speed: $("speed").value,
    autoNext: $("autoNext").checked,
  };
  await chrome.storage.sync.set(settings);
  // Clean up legacy field if present.
  try { await chrome.storage.sync.remove("apiKey"); } catch (_) {}
  log(`Настройки сохранены (${settings.apiKeys.length} ключ(ей))`, "success");
  return settings;
}

function attachHandlers() {
  $("saveBtn").addEventListener("click", saveSettings);

  $("startBtn").addEventListener("click", async () => {
    const settings = await saveSettings();
    if (!settings.apiKeys.length) {
      log("Сначала введи хотя бы один Gemini API ключ", "error");
      return;
    }
    const tab = await getActiveYaklassTab();
    if (!tab) {
      log("Открой задание на yaklass.ru и попробуй снова", "error");
      return;
    }
    setControlsRunning(true);
    log("Запуск...", "info");
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        type: "START",
        settings,
      });
      if (!resp?.ok) {
        log(resp?.error || "Не удалось запустить (контент-скрипт не отвечает)", "error");
        setControlsRunning(false);
      }
    } catch (e) {
      log("Контент-скрипт не загружен. Обнови страницу yaklass и попробуй снова.", "error");
      setControlsRunning(false);
    }
  });

  $("stopBtn").addEventListener("click", async () => {
    const tab = await getActiveYaklassTab();
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "STOP" });
      } catch (_) { /* ignore */ }
    }
    setControlsRunning(false);
    log("Остановлено", "warn");
  });
}

async function getActiveYaklassTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  if (!/yaklass\.ru/.test(tab.url)) return null;
  return tab;
}

function setControlsRunning(running) {
  $("startBtn").disabled = running;
  $("stopBtn").disabled = !running;
  $("statusText").textContent = running ? "работает" : "остановлен";
}

function startStatusPolling() {
  setInterval(refreshStatus, 1000);
}

async function refreshStatus() {
  const tab = await getActiveYaklassTab();
  if (!tab) {
    $("statusText").textContent = "нет вкладки yaklass";
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
    if (resp) {
      const stats = resp.stats || STATS_DEFAULT;
      $("solvedCount").textContent = stats.solved ?? 0;
      $("errorCount").textContent = stats.errors ?? 0;
      $("statusText").textContent = stats.status || "остановлен";
      setControlsRunning(stats.status === "running");
      if (Array.isArray(resp.recentLogs)) {
        renderLogs(resp.recentLogs);
      }
    }
  } catch (_) {
    // content script not loaded yet
  }
}

const seenLogIds = new Set();

function renderLogs(entries) {
  const box = $("logBox");
  let appended = false;
  for (const entry of entries) {
    if (seenLogIds.has(entry.id)) continue;
    seenLogIds.add(entry.id);
    const div = document.createElement("div");
    div.className = `log-entry ${entry.level || "info"}`;
    const ts = new Date(entry.t).toLocaleTimeString("ru-RU", { hour12: false });
    div.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(entry.msg)}`;
    box.appendChild(div);
    appended = true;
  }
  if (appended) box.scrollTop = box.scrollHeight;
}

function log(msg, level = "info") {
  const box = $("logBox");
  const div = document.createElement("div");
  div.className = `log-entry ${level}`;
  const ts = new Date().toLocaleTimeString("ru-RU", { hour12: false });
  div.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(msg)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
