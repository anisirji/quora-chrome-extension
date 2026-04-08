// ── Options Page Script ──────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Load saved settings
  chrome.storage.sync.get(["serpApiKey", "openaiApiKey"], (result) => {
    document.getElementById("serpApiKey").value = result.serpApiKey || "";
    document.getElementById("openaiApiKey").value = result.openaiApiKey || "";
  });

  // Save
  document.getElementById("saveBtn").addEventListener("click", () => {
    const settings = {
      serpApiKey: document.getElementById("serpApiKey").value.trim(),
      openaiApiKey: document.getElementById("openaiApiKey").value.trim(),
    };

    chrome.storage.sync.set(settings, () => {
      const status = document.getElementById("status");
      status.classList.add("show");
      setTimeout(() => status.classList.remove("show"), 2000);
    });
  });
});
