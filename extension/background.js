const OFFSCREEN_URL = "offscreen.html";
const DEFAULTS = {
  serverUrl: "http://192.168.88.176:9876",
  insertIntoPage: true,
  copyToClipboard: true,
};

let state = "idle";
let transcribeAbort = null;
let stopping = false;
let lastToggleAt = 0;
let nasHelperTabId = null;

function migrateSettings(saved) {
  const next = { ...DEFAULTS, ...saved };
  if (!saved?.serverUrl || saved.serverUrl.includes("192.168.1.10")) {
    next.serverUrl = DEFAULTS.serverUrl;
  }
  return next;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (saved) => {
    chrome.storage.sync.set(migrateSettings(saved));
  });
});

chrome.storage.sync.get(DEFAULTS, (saved) => {
  if (!saved?.serverUrl || saved.serverUrl.includes("192.168.1.10")) {
    chrome.storage.sync.set(migrateSettings(saved));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "get-state") {
    getLiveState().then((live) => sendResponse({ state: live })).catch(() => sendResponse({ state }));
    return true;
  }
  if (message?.type === "toggle-dictation") {
    toggleDictation().then(() => getLiveState()).then((live) => sendResponse({ state: live })).catch((error) => {
      sendResponse({ state, error: String(error?.message || error) });
    });
    return true;
  }
  if (message?.type === "ptt-down") {
    startIfIdle().catch(() => {});
    return false;
  }
  if (message?.type === "ptt-up") {
    stopIfRecording().catch(() => {});
    return false;
  }
  if (message?.type === "ping-server") {
    pingServer(message.serverUrl)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === "page-ptt-down") {
    setState("recording").catch(() => {});
    broadcastHud("recording").catch(() => {});
    return false;
  }
  if (message?.type === "recorder-error") {
    if (message.error === "permission") {
      chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") }).catch(() => {});
    }
    notify("Микрофон недоступен", message.message || "Разрешите микрофон для этой страницы.");
    setState("idle").catch(() => {});
    broadcastHud("error", message.message || "Микрофон недоступен").catch(() => {});
    return false;
  }
  if (message?.type === "inject-content") {
    injectIntoOpenTabs().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  }
  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (message?.type === "recording-finished") {
    handleRecordingResult(message).catch((error) => {
      notify("Ошибка распознавания", String(error?.message || error));
      setState("idle");
    });
    return false;
  }
  return false;
});

function ephemeralStorage() {
  return chrome.storage?.session || chrome.storage?.local || null;
}

async function readEphemeral(defaults) {
  const area = ephemeralStorage();
  if (!area?.get) return defaults;
  return area.get(defaults);
}

async function writeEphemeral(patch) {
  const area = ephemeralStorage();
  if (!area?.set) return;
  await area.set(patch);
}

async function isMicLive() {
  const saved = await readEphemeral({ recording: false });
  if (saved.recording) return true;
  try {
    const status = await sendToRecorder({ type: "is-recording" });
    if (status?.recording) return true;
  } catch {
    /* offscreen may be absent */
  }
  return state === "recording";
}

async function getLiveState() {
  if (state === "transcribing") return "transcribing";
  if (await isMicLive()) {
    if (state !== "recording") await setState("recording");
    return "recording";
  }
  return state === "recording" ? "idle" : state;
}

async function toggleDictation() {
  const now = Date.now();
  if (now - lastToggleAt < 350) return;
  lastToggleAt = now;
  if (state === "transcribing") return;
  if (await isMicLive()) {
    await stopAndTranscribe();
    return;
  }
  await startRecording();
}

async function startIfIdle() {
  if (state === "transcribing") return;
  if (await isMicLive()) return;
  await startRecording();
}

async function stopIfRecording() {
  if (state === "transcribing") return;
  if (await isMicLive()) await stopAndTranscribe();
}

