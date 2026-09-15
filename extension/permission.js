const statusEl = document.getElementById("status");

document.getElementById("ask").addEventListener("click", async () => {
  statusEl.textContent = "Запрашиваю доступ…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    statusEl.className = "ok";
    statusEl.textContent = "Готово. Можно закрыть вкладку и диктовать.";
  } catch (error) {
    statusEl.className = "err";
    statusEl.textContent = `Отказ: ${error.message}`;
  }
});
