// ── Popup Script ─────────────────────────────────────────────────────────────

let allRows = [];

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadEntries();

  document.getElementById("refreshBtn").addEventListener("click", loadEntries);
  document.getElementById("settingsBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById("extractBtn").addEventListener("click", handleExtract);
  document.getElementById("generateAllBtn").addEventListener("click", handleGenerateAll);
  document.getElementById("statusFilter").addEventListener("change", renderEntries);
  document.getElementById("searchBox").addEventListener("input", renderEntries);
});

// ── Data Loading ────────────────────────────────────────────────────────────

async function loadEntries() {
  document.getElementById("entries").innerHTML =
    '<div class="loading">Loading...</div>';

  try {
    const resp = await chrome.runtime.sendMessage({ action: "fetchEntries" });
    if (resp.error) throw new Error(resp.error);
    allRows = resp.rows || [];
    renderStats();
    renderEntries();
  } catch (err) {
    document.getElementById("entries").innerHTML =
      `<div class="empty">Failed to load: ${err.message}<br><br>Check Settings &#9881; to configure your database URL.</div>`;
  }
}

// ── Stats ───────────────────────────────────────────────────────────────────

function renderStats() {
  const total = allRows.length;
  const pending = allRows.filter((r) => r.status === "pending").length;
  const answered = allRows.filter((r) => r.status === "answered").length;
  const posted = allRows.filter((r) => r.status === "posted").length;
  const failed = allRows.filter((r) => r.status === "failed").length;

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-label">Total</div><div class="stat-value" style="color:#fff">${total}</div></div>
    <div class="stat"><div class="stat-label">Pending</div><div class="stat-value" style="color:#ffc107">${pending}</div></div>
    <div class="stat"><div class="stat-label">Answered</div><div class="stat-value" style="color:#6ea8fe">${answered}</div></div>
    <div class="stat"><div class="stat-label">Posted</div><div class="stat-value" style="color:#75d99a">${posted}</div></div>
    <div class="stat"><div class="stat-label">Failed</div><div class="stat-value" style="color:#ff6b6b">${failed}</div></div>
  `;
}

// ── Entry List ──────────────────────────────────────────────────────────────

function renderEntries() {
  const status = document.getElementById("statusFilter").value;
  const search = document.getElementById("searchBox").value.toLowerCase();
  const container = document.getElementById("entries");

  const filtered = allRows.filter((d) => {
    if (status !== "all" && d.status !== status) return false;
    if (search && !(d.question_title || "").toLowerCase().includes(search))
      return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty">No entries found.</div>';
    return;
  }

  container.innerHTML = filtered
    .map((d) => {
      const badgeClass = "badge-" + (d.status || "pending");
      const title = (d.question_title || "").substring(0, 100);
      const postedAt = d.posted_at
        ? new Date(d.posted_at).toLocaleString()
        : "";

      let actions = "";
      if (d.status === "pending") {
        actions = `<button class="btn btn-primary btn-sm" data-action="generate" data-id="${d.id}" data-title="${encodeURIComponent(d.question_title)}">Generate Answer</button>`;
      } else if (d.status === "answered") {
        actions = `<button class="btn btn-success btn-sm" data-action="post" data-id="${d.id}" data-url="${encodeURIComponent(d.question_url)}">Post on Quora</button>
                   <button class="btn btn-primary btn-sm" data-action="generate" data-id="${d.id}" data-title="${encodeURIComponent(d.question_title)}">Regenerate</button>`;
      } else if (d.status === "failed") {
        actions = `<button class="btn btn-warning btn-sm" data-action="retry" data-id="${d.id}">Retry</button>`;
      }

      const answerPreview =
        d.answer_text && d.status !== "pending"
          ? `<div class="answer-preview">${escapeHtml(d.answer_text.substring(0, 200))}${d.answer_text.length > 200 ? "..." : ""}</div>`
          : "";

      return `
        <div class="entry">
          <div class="entry-header">
            <div class="entry-title">
              <a href="${d.question_url}" target="_blank">${escapeHtml(title)}</a>
            </div>
            <span class="badge ${badgeClass}">${d.status}</span>
          </div>
          <div class="entry-meta">
            ${d.account_used ? `<span style="font-size:0.7rem;color:#888">Account: ${escapeHtml(d.account_used)}</span>` : ""}
            ${postedAt ? `<span style="font-size:0.7rem;color:#555">${postedAt}</span>` : ""}
          </div>
          ${answerPreview}
          <div class="entry-actions">${actions}</div>
        </div>
      `;
    })
    .join("");

  // Attach event listeners
  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", handleEntryAction);
  });
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function handleExtract() {
  const btn = document.getElementById("extractBtn");
  btn.textContent = "Extracting...";
  btn.disabled = true;

  try {
    const resp = await chrome.runtime.sendMessage({ action: "extract" });
    if (resp.error) throw new Error(resp.error);
    showToast(`Found ${resp.total} questions, ${resp.added} new added`, "success");
    await loadEntries();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.textContent = "Extract";
    btn.disabled = false;
  }
}

async function handleGenerateAll() {
  const btn = document.getElementById("generateAllBtn");
  btn.textContent = "Generating...";
  btn.disabled = true;

  try {
    const resp = await chrome.runtime.sendMessage({ action: "generateAll" });
    if (resp.error) throw new Error(resp.error);
    showToast(
      `Generated ${resp.generated}/${resp.total} answers`,
      "success"
    );
    await loadEntries();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.textContent = "Generate All";
    btn.disabled = false;
  }
}

async function handleEntryAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const id = parseInt(btn.dataset.id);
  const origText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  try {
    if (action === "generate") {
      const title = decodeURIComponent(btn.dataset.title);
      const resp = await chrome.runtime.sendMessage({
        action: "generateOne",
        id,
        questionTitle: title,
      });
      if (resp.error) throw new Error(resp.error);
      showToast("Answer generated", "success");
    } else if (action === "post") {
      const url = decodeURIComponent(btn.dataset.url);
      // Find the answer text from allRows
      const entry = allRows.find((r) => r.id === id);
      if (!entry || !entry.answer_text) {
        throw new Error("No answer text found for this entry");
      }

      // Check if user is on the right Quora page
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || !tab.url || !tab.url.includes("quora.com")) {
        // Open the question URL first
        await chrome.tabs.update(tab.id, { url: entry.question_url });
        showToast(
          "Navigating to question page. Click Post again when loaded.",
          "error"
        );
        btn.textContent = origText;
        btn.disabled = false;
        return;
      }

      const resp = await chrome.runtime.sendMessage({
        action: "postAnswer",
        id,
        answerText: entry.answer_text,
      });
      if (resp.error) throw new Error(resp.error);
      if (!resp.success)
        throw new Error(resp.error || "Posting failed");
      showToast("Answer posted!", "success");
    } else if (action === "retry") {
      const resp = await chrome.runtime.sendMessage({
        action: "updateStatus",
        id,
        status: "answered",
      });
      if (resp.error) throw new Error(resp.error);
      showToast("Reset to answered", "success");
    }

    await loadEntries();
  } catch (err) {
    showToast(err.message, "error");
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast toast-${type} show`;
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}