async function startRecording() {
  const started = await sendToRecorder({ type: "start-recording" });
  if (!started?.ok) {
    if (started?.error === "permission") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
    }
    await notify("Микрофон недоступен", started?.message || "Разрешите доступ к микрофону.");
    await setState("idle");
    return;
  }
  await setState("recording");
  await broadcastHud("recording");
}

async function stopAndTranscribe() {
  if (stopping || state === "transcribing") return;
  stopping = true;
  try {
    const stopped = await sendToRecorder({ type: "stop-recording" });
    await handleRecordingResult(stopped);
  } finally {
    stopping = false;
  }
}

async function handleRecordingResult(stopped) {
  if (state === "transcribing") return;
  if (!stopped?.ok || !stopped.audio) {
    await setState("idle");
    await broadcastHud("idle");
    if (stopped?.message) await notify("Запись не получилась", stopped.message);
    return;
  }

  await setState("transcribing");
  await broadcastHud("transcribing");

  try {
    const settings = await getSettings();
    const text = await transcribe(settings.serverUrl, stopped.audio, stopped.mimeType);
    if (!text) {
      await notify("Пустой ответ", "Модель ничего не распознала. Попробуйте ещё раз.");
      return;
    }

    let inserted = false;
    if (settings.insertIntoPage) {
      inserted = await insertIntoActiveTab(text);
    }
    if (settings.copyToClipboard || !inserted) {
      try {
        await copyText(text);
      } catch (error) {
        if (!inserted) throw error;
      }
    }

    await broadcastHud("done", text);
  } catch (error) {
    const message = String(error?.message || error);
    await broadcastHud("error", message);
    await notify("Ошибка распознавания", message);
  } finally {
    await setState("idle");
  }
}

async function pingServer(serverUrl) {
  const base = normalizeServerUrl(serverUrl);
  const health = await nasJson(base, "/health");
  let ready = {};
  let readyOk = false;
  try {
    ready = await nasJson(base, "/ready");
    readyOk = isReadyPayload(ready);
  } catch (error) {
    ready = { reason: String(error?.message || error) };
  }
  return { ok: true, health, ready, readyOk };
}

function isReadyPayload(ready) {
  const status = String(ready?.status || "").toLowerCase();
  if (["ready", "ok", "healthy"].includes(status)) return true;
  if (ready?.ready === true) return true;
  if (["loading", "not_ready", "starting", "unhealthy", "error"].includes(status)) return false;
  return Boolean(ready && typeof ready === "object" && !ready.reason);
}

async function transcribe(serverUrl, dataUrl, mimeType) {
  const base = normalizeServerUrl(serverUrl);
  const filename = mimeType?.includes("mp4") ? "speech.mp4" : "speech.webm";
  const result = await nasRequest(base, {
    path: "/v1/audio/transcriptions",
    method: "POST",
    base64: dataUrl.split(",")[1],
    mimeType: mimeType || "audio/webm",
    filename,
  });
  if (!result.ok) throw new Error(httpError(result.status, result.text));
  const payload = JSON.parse(result.text || "{}");
  return String(payload?.text || "").trim();
}

async function nasJson(base, path) {
  const result = await nasRequest(base, { path, method: "GET" });
  if (hasOffscreenApi() && !result.ok) throw new Error(httpError(result.status, result.text));
  try {
    return JSON.parse(result.text || "{}");
  } catch {
    throw new Error("NAS вернул не JSON.");
  }
}

async function nasRequest(base, spec) {
  try {
    return await nasExtensionFetch(base, spec);
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
  }
  return nasViaNavigation(base, spec);
}

async function nasExtensionFetch(base, spec) {
  transcribeAbort?.abort();
  transcribeAbort = new AbortController();
  const options = { method: spec.method || "GET", signal: transcribeAbort.signal };
  if (spec.base64) {
    const binary = Uint8Array.from(atob(spec.base64), (c) => c.charCodeAt(0));
    const file = new File([binary], spec.filename || "speech.webm", {
      type: spec.mimeType || "audio/webm",
    });
    const body = new FormData();
    body.append("model", "gigaam-v3-e2e-rnnt");
    body.append("file", file);
    body.append("response_format", "json");
    body.append("language", "ru");
    options.body = body;
  }
  const response = await fetch(`${base}${spec.path}`, options);
  return { ok: response.ok, status: response.status, text: await response.text() };
}

