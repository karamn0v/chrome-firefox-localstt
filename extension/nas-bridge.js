const iframe = document.getElementById("nas");

chrome.storage.sync.get({ serverUrl: "http://192.168.88.176:9876" }, (settings) => {
  const base = String(settings.serverUrl || "").replace(/\/+$/, "");
  if (base && !iframe.getAttribute("src")) iframe.src = `${base}/health`;
});
