// Background service worker: handles Gemini API calls from content scripts.
//
// We do API calls from the background (service worker) instead of the
// content script for two reasons:
//   1) avoid CORS surprises;
//   2) keep the API key out of page scope.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GEMINI_REQUEST") {
    handleGeminiRequest(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep channel open for async response
  }
});

async function handleGeminiRequest({ apiKey, model, prompt, images, systemInstruction }) {
  if (!apiKey) throw new Error("Нет API ключа Gemini");
  if (!model) throw new Error("Не выбрана модель");

  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
      // Allow long enough output for explanations + structured answers.
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

  // Try to parse JSON; if model added stray text/code fences, extract JSON.
  return parseLooseJson(textOut);
}

function parseLooseJson(text) {
  // Strip Markdown code fences if model added them despite JSON mode.
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Find first { and matching last } to attempt salvage.
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