function isNetworkFailure(error) {
  const text = String(error?.message || error);
  return /networkerror|failed to fetch|network request|ns_error/i.test(text);
}

async function nasViaNavigation(base, spec) {
  try {
    return await nasViaBridge(base, spec);
  } catch (bridgeError) {
    try {
      return await nasViaTopLevelTab(base, spec);
    } catch (tabError) {
      throw new Error(`${bridgeError.message} / ${tabError.message}`);
    }
  }
}

async function nasViaBridge(base, spec) {
  const origin = new URL(base).origin;
  const tabId = await ensureBridgeTab();
  if (spec.base64) {
    await setBridgeIframe(tabId, `${base}/health`);
    await injectFormSubmit(tabId, { origin, base, ...spec });
    const text = await waitForJson(tabId, (json) => typeof json?.text === "string" || json?.detail || json?.error, 120000);
    const payload = JSON.parse(text);
    const ok = typeof payload.text === "string";
    return { ok, status: ok ? 200 : 500, text };
  }
  await setBridgeIframe(tabId, `${base}${spec.path}`);
  const text = await waitForJson(tabId, (json) => json && typeof json === "object", 15000);
  return { ok: true, status: 200, text };
}

async function nasViaTopLevelTab(base, spec) {
  const origin = new URL(base).origin;
  const path = spec.base64 ? "/health" : spec.path;
  const tab = await chrome.tabs.create({ url: `${base}${path}`, active: false });
  await waitTabComplete(tab.id, origin, 15000);
  await delay(400);
  if (spec.base64) {
    await injectFormSubmit(tab.id, { origin, base, ...spec });
    const text = await waitForJson(tab.id, (json) => typeof json?.text === "string" || json?.detail || json?.error, 120000);
    const payload = JSON.parse(text);
    const ok = typeof payload.text === "string";
    return { ok, status: ok ? 200 : 500, text };
  }
  const text = await waitForJson(tab.id, (json) => json && typeof json === "object", 15000);
  return { ok: true, status: 200, text };
}

async function waitForJson(tabId, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "пустой ответ";
  while (Date.now() < deadline) {
    const text = await readJsonFromTab(tabId);
    if (text) {
      try {
        const json = JSON.parse(text);
        if (accept(json)) return text;
        lastError = "неожиданный JSON";
      } catch (error) {
        lastError = String(error?.message || error);
      }
    }
    await delay(250);
  }
  throw new Error(`Не удалось прочитать ответ NAS со служебной вкладки (${lastError}). Перезагрузите дополнение на about:debugging.`);
}

async function readJsonFromTab(tabId) {
  const attempts = [{ world: "MAIN" }, {}];
  for (const extra of attempts) {
    try {
      const entries = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: extractJsonText,
        ...extra,
      });
      const text = entries?.map((entry) => entry?.result).find((value) => typeof value === "string" && value.includes("{"));
      if (text) return text;
    } catch {
      /* MAIN world or host permission may be missing */
    }
  }
  try {
    const viaContent = await chrome.tabs.sendMessage(tabId, { type: "nas-read-json" });
    if (typeof viaContent?.text === "string" && viaContent.text.includes("{")) return viaContent.text;
  } catch {
    /* no content script in this frame yet */
  }
  return "";
}

function extractJsonText() {
  const blobs = [
    document.querySelector("pre")?.textContent,
    document.body?.innerText,
    document.documentElement?.textContent,
  ];
  for (const raw of blobs) {
    if (!raw) continue;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = raw.slice(start, end + 1).trim();
      if (slice.startsWith("{")) return slice;
    }
  }
  return "";
}

