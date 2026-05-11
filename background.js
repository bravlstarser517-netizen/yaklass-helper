// Background service worker: handles Gemini API calls from content scripts.
//
// We do API calls from the background (service worker) instead of the
// content script for two reasons:
//   1) avoid CORS surprises;
//   2) keep the API key out of page scope.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Per-key cooldown after a 429 / quota error.
const keyCooldownUntil = new Map(); // Map<key, msEpoch>
const COOLDOWN_MS = 60_000;

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

  const now = Date.now();
  // Try fresh keys first, then ones that are still cooling down.
  const ordered = [
    ...keys.filter((k) => (keyCooldownUntil.get(k) || 0) <= now),
    ...keys.filter((k) => (keyCooldownUntil.get(k) || 0) > now),
  ];

  let lastErr = null;
  for (const key of ordered) {
    try {
      return await callOnce({ key, model, prompt, images, systemInstruction });
    } catch (e) {
      lastErr = e;
      const transient = /HTTP (?:429|5\d\d)|quota|rate/i.test(e.message);
      if (transient) {
        keyCooldownUntil.set(key, Date.now() + COOLDOWN_MS);
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
