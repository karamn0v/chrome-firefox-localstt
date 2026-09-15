(() => {
  if (globalThis.gigaamRecorder) return;

  let mediaRecorder = null;
  let chunks = [];
  let mimeType = "audio/webm";
  let maxTimer = null;
  const MAX_MS = 90_000;

  async function startRecording() {
    if (isRecording()) return { ok: true, mimeType };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    mimeType = pickMimeType();
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    mediaRecorder.start(250);
    playCue("start");
    clearTimeout(maxTimer);
    maxTimer = setTimeout(async () => {
      if (!isRecording()) return;
      const result = await stopRecording();
      chrome.runtime.sendMessage({ type: "recording-finished", ...result }).catch(() => {});
    }, MAX_MS);
    return { ok: true, mimeType };
  }

  function stopRecording() {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder || mediaRecorder.state === "inactive") {
        resolve({ ok: false, message: "Запись уже остановлена." });
        return;
      }

      clearTimeout(maxTimer);
      playCue("stop");
      const recorder = mediaRecorder;
      const tracks = recorder.stream.getTracks();
      recorder.addEventListener("stop", async () => {
        tracks.forEach((track) => track.stop());
        mediaRecorder = null;
        const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
        chunks = [];
        if (blob.size < 2000) {
          resolve({ ok: false, message: "Слишком короткая запись." });
          return;
        }
        const audio = await blobToDataUrl(blob);
        resolve({ ok: true, audio, mimeType: blob.type });
      });
      recorder.addEventListener("error", (event) => {
        reject(event.error || new Error("MediaRecorder error"));
      });
      recorder.stop();
    });
  }

  function isRecording() {
    return Boolean(mediaRecorder && mediaRecorder.state === "recording");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch {
      const field = document.createElement("textarea");
      field.value = text;
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      return ok ? { ok: true } : { ok: false, message: "Не удалось скопировать текст." };
    }
  }

  function pickMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function playCue(kind) {
    const notes = kind === "start" ? [880, 1175] : [784, 523];
    const ctx = new AudioContext();
    const start = () => {
      const now = ctx.currentTime;
      notes.forEach((freq, index) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = freq;
        const from = now + index * 0.07;
        const to = from + 0.08;
        gain.gain.setValueAtTime(0.0001, from);
        gain.gain.exponentialRampToValueAtTime(0.1, from + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, to);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(from);
        oscillator.stop(to + 0.02);
      });
      setTimeout(() => ctx.close().catch(() => {}), 400);
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(start).catch(() => {});
      return;
    }
    start();
  }

  function classify(error) {
    const name = error?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") return "permission";
    if (name === "NotFoundError") return "device";
    return "other";
  }

  globalThis.gigaamRecorder = {
    startRecording,
    stopRecording,
    isRecording,
    copyText,
    classify,
  };
})();
