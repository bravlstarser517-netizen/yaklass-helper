// Background service worker: handles Gemini API calls from content scripts.
//
// We do API calls from the background (service worker) instead of the
// content script for two reasons:
//   1) avoid CORS surprises;
//   2) keep the API key out of page scope.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Per-key cooldown after a 429 / quota error. We persist this in
// chrome.storage.local because Manifest V3 service workers are short-lived
// and the in-memory Map is otherwise lost between page navigations.
const COOLDOWN_MS = 70_000; // a bit over 60s, free-tier RPM window is ~60s
const STORAGE_KEY = "key_cooldowns";

// Minimum gap between Gemini requests, to spread load across the free-tier
// per-minute window. Persisted across SW restarts.
const MIN_REQUEST_INTERVAL_MS = 4_000;
const LAST_REQUEST_KEY = "last_gemini_request";

// Hard cap on how long we wait for keys to cool down inside a single call.
const MAX_WAIT_FOR_COOLDOWN_MS = 75_000;

async function readCooldowns() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function writeCooldowns(map) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: map });
  } catch (_) {}
}

async function readLastRequest() {
  try {
    const data = await chrome.storage.local.get(LAST_REQUEST_KEY);
    return data[LAST_REQUEST_KEY] || 0;
  } catch (_) {
    return 0;
  }
}

async function writeLastRequest(t) {
  try {
    await chrome.storage.local.set({ [LAST_REQUEST_KEY]: t });
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GEMINI_REQUEST") {
    handleGeminiRequest(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep channel open for async response
  }
});

async function handleGeminiRequest({ apiKeys, apiKey, model, prompt, images, systemInstruction }) {
  // Accept either an array of keys (new) or a single key (legacy).
  const keys = Array.isArray(apiKeys) && apiKeys.length
    ? apiKeys.slice()
    : (apiKey ? [apiKey] : []);
  if (!keys.length) throw new Error("Нет API ключей Gemini");
  if (!model) throw new Error("Не выбрана модель");

  // Throttle: ensure at least MIN_REQUEST_INTERVAL_MS between calls.
  const last = await readLastRequest();
  const since = Date.now() - last;
  if (since < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - since);
  }

  // Possibly wait for the soonest fresh key if every key is cooling down.
  let cooldowns = await readCooldowns();
  const allCoolingDown = () => keys.every((k) => (cooldowns[k] || 0) > Date.now());
  if (allCoolingDown()) {
    const soonest = Math.min(...keys.map((k) => cooldowns[k] || 0));
    const waitMs = Math.min(soonest - Date.now(), MAX_WAIT_FOR_COOLDOWN_MS);
    if (waitMs > 0) {
      console.log(`[yaklass-helper] All keys cooling down, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs + 250);
      cooldowns = await readCooldowns();
    }
  }

  let lastErr = null;
  // Try fresh keys first, then ones that are still cooling down (as a
  // last-ditch retry — maybe quota was just refreshed).
  const now = Date.now();
  const ordered = [
    ...keys.filter((k) => (cooldowns[k] || 0) <= now),
    ...keys.filter((k) => (cooldowns[k] || 0) > now),
  ];

  for (const key of ordered) {
    try {
      await writeLastRequest(Date.now());
      const result = await callOnce({ key, model, prompt, images, systemInstruction });
      // Mark this key as last-used (no cooldown extension).
      return result;
    } catch (e) {
      lastErr = e;
      const transient = /HTTP (?:429|5\d\d)|quota|rate/i.test(e.message);
      if (transient) {
        cooldowns[key] = Date.now() + COOLDOWN_MS;
        await writeCooldowns(cooldowns);
        continue; // try next key
      }
      throw e; // permanent error: do not try other keys
    }
  }
  throw lastErr || new Error("Все ключи исчерпаны");
}

async function callOnce({ key, model, prompt, images, systemInstruction }) {
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const parts = [{ text: prompt }];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img?.data && img?.mimeType) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    }
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      response_mime_type: "application/json",
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { role: "system", parts: [{ text: systemInstruction }] };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Gemini HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new Error("Gemini вернул пустой ответ");

  const textOut = (candidate.content?.parts || [])
    .map((p) => p.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!textOut) {
    const finishReason = candidate.finishReason || "unknown";
    throw new Error(`Gemini не вернул текста (finishReason=${finishReason})`);
  }

  return parseLooseJson(textOut);
}

function parseLooseJson(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const slice = cleaned.slice(first, last + 1);
      try {
        return JSON.parse(slice);
      } catch (e) {
        throw new Error("Не удалось распарсить JSON от Gemini: " + e.message);
      }
    }
    throw new Error("Gemini вернул не-JSON ответ");
  }
}