async function injectFormSubmit(tabId, spec) {
  const attempts = [{ world: "MAIN" }, {}];
  let lastError = null;
  for (const extra of attempts) {
    try {
      const entries = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: submitNasForm,
        args: [spec],
        ...extra,
      });
      if (entries?.some((entry) => entry?.result?.submitted)) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || "Не удалось отправить запись на NAS со служебной вкладки.");
}

function submitNasForm(spec) {
  if (location.origin !== spec.origin) return { skipped: true };
  const binary = Uint8Array.from(atob(spec.base64), (c) => c.charCodeAt(0));
  const file = new File([binary], spec.filename || "speech.webm", { type: spec.mimeType || "audio/webm" });
  const form = document.createElement("form");
  form.method = "POST";
  form.action = spec.path;
  form.enctype = "multipart/form-data";
  const fields = {
    model: "gigaam-v3-e2e-rnnt",
    response_format: "json",
    language: "ru",
  };
  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.name = "file";
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  form.appendChild(fileInput);
  document.documentElement.appendChild(form);
  form.submit();
  return { submitted: true };
}

async function ensureBridgeTab() {
  const bridgeUrl = chrome.runtime.getURL("nas-bridge.html");
  if (nasHelperTabId != null) {
    try {
      const tab = await chrome.tabs.get(nasHelperTabId);
      if (tab?.url && tab.url.startsWith(bridgeUrl)) return tab.id;
    } catch {
      /* closed */
    }
    nasHelperTabId = null;
  }
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url && tab.url.startsWith(bridgeUrl));
  if (existing?.id) {
    nasHelperTabId = existing.id;
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: bridgeUrl, active: false });
  nasHelperTabId = tab.id;
  await waitTabComplete(tab.id, new URL(bridgeUrl).origin, 15000);
  await delay(200);
  return tab.id;
}

async function setBridgeIframe(tabId, url) {
  const [entry] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (src) => {
      const iframe = document.getElementById("nas");
      if (!iframe) throw new Error("no iframe");
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: "iframe timeout" }), 15000);
        const done = (ok, error) => {
          clearTimeout(timer);
          iframe.onload = null;
          iframe.onerror = null;
          resolve({ ok, error });
        };
        iframe.onload = () => done(true);
        iframe.onerror = () => done(false, "iframe error");
        iframe.src = "about:blank";
        requestAnimationFrame(() => {
          iframe.src = src;
        });
      });
    },
    args: [url],
  });
  if (!entry?.result?.ok) {
    throw new Error(entry?.result?.error || "Служебный iframe NAS не загрузился. Проверьте CSP/прокси и адрес http://192.168.88.176:9876/health.");
  }
}

function waitTabComplete(tabId, origin, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Служебная вкладка NAS не загрузилась за 15 с."));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    function done() {
      cleanup();
      resolve();
    }
    function onUpdated(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === "complete" && tab.url?.startsWith(origin)) done();
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        cleanup();
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab?.status === "complete" && tab.url?.startsWith(origin)) {
        done();
        return;
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

function httpError(status, details) {
  if (status === 403) return "NAS отклонил запрос (CORS / Origin). Проверьте docker-compose.";
  if (status === 503) return "Модель ещё загружается. Подождите готовности /ready.";
  if (status === 413) return "Слишком длинная запись. Говорите короче.";
  return `Сервер ответил ${status}${details ? `: ${details.slice(0, 180)}` : ""}`;
}

async function insertIntoActiveTab(text) {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: insertTextInPage,
      args: [text],
    });
    return Boolean(results?.some((entry) => entry?.result));
  } catch {
    return false;
  }
}

