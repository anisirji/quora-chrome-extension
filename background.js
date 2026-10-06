// ── Background Service Worker ────────────────────────────────────────────────
// Handles: SerpAPI search, OpenAI answer generation, Neon DB read/write

const SYSTEM_PROMPT = `You are writing a helpful answer to a Quora question about social media growth.

Write as a knowledgeable social media marketer sharing real experience. Professional but approachable.

CRITICAL FORMATTING RULES:
- Output PLAIN TEXT ONLY. No markdown whatsoever.
- NEVER use **bold**, *italic*, ##headings, or any markdown syntax.
- For lists, use simple numbered lines (1. 2. 3.) or dashes (- item).
- Write in natural flowing paragraphs. Keep it conversational.

Content rules:
1. Lead with genuine, actionable advice that answers the question.
2. Keep the answer 150-250 words. Short paragraphs.
3. DO NOT mention or link to any product, service, website, or brand name. No URLs at all.
4. The answer must be 100% genuinely helpful on its own — pure value, zero promotion.
5. Do not use "As an AI" or similar. Write as a real person sharing experience.
6. No false claims about guaranteed results.
7. Vary your opening — never start with "Great question".
8. Share specific, practical tips that someone can act on immediately.
9. Sound like someone who has actually grown accounts, not a generic advice blog.`;

const SEARCH_QUERIES = [
  'site:quora.com "how to grow" instagram OR youtube OR tiktok followers',
  'site:quora.com "buy followers" OR "growth service" OR "smm panel"',
  'site:quora.com "increase engagement" OR "get more views" social media',
  'site:quora.com "grow telegram" OR "grow twitter" OR "grow X followers"',
];

// ── Hardcoded DB (ours — not user-configurable) ─────────────────────────────
const DB_URL =
  "postgresql://user:password@host/dbname?sslmode=require";

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["serpApiKey", "openaiApiKey"], (result) =>
      resolve({ ...result, dbUrl: DB_URL })
    );
  });
}

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

// ── Neon DB (via HTTP SQL endpoint) ─────────────────────────────────────────

function parseNeonUrl(dbUrl) {
  // postgresql://user:pass@host/dbname?sslmode=require
  const url = new URL(dbUrl);
  const host = url.hostname;
  // Neon serverless HTTP endpoint
  const httpBase = `https://${host}`;
  return {
    httpBase,
    user: url.username,
    password: url.password,
    dbName: url.pathname.replace("/", ""),
  };
}

async function dbQuery(sql, params = []) {
  const config = await getConfig();
  if (!config.dbUrl) throw new Error("DB URL not configured");

  const neon = parseNeonUrl(config.dbUrl);
  const resp = await fetch(`${neon.httpBase}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": config.dbUrl,
    },
    body: JSON.stringify({ query: sql, params }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DB error: ${errText}`);
  }

  const raw = await resp.json();

  // Neon HTTP API can return different formats:
  // 1. { results: [{ fields, rows, ... }] }  (batch/wrapped)
  // 2. { fields, rows, ... }                 (direct)
  // 3. rows can be arrays or objects
  let result = raw;
  if (raw.results && Array.isArray(raw.results)) {
    result = raw.results[0] || { rows: [] };
  }

  const fields = result.fields;
  let rows = result.rows || [];

  // If rows are arrays (not objects), map using field names
  if (rows.length > 0 && Array.isArray(rows[0]) && fields) {
    const fieldNames = fields.map((f) => f.name);
    rows = rows.map((row) => {
      const obj = {};
      fieldNames.forEach((name, i) => {
        obj[name] = row[i];
      });
      return obj;
    });
  }

  return { ...result, rows };
}

// ── SerpAPI Search ──────────────────────────────────────────────────────────

async function searchQuora(query, apiKey, numResults = 10) {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    api_key: apiKey,
    num: numResults.toString(),
    output: "json",
  });

  const resp = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!resp.ok) throw new Error(`SerpAPI error: ${resp.status}`);

  const data = await resp.json();
  const questions = [];
  for (const r of data.organic_results || []) {
    const link = r.link || "";
    if (!link.includes("quora.com")) continue;
    const title = (r.title || "").replace(/ - Quora$/, "").trim();
    questions.push({ title, url: link });
  }
  return questions;
}

