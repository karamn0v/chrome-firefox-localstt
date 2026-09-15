chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  const recorder = globalThis.gigaamRecorder;
  if (!recorder) {
    sendResponse({ ok: false, message: "recorder missing" });
    return false;
  }
  dispatch(message, recorder).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: recorder.classify(error), message: String(error?.message || error) });
  });
  return true;
});

async function dispatch(message, recorder) {
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
