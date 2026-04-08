// ── Content Script: Runs on Quora pages ─────────────────────────────────────
// Handles typing answers and clicking submit directly in the browser

function delay(min, max) {
  const ms = Math.random() * (max - min) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeText(element, text, delayMin = 15, delayMax = 40) {
  element.focus();
  for (const char of text) {
    const event = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: char,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);

    // Use execCommand as fallback for contenteditable
    document.execCommand("insertText", false, char);

    await delay(delayMin, delayMax);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "typeAndPost") {
    handleTypeAndPost(msg.answerText)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleTypeAndPost(answerText) {
  // Step 1: Find and click the Answer button
  const answerBtn = findButton(["Answer"]);
  if (!answerBtn) {
    throw new Error(
      "Could not find the Answer button. Make sure you are on a Quora question page."
    );
  }

  answerBtn.click();
  await delay(2000, 4000);

  // Step 2: Find the editor
  const editorSelectors = [
    '.doc [contenteditable="true"]',
    '[contenteditable="true"][data-placeholder]',
    '[role="textbox"]',
    '.q-box [contenteditable="true"]',
    '[contenteditable="true"]',
  ];

  let editor = null;
  for (const sel of editorSelectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      editor = els[els.length - 1]; // use last match
      break;
    }
  }

  if (!editor) {
    throw new Error("Could not find the answer editor.");
  }

  editor.click();
  editor.focus();
  await delay(500, 1000);

  // Step 3: Type the answer paragraph by paragraph
  const paragraphs = answerText.split("\n");
  for (let i = 0; i < paragraphs.length; i++) {
    await typeText(editor, paragraphs[i]);
    if (i < paragraphs.length - 1) {
      // Press Enter for new paragraph
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      });
      editor.dispatchEvent(enterEvent);
      document.execCommand("insertLineBreak");
      await delay(200, 500);
    }
  }

  await delay(2000, 3000);

  // Step 4: Click Submit/Post
  const submitBtn = findButton(["Post", "Submit"]);
  if (!submitBtn) {
    throw new Error(
      "Could not find the Post/Submit button. The answer was typed but not submitted."
    );
  }

  submitBtn.click();
  await delay(4000, 6000);

  // Try to get the answer URL
  let answerUrl = window.location.href;
  const answerLinks = document.querySelectorAll('a[href*="/answer/"]');
  if (answerLinks.length > 0) {
    const href = answerLinks[answerLinks.length - 1].getAttribute("href");
    if (href) {
      answerUrl = href.startsWith("/")
        ? `https://www.quora.com${href}`
        : href;
    }
  }

  return { success: true, answerUrl };
}

function findButton(texts) {
  // Try multiple strategies to find a button with matching text
  const allButtons = document.querySelectorAll(
    'button, [role="button"], a.q-box'
  );
  for (const btn of allButtons) {
    const btnText = (btn.textContent || "").trim();
    for (const text of texts) {
      if (btnText === text || btnText.startsWith(text)) {
        return btn;
      }
    }
  }
  return null;
}
