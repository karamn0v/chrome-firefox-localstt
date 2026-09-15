const DEFAULTS = {
  serverUrl: "http://192.168.88.176:9876",
  insertIntoPage: true,
  copyToClipboard: true,
};

const form = document.getElementById("form");
const statusEl = document.getElementById("status");
document.getElementById("extVersion").textContent = chrome.runtime.getManifest().version;

chrome.storage.sync.get(DEFAULTS, (settings) => {
  form.serverUrl.value = settings.serverUrl;
  form.insertIntoPage.checked = settings.insertIntoPage;
  form.copyToClipboard.checked = settings.copyToClipboard;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const serverUrl = form.serverUrl.value.trim().replace(/\/+$/, "");
  await ensureHostAccess(serverUrl);
  chrome.storage.sync.set({
    serverUrl,
    insertIntoPage: form.insertIntoPage.checked,
    copyToClipboard: form.copyToClipboard.checked,
  }, () => {
    statusEl.className = "ok";
    statusEl.textContent = "Сохранено.";
  });
});

document.getElementById("ping").addEventListener("click", async () => {
  const base = form.serverUrl.value.trim().replace(/\/+$/, "");
  const granted = await requestSiteAccess();
  if (!granted) {
    statusEl.className = "err";
    statusEl.textContent = "Firefox не дал доступ к сайтам. Нажмите «Проверить связь» ещё раз и в окне Firefox выберите «Разрешить». Если окна не было: about:addons → GigaAM STT → Разрешения → включите доступ к сайтам.";
    return;
  }
  await sendRuntime({ type: "inject-content" }).catch(() => {});
  statusEl.className = "hint";
  statusEl.textContent = "Доступ есть, проверяю /health…";
  try {
    const response = await sendRuntime({ type: "ping-server", serverUrl: base });
    if (!response?.ok) throw new Error(response?.error || "Нет ответа от расширения");
    if (!response.readyOk) {
      statusEl.className = "err";
      statusEl.textContent = `Сервер жив, но модель ещё не готова: ${response.ready?.reason || "подождите первую загрузку весов"}.`;
      return;
    }
    const health = response.health || {};
    statusEl.className = "ok";
    statusEl.textContent = `Готово. Модель: ${health.model || "unknown"}, вариант: ${health.variant || "—"}.`;
  } catch (error) {
    statusEl.className = "err";
    statusEl.textContent = `Нет связи: ${error.message}. Прокси: исключите 192.168.88.176.`;
  }
});

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function ensureHostAccess() {
  return requestSiteAccess();
}

async function requestSiteAccess() {
  if (!chrome.permissions?.request) return true;
  try {
    return await chrome.permissions.request({
      origins: ["<all_urls>", "http://*/*", "https://*/*"],
    });
  } catch {
    try {
      return await chrome.permissions.request({
        origins: ["http://*/*", "https://*/*"],
      });
    } catch {
      return false;
    }
  }
}
