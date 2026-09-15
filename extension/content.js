if (window.__gigaamStt) {
  /* already injected after host permission grant */
} else {
window.__gigaamStt = true;

const HUD_ID = "gigaam-stt-hud";
let comboDown = false;
const isFirefox = navigator.userAgent.includes("Firefox/");

window.addEventListener("keydown", onKeyDown, true);
window.addEventListener("keyup", onKeyUp, true);
window.addEventListener("blur", onBlur);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === "offscreen") return;
  if (message?.type === "nas-read-json") {
    sendResponse({ text: extractJsonText() });
    return;
  }
  if (message?.type === "nas-request") {
    nasRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: 0, text: String(error?.message || error) }));
    return true;
  }
  if (message?.kind === "recorder-command") {
    dispatchRecorder(message)
      .then(sendResponse)
      .catch((error) => {
        const recorder = globalThis.gigaamRecorder;
        sendResponse({
          ok: false,
          error: recorder?.classify?.(error) || "other",
          message: String(error?.message || error),
        });
      });
    return true;
  }
  if (message?.type === "mount-recorder") {
    if (window !== window.top) return;
    mountRecorder(message.url);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type !== "stt-hud") return;
  if (window !== window.top) return;
  renderHud(message.state, message.text || "");
});

function onKeyDown(event) {
  if (!isHotkey(event) || event.repeat) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  comboDown = true;
  if (isFirefox) {
    const started = globalThis.gigaamRecorder.startRecording();
    chrome.runtime.sendMessage({ type: "page-ptt-down" }).catch(() => {});
    Promise.resolve(started).then((result) => {
      if (!result?.ok) {
        chrome.runtime.sendMessage({
          type: "recorder-error",
          error: result?.error || "permission",
          message: result?.message || "Разрешите микрофон для этого сайта.",
        }).catch(() => {});
        return;
      }
      if (!comboDown) {
        globalThis.gigaamRecorder.stopRecording().then((stopped) => {
          chrome.runtime.sendMessage({ type: "recording-finished", ...stopped }).catch(() => {});
        }).catch(() => {});
      }
    }).catch((error) => {
      chrome.runtime.sendMessage({
        type: "recorder-error",
        error: globalThis.gigaamRecorder?.classify?.(error) || "other",
        message: String(error?.message || error),
      }).catch(() => {});
    });
    return;
  }
  chrome.runtime.sendMessage({ type: "ptt-down" }).catch(() => {});
}

function onKeyUp(event) {
  if (!isHotkeyRelease(event)) return;
  comboDown = false;
  if (isFirefox) {
    const recorder = globalThis.gigaamRecorder;
    if (!recorder?.isRecording()) return;
    recorder.stopRecording().then((result) => {
      chrome.runtime.sendMessage({ type: "recording-finished", ...result }).catch(() => {});
    }).catch((error) => {
      chrome.runtime.sendMessage({
        type: "recorder-error",
        error: recorder.classify?.(error) || "other",
        message: String(error?.message || error),
      }).catch(() => {});
    });
    return;
  }
  chrome.runtime.sendMessage({ type: "ptt-up" }).catch(() => {});
}

function onBlur() {
  if (!comboDown) return;
  comboDown = false;
  if (isFirefox) {
    const recorder = globalThis.gigaamRecorder;
    if (!recorder?.isRecording()) return;
    recorder.stopRecording().then((result) => {
      chrome.runtime.sendMessage({ type: "recording-finished", ...result }).catch(() => {});
    }).catch(() => {});
    return;
  }
  chrome.runtime.sendMessage({ type: "ptt-up" }).catch(() => {});
}

async function dispatchRecorder(message) {
  const recorder = globalThis.gigaamRecorder;
  if (!recorder) return { ok: false, message: "recorder missing" };
  switch (message.type) {
    case "start-recording":
      return recorder.startRecording();
    case "stop-recording":
      return recorder.stopRecording();
    case "copy-text":
      return recorder.copyText(message.text);
    case "is-recording":
      return { ok: true, recording: recorder.isRecording() };
    default:
      return { ok: false, message: "unknown" };
  }
}

async function nasRequest(message) {
  if (location.origin !== message.origin) {
    return { ok: false, status: 0, text: "wrong-origin" };
  }
  const text = extractJsonText();
  if (!message.base64 && text) return { ok: true, status: 200, text };
  return { ok: false, status: 0, text: "not-ready" };
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

function mountRecorder(url) {
  const id = "gigaam-stt-recorder";
  if (document.getElementById(id)) return;
  const frame = document.createElement("iframe");
  frame.id = id;
  frame.src = url;
  frame.allow = "microphone";
  frame.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none;";
  document.documentElement.appendChild(frame);
}

function isHotkey(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return event.code === "KeyZ" || key === "z" || key === "я";
}

function isHotkeyRelease(event) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return event.code === "KeyZ" || key === "z" || key === "я" || event.key === "Alt";
}

function renderHud(state, text) {
  let hud = document.getElementById(HUD_ID);
  if (state === "idle") {
    hud?.remove();
    return;
  }
  if (!hud) {
    hud = document.createElement("div");
    hud.id = HUD_ID;
    hud.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "right:16px",
      "bottom:16px",
      "max-width:min(420px,calc(100vw - 32px))",
      "padding:10px 14px",
      "border-radius:12px",
      "background:#111827",
      "color:#f9fafb",
      "font:13px/1.4 system-ui,Segoe UI,sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.28)",
      "pointer-events:none",
    ].join(";");
    document.documentElement.appendChild(hud);
  }

  const labels = {
    recording: "Слушаю… отпустите Alt+Z / Alt+Я",
    transcribing: "Распознаю на NAS…",
    done: text,
    error: text || "Ошибка",
  };
  hud.textContent = labels[state] || text;
  hud.style.background = state === "error" ? "#9f1239" : state === "recording" ? "#be123c" : "#111827";

  if (state === "done" || state === "error") {
    setTimeout(() => {
      const current = document.getElementById(HUD_ID);
      if (current && current.textContent === hud.textContent) current.remove();
    }, 3500);
  }
}

}
