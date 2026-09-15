const toggle = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const settings = document.getElementById("settings");

const labels = {
  idle: { status: "Готов к диктовке", button: "Начать диктовку" },
  recording: { status: "Слушаю микрофон…", button: "Стоп и распознать" },
  transcribing: { status: "Отправляю на NAS…", button: "Распознаю…" },
};

function render(state) {
  const view = labels[state] || labels.idle;
  statusEl.textContent = view.status;
  toggle.textContent = view.button;
  toggle.disabled = state === "transcribing";
  document.body.dataset.state = state;
}

function refresh() {
  chrome.runtime.sendMessage({ type: "get-state" }, (response) => {
    if (chrome.runtime.lastError) return;
    render(response?.state || "idle");
  });
}

refresh();
setInterval(refresh, 400);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "state-changed") render(message.state);
  if (message?.type === "stt-hud" && message.state === "done") {
    resultEl.hidden = false;
    resultEl.textContent = message.text;
  }
});

toggle.addEventListener("click", () => {
  toggle.disabled = true;
  chrome.runtime.sendMessage({ type: "toggle-dictation" }, (response) => {
    render(response?.state || "idle");
    if (response?.error) {
      resultEl.hidden = false;
      resultEl.textContent = response.error;
    }
  });
});

settings.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "open-options" });
});