// ── OpenAI Answer Generation ────────────────────────────────────────────────

async function generateAnswer(questionTitle, apiKey) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Question: ${questionTitle}` },
      ],
      temperature: 0.85,
      max_tokens: 500,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error: ${err}`);
  }

  const data = await resp.json();
  return stripMarkdown(data.choices[0].message.content);
}

// ── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  const config = await getConfig();

  switch (msg.action) {
    // ── Fetch all entries from DB ──────────────────────────────────────
    case "fetchEntries": {
      const result = await dbQuery(
        "SELECT id, question_title, question_url, answer_text, answer_url, status, account_used, posted_at FROM entries ORDER BY id DESC"
      );
      return { rows: result.rows || [] };
    }

    // ── Extract questions via SerpAPI ──────────────────────────────────
    case "extract": {
      if (!config.serpApiKey) throw new Error("SerpAPI key not configured");

      const allQuestions = [];
      const seenUrls = new Set();

      for (const query of SEARCH_QUERIES) {
        try {
          const results = await searchQuora(query, config.serpApiKey);
          for (const q of results) {
            if (!seenUrls.has(q.url)) {
              seenUrls.add(q.url);
              allQuestions.push(q);
            }
          }
        } catch (e) {
          console.error(`Search error: ${e.message}`);
        }
      }

      // Insert into DB (skip duplicates)
      let added = 0;
      for (const q of allQuestions) {
        try {
          await dbQuery(
            "INSERT INTO entries (question_title, question_url, status, created_at) VALUES ($1, $2, 'pending', NOW()) ON CONFLICT (question_url) DO NOTHING",
            [q.title, q.url]
          );
          added++;
        } catch (e) {
          // duplicate or error, skip
        }
      }

      return { total: allQuestions.length, added };
    }

    // ── Generate AI answer for one entry ──────────────────────────────
    case "generateOne": {
      if (!config.openaiApiKey) throw new Error("OpenAI key not configured");

      const answer = await generateAnswer(msg.questionTitle, config.openaiApiKey);
      await dbQuery(
        "UPDATE entries SET answer_text = $1, status = 'answered' WHERE id = $2",
        [answer, msg.id]
      );
      return { answer };
    }

    // ── Generate AI answers for ALL pending ───────────────────────────
    case "generateAll": {
      if (!config.openaiApiKey) throw new Error("OpenAI key not configured");

      const pending = await dbQuery(
        "SELECT id, question_title FROM entries WHERE status = 'pending'"
      );
      const rows = pending.rows || [];
      let generated = 0;

      for (const row of rows) {
        try {
          const answer = await generateAnswer(row.question_title, config.openaiApiKey);
          await dbQuery(
            "UPDATE entries SET answer_text = $1, status = 'answered' WHERE id = $2",
            [answer, row.id]
          );
          generated++;
        } catch (e) {
          console.error(`Generate error for ${row.id}: ${e.message}`);
        }
      }

      return { total: rows.length, generated };
    }

    // ── Post answer on current Quora tab ──────────────────────────────
    case "postAnswer": {
      // Send message to content script on the active Quora tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || !tab.url || !tab.url.includes("quora.com")) {
        throw new Error("Navigate to a Quora question page first");
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        action: "typeAndPost",
        answerText: msg.answerText,
      });

      if (response && response.success) {
        await dbQuery(
          "UPDATE entries SET status = 'posted', account_used = $1, posted_at = NOW(), answer_url = $2 WHERE id = $3",
          [msg.account || "chrome-extension", response.answerUrl || tab.url, msg.id]
        );
      }

      return response;
    }

    // ── Mark entry status ─────────────────────────────────────────────
    case "updateStatus": {
      await dbQuery("UPDATE entries SET status = $1 WHERE id = $2", [
        msg.status,
        msg.id,
      ]);
      return { ok: true };
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}