function insertTextInPage(text) {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return false;

  const isInput =
    el instanceof HTMLInputElement &&
    !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(el.type);
  const isTextarea = el instanceof HTMLTextAreaElement;

  if (isInput || isTextarea) {
    if (el.readOnly || el.disabled) return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
    const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    const caret = start + text.length;
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      /* some input types reject selection */
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  const editable = el.isContentEditable || el.getAttribute?.("contenteditable") === "true";
  if (editable) {
    el.focus();
    const ok = document.execCommand("insertText", false, text);
    if (ok) return true;
    const selection = window.getSelection();
    if (selection && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      return true;
    }
  }

  return document.execCommand("insertText", false, text);
}

async function copyText(text) {
  const result = await sendToRecorder({ type: "copy-text", text });
  if (!result?.ok) throw new Error(result?.message || "Не удалось скопировать текст.");
}

function hasOffscreenApi() {
  return Boolean(chrome.offscreen?.createDocument);
}

async function ensureRecorder() {
  if (hasOffscreenApi()) {
    await ensureOffscreen();
    return;
  }
  await ensureFirefoxRecorder();
}

async function ensureFirefoxRecorder() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("Откройте вкладку http/https — в Firefox запись идёт через страницу.");
  }
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "mount-recorder", url });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (src) => {
        const id = "gigaam-stt-recorder";
        if (document.getElementById(id)) return;
        const frame = document.createElement("iframe");
        frame.id = id;
        frame.src = src;
        frame.allow = "microphone";
        frame.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none;";
        document.documentElement.appendChild(frame);
      },
      args: [url],
    });
  }
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (!existing.length) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "CLIPBOARD", "AUDIO_PLAYBACK"],
        justification: "Запись микрофона, звуковые сигналы старт/стоп и копирование текста.",
      });
    } catch (error) {
      const text = String(error?.message || error);
      if (!text.includes("single offscreen") && !text.includes("Only a single")) {
        throw error;
      }
    }
    await delay(120);
  }
}

async function sendToRecorder(message) {
  if (!hasOffscreenApi()) {
    return sendToPageRecorder(message);
  }
  try {
    await ensureRecorder();
  } catch (error) {
    return { ok: false, message: String(error?.message || error) };
  }
  let lastError = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const result = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  return { ok: false, message: String(lastError?.message || "Не удалось связаться с записью микрофона.") };
}

async function sendToPageRecorder(message) {
  const tab = await getActiveTab();
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    return { ok: false, message: "Откройте обычную вкладку http/https и нажмите F5, затем Alt+Z." };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["recorder.js", "content.js"],
    });
  } catch {
    /* tab may already have the scripts */
  }
  let lastError = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { kind: "recorder-command", ...message }, { frameId: 0 });
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  return {
    ok: false,
    message: String(lastError?.message || "Обновите страницу (F5) и снова нажмите Alt+Z."),
  };
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !/^https?:/.test(tab.url || "")) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["recorder.js", "content.js"],
      });
    } catch {
      /* restricted pages */
    }
  }));
}

if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    injectIntoOpenTabs().catch(() => {});
  });
}
injectIntoOpenTabs().catch(() => {});

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

function normalizeServerUrl(url) {
  return String(url || DEFAULTS.serverUrl).trim().replace(/\/+$/, "");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function setState(next) {
  state = next;
  await writeEphemeral({ state: next, recording: next === "recording" });
  const badge = next === "recording" ? "REC" : next === "transcribing" ? "…" : "";
  const color = next === "recording" ? "#e11d48" : "#f59e0b";
  await chrome.action.setBadgeText({ text: badge });
  if (badge) await chrome.action.setBadgeBackgroundColor({ color });
  chrome.runtime.sendMessage({ type: "state-changed", state: next }).catch(() => {});
}

async function broadcastHud(hudState, text = "") {
  chrome.runtime.sendMessage({ type: "stt-hud", state: hudState, text }).catch(() => {});
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "stt-hud", state: hudState, text });
  } catch {
    /* restricted pages have no content script */
  }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message: String(message).slice(0, 220),
      silent: true,
    });
  } catch {
    /* notifications may be blocked */
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
