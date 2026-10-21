import { DEFAULT_SETTINGS, normalizeSettings, getTargetBytes, formatBytes, api } from "./settings.js";

const enabledControl = document.querySelector("#enabled");
const videoEnabledControl = document.querySelector("#video-enabled");
const videoGifEnabledControl = document.querySelector("#video-gif-enabled");
const targetControl = document.querySelector("#target-mb");
const targetHelp = document.querySelector("#target-help");
const status = document.querySelector("#save-status");

let currentSettings = { ...DEFAULT_SETTINGS };
let saveQueue = Promise.resolve();

function showStatus(message, state = "") {
  status.textContent = message;
  status.dataset.state = state;
}

function render(settings) {
  currentSettings = normalizeSettings(settings);
  enabledControl.checked = currentSettings.enabled;
  videoEnabledControl.checked = currentSettings.videoEnabled;
  videoGifEnabledControl.checked = currentSettings.videoGifEnabled;
  videoGifEnabledControl.disabled = !currentSettings.videoEnabled;
  targetControl.value = String(currentSettings.targetMB);
  targetHelp.textContent = `Target size: ${formatBytes(getTargetBytes(currentSettings))}`;
}

async function loadSettings() {
  try {
    const result = await api.storage.local.get("settings");
    render(result?.settings);
    showStatus("Settings loaded");
  } catch (error) {
    render(DEFAULT_SETTINGS);
    showStatus("Could not load settings", "error");
  } finally {
    enabledControl.disabled = false;
    videoEnabledControl.disabled = false;
    videoGifEnabledControl.disabled = !currentSettings.videoEnabled;
    targetControl.disabled = false;
  }
}

function saveSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  render(normalized);
  showStatus("Saving…");

  saveQueue = saveQueue.then(async () => {
    try {
      const settings = normalizeSettings(currentSettings);
      await api.storage.local.set({ settings });
      showStatus("Saved", "saved");
    } catch (error) {
      showStatus("Could not save settings", "error");
    }
  });
  return saveQueue;
}

enabledControl.addEventListener("change", () => {
  saveSettings({ ...currentSettings, enabled: enabledControl.checked });
});

videoEnabledControl.addEventListener("change", () => {
  saveSettings({ ...currentSettings, videoEnabled: videoEnabledControl.checked });
});

videoGifEnabledControl.addEventListener("change", () => {
  saveSettings({ ...currentSettings, videoGifEnabled: videoGifEnabledControl.checked });
});

targetControl.addEventListener("change", () => {
  const entered = Number(targetControl.value);
  const targetMB = Number.isFinite(entered) ? Math.min(20, Math.max(1, Math.round(entered))) : currentSettings.targetMB;
  saveSettings({ ...currentSettings, targetMB });
});

loadSettings();
