// Content script: runs on yaklass.ru, detects page type, parses tasks,
// asks Gemini for answers, fills them in, and clicks the right buttons.
//
// All clicks go through humanClick() and all typing through humanType()
// to add randomized delays that mimic real user behavior. This helps
// avoid the platform's bot-detection on excessively fast inputs.

(() => {
  // Guard against double-injection on SPA navigations.
  if (window.__yaklass_helper_loaded__) return;
  window.__yaklass_helper_loaded__ = true;

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    running: false,
    stats: { solved: 0, errors: 0, status: "stopped" },
    settings: null,
    recentLogs: [],
    logId: 0,
    lastFingerprint: "",
    sameFingerprintCount: 0,
  };

  const MAX_LOGS = 60;
  const MAX_SAME_FINGERPRINT = 4; // stop if page doesn't change

  // -----------------------------
  // Logging
  // -----------------------------
  function log(msg, level = "info") {
    const entry = { id: ++state.logId, t: Date.now(), msg, level };
    state.recentLogs.push(entry);
    if (state.recentLogs.length > MAX_LOGS) state.recentLogs.shift();
    const tag = `%c[ЯКласс ${level}]`;
    const colors = {
      info: "color:#3b82f6",
      success: "color:#10b981",
      warn: "color:#f59e0b",
      error: "color:#ef4444",
    };
    console.log(tag, colors[level] || colors.info, msg);
  }

  // -----------------------------
  // Message handler (popup ↔ content)
  // -----------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "START") {
      if (state.running) {
        sendResponse({ ok: true, alreadyRunning: true });
        return;
      }
      state.settings = msg.settings || {};
      state.running = true;
      state.stats.status = "running";
      log("Запуск... модель=" + state.settings.model, "info");
      mainLoop().catch((e) => {
        log("Цикл упал: " + e.message, "error");
        state.running = false;
        state.stats.status = "stopped";
      });
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "STOP") {
      state.running = false;
      state.stats.status = "stopped";
      log("Остановлено", "warn");
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "GET_STATUS") {
      sendResponse({
        stats: state.stats,
        recentLogs: state.recentLogs.slice(-30),
      });
      return true;
    }
  });

  // -----------------------------
  // Human-like delays
  // -----------------------------
  function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }
  function speedRange() {
    const s = state.settings?.speed || "normal";
    if (s === "fast") return [400, 1200];
    if (s === "slow") return [2500, 5500];
    return [1200, 2800];
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async function humanPause() {
    const [a, b] = speedRange();
    await sleep(randInt(a, b));
  }

  async function humanClick(el) {
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(randInt(200, 600));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await sleep(randInt(50, 150));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await sleep(randInt(30, 80));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  }

  async function humanType(el, text) {
    if (!el) return false;
    el.focus();
    await sleep(randInt(100, 300));
    // Clear existing value.
    if ("value" in el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.textContent = "";
    }
    const chars = String(text);
    for (const ch of chars) {
      if ("value" in el) {
        el.value += ch;
      } else {
        el.textContent += ch;
      }
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(randInt(40, 130));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return true;
  }

  // -----------------------------
  // Visibility helpers
  // -----------------------------
  function isVisible(el) {
    if (!el) return false;
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function visibleText(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  // -----------------------------
  // Button lookup by text (case/accent insensitive)
  // -----------------------------
  function norm(s) {
    return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  }

  function findButtonByTexts(texts) {
    const wanted = texts.map(norm);
    const candidates = document.querySelectorAll(
      "button, input[type=button], input[type=submit], a[role=button], .button, [class*=button], [class*=btn]"
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = norm(visibleText(el) || el.value || el.getAttribute("aria-label") || "");
      if (!label) continue;
      for (const w of wanted) {
        if (label === w || label.startsWith(w) || label.includes(w)) {
          return el;
        }
      }
    }
    return null;
  }

  // -----------------------------
  // Page type detection
  // -----------------------------
  // We look at which buttons are visible. The order is important:
  //   1) "Next step / continue" buttons after a result page
  //   2) "Прочитано" on theory
  //   3) "Проверить" on task
  //   4) "Закончить попытку" / "Завершить" after result
  //
  // We also detect the task pane to extract content from.

  const BTN_NEXT = ["следующее задание", "следующий шаг", "продолжить", "далее", "дальше", "к следующему", "next step", "next"];
  const BTN_THEORY_READ = ["прочитано", "прочитать", "я прочитал", "понятно"];
  const BTN_CHECK = ["проверить", "ответить", "отправить ответ", "check", "submit"];
  const BTN_FINISH = ["закончить попытку", "завершить попытку", "завершить", "закончить", "finish"];

  function detectAction() {
    const finishBtn = findButtonByTexts(BTN_FINISH);
    const nextBtn = findButtonByTexts(BTN_NEXT);
    const readBtn = findButtonByTexts(BTN_THEORY_READ);
    const checkBtn = findButtonByTexts(BTN_CHECK);

    // Order matters: always try to solve the current task first; only when
    // there's no task to solve and no theory to dismiss do we navigate.
    // (yaklass keeps a permanent "Следующее задание" link at the bottom
    // of every task page, which used to short-circuit the task handler.)
    if (checkBtn) return { type: "task", btn: checkBtn };
    if (readBtn) return { type: "theory", btn: readBtn };
    if (nextBtn) return { type: "next", btn: nextBtn };
    if (finishBtn) return { type: "finish", btn: finishBtn };

    return { type: "unknown" };
  }

  // -----------------------------
  // Task pane discovery
  // -----------------------------
  // YaKlass content tends to live inside containers like #content, .qst,
  // .question, .task, [class*=task], [class*=question]. We pick the
  // largest visible container that contains a form control or "Проверить"
  // button.

  function findTaskContainer(checkBtn) {
    if (checkBtn) {
      // Walk up from check button until we find a sizable container.
      let el = checkBtn;
      let best = null;
      for (let i = 0; i < 12 && el && el !== document.body; i++) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 200) {
          best = el;
        }
        el = el.parentElement;
      }
      if (best) return best;
    }
    const selectors = [
      ".task-container", ".question", ".qst", "#task", ".task",
      "[class*=task]", "[class*=question]", "#content", ".content", "main",
    ];
    for (const sel of selectors) {
      const candidates = document.querySelectorAll(sel);
      for (const c of candidates) {
        if (!isVisible(c)) continue;
        const rect = c.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 150) continue;
        // must contain at least one form control or text node
        if (c.querySelector("input, textarea, select")) return c;
      }
    }
    return document.body;
  }

  // -----------------------------
  // Form element extraction
  // -----------------------------
  // We collect form controls and assign them numeric IDs. We send a
  // textual description to Gemini and ask it to return answers keyed
  // by these IDs.

  function extractFormElements(container) {
    const items = [];
    let id = 0;

    // Group radios/checkboxes by name.
    const radioGroups = new Map(); // name -> [els]
    const checkboxGroups = new Map();

    const all = container.querySelectorAll("input, textarea, select");
    for (const el of all) {
      if (el.disabled || el.readOnly) continue;
      if (el.type === "hidden") continue;

      // Radio/checkbox: many sites visually hide the real <input> and
      // present a styled label / circle. We require only that the input's
      // presentation (label or some ancestor) is visible — not the input
      // itself.
      if (el.type === "radio" || el.type === "checkbox") {
        if (!hasVisiblePresentation(el)) continue;
      } else {
        if (!isVisible(el)) continue;
      }

      if (el.type === "radio") {
        const key = el.name || "_radio_" + id;
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(el);
      } else if (el.type === "checkbox") {
        const key = el.name || "_cb_" + id;
        if (!checkboxGroups.has(key)) checkboxGroups.set(key, []);
        checkboxGroups.get(key).push(el);
      } else if (el.tagName === "SELECT") {
        const options = [...el.options]
          .filter((o) => !o.disabled)
          .map((o) => ({ value: o.value, label: visibleText(o) || o.value }));
        items.push({
          id: ++id,
          kind: "select",
          name: el.name || "",
          label: nearestLabel(el),
          options,
          el,
        });
      } else if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|number|email|search|tel|url|)$/i.test(el.type))) {
        items.push({
          id: ++id,
          kind: "text",
          name: el.name || "",
          label: nearestLabel(el),
          placeholder: el.placeholder || "",
          el,
        });
      }
    }

    for (const [name, els] of radioGroups) {
      const options = els.map((el) => ({
        label: nearestLabel(el),
        value: el.value,
        el,
        clickTarget: clickTargetFor(el),
      }));
      items.push({
        id: ++id,
        kind: "single_choice",
        name,
        label: groupLabel(els),
        options,
      });
    }

    for (const [name, els] of checkboxGroups) {
      const options = els.map((el) => ({
        label: nearestLabel(el),
        value: el.value,
        el,
        clickTarget: clickTargetFor(el),
      }));
      items.push({
        id: ++id,
        kind: "multi_choice",
        name,
        label: groupLabel(els),
        options,
      });
    }

    return items;
  }

  // For radio/checkbox: returns true if there's a visible label or ancestor
  // that the user can interact with, even if the <input> itself is hidden.
  function hasVisiblePresentation(el) {
    // Explicit <label for=id>
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && isVisible(lbl)) return true;
    }
    // Wrapping <label>
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      if (p.tagName === "LABEL" && isVisible(p)) return true;
      p = p.parentElement;
    }
    // Any ancestor that's visibly sized within ~250px of the input
    p = el.parentElement;
    for (let i = 0; i < 8 && p; i++) {
      if (isVisible(p)) {
        const r = p.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  // For radio/checkbox: returns the best DOM element to click. Prefers the
  // associated <label> when the input itself is hidden.
  function clickTargetFor(el) {
    if (isVisible(el)) return el;
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && isVisible(lbl)) return lbl;
    }
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      if (p.tagName === "LABEL" && isVisible(p)) return p;
      p = p.parentElement;
    }
    // Fallback: nearest visible ancestor.
    p = el.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      if (isVisible(p)) return p;
      p = p.parentElement;
    }
    return el;
  }

  function nearestLabel(el) {
    // Try explicit <label for=id>, then wrapping <label>, then nearby text.
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return visibleText(lbl);
    }
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (p.tagName === "LABEL") return visibleText(p);
      p = p.parentElement;
    }
    // Fallback: take the next text-bearing sibling
    let sib = el.nextSibling;
    while (sib) {
      if (sib.nodeType === Node.TEXT_NODE && sib.textContent.trim()) {
        return sib.textContent.trim();
      }
      if (sib.nodeType === Node.ELEMENT_NODE && visibleText(sib)) {
        return visibleText(sib).slice(0, 200);
      }
      sib = sib.nextSibling;
    }
    return "";
  }

  function groupLabel(els) {
    // Look up the chain for a common ancestor with a question-like label.
    if (!els.length) return "";
    let p = els[0].parentElement;
    for (let i = 0; i < 8 && p; i++) {
      const txt = visibleText(p);
      if (txt && txt.length < 400 && /[\?:]/.test(txt)) return txt.slice(0, 300);
      p = p.parentElement;
    }
    return "";
  }

  // -----------------------------
  // Extracting question text (and images)
  // -----------------------------
  // Tag each form-control element with a data-ykid attribute matching its
  // position in formItems. We use these tags in extractQuestionText() to
  // substitute each input/select with a [#N] placeholder so Gemini can
  // unambiguously map answers back to inputs even when they are interleaved
  // with body text (e.g. fill-in-the-blank questions).
  function tagFormItems(formItems) {
    for (const it of formItems) {
      if (it.kind === "single_choice" || it.kind === "multi_choice") {
        // Tag each option's underlying input.
        for (let i = 0; i < it.options.length; i++) {
          const opt = it.options[i];
          if (opt?.el) opt.el.dataset.ykid = `${it.id}.${i}`;
        }
      } else if (it.el) {
        it.el.dataset.ykid = String(it.id);
      }
    }
  }

  function clearFormItemTags(formItems) {
    for (const it of formItems) {
      if (it.kind === "single_choice" || it.kind === "multi_choice") {
        for (const opt of it.options) {
          if (opt?.el && opt.el.dataset) delete opt.el.dataset.ykid;
        }
      } else if (it.el && it.el.dataset) {
        delete it.el.dataset.ykid;
      }
    }
  }

  function extractQuestionText(container) {
    // Clone and strip script/style/buttons to get readable text. We keep
    // form-control nodes around so we can substitute them with positional
    // markers — they are removed afterwards.
    const clone = container.cloneNode(true);
    clone.querySelectorAll("script, style, button, .answer-area, [class*=answer-area]").forEach((n) => n.remove());
    // Replace MathJax/KaTeX with LaTeX where possible.
    clone.querySelectorAll("script[type='math/tex'], annotation[encoding='application/x-tex']").forEach((node) => {
      const tex = node.textContent || "";
      const span = document.createElement("span");
      span.textContent = "$" + tex + "$";
      node.replaceWith(span);
    });
    // Replace tagged inputs/selects with [#N] placeholders.
    clone.querySelectorAll("[data-ykid]").forEach((el) => {
      const ykid = el.dataset.ykid;
      const span = document.createElement("span");
      span.textContent = ` [#${ykid}] `;
      el.replaceWith(span);
    });
    // Drop any remaining form controls that weren't tagged.
    clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
    const txt = (clone.innerText || clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return txt.slice(0, 8000); // hard cap
  }

  async function extractImages(container) {
    const imgs = [...container.querySelectorAll("img")].filter(isVisible);
    const out = [];
    for (const img of imgs.slice(0, 4)) {
      // skip tiny icons
      if (img.naturalWidth && img.naturalWidth < 50) continue;
      try {
        const data = await imageToBase64(img);
        if (data) out.push(data);
      } catch (e) {
        log("Не удалось загрузить картинку: " + e.message, "warn");
      }
    }
    return out;
  }

  function imageToBase64(img) {
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        if (!canvas.width || !canvas.height) return resolve(null);
        const ctx = canvas.getContext("2d");
        // Try to draw — may throw on tainted canvas.
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        const [, mime, b64] = dataUrl.match(/^data:([^;]+);base64,(.+)$/) || [];
        if (b64) resolve({ mimeType: mime, data: b64 });
        else resolve(null);
      } catch (e) {
        resolve(null); // tainted canvas — skip silently
      }
    });
  }

  // -----------------------------
  // Build Gemini prompt
  // -----------------------------
  function buildPrompt(questionText, formItems) {
    const items = formItems.map((it) => {
      if (it.kind === "text") {
        return `#${it.id} | TEXT INPUT | label="${it.label}" placeholder="${it.placeholder}"`;
      }
      if (it.kind === "select") {
        const opts = it.options.map((o, i) => `  ${i}) ${o.label}`).join("\n");
        return `#${it.id} | DROPDOWN | label="${it.label}"\n${opts}`;
      }
      if (it.kind === "single_choice") {
        const opts = it.options.map((o, i) => `  ${i}) ${o.label}`).join("\n");
        return `#${it.id} | SINGLE CHOICE | label="${it.label}"\n${opts}`;
      }
      if (it.kind === "multi_choice") {
        const opts = it.options.map((o, i) => `  ${i}) ${o.label}`).join("\n");
        return `#${it.id} | MULTIPLE CHOICE | label="${it.label}"\n${opts}`;
      }
      return "";
    }).filter(Boolean).join("\n\n");

    return [
      "Ты решаешь задание из российской школьной онлайн-платформы (yaklass.ru) для 5–11 классов.",
      "Прочитай условие задачи и заполни форму ответа. Отвечай ТОЛЬКО валидным JSON по схеме ниже, без пояснений.",
      "",
      "В тексте условия встречаются маркеры вида [#N] (напр. [#1], [#2]) — это",
      "места, куда нужно вписать ответ. Номер в маркере соответствует id элемента",
      "в форме ответа ниже. Для вариантов выбора маркер может быть [#N.M]",
      "(N=id группы, M=индекс варианта). Строго сопоставляй ответы id-ам.",
      "",
      "СХЕМА ОТВЕТА:",
      "{",
      '  "answers": [',
      '    {"id": <номер элемента>, "value": <значение>},',
      "    ...",
      "  ],",
      '  "confidence": <число 0..1>,',
      '  "note": "<краткий комментарий по решению на русском, не более 200 символов>"',
      "}",
      "",
      "ТИПЫ value:",
      '  - TEXT INPUT → строка с ответом ("4.5", "Пушкин", "x=2")',
      '  - DROPDOWN → индекс выбранного варианта (целое число)',
      '  - SINGLE CHOICE → индекс выбранного варианта (целое число)',
      '  - MULTI CHOICE → массив индексов выбранных вариантов',
      "",
      "Если форма пустая или ответ невозможно определить — верни answers: [].",
      "",
      "=== УСЛОВИЕ ЗАДАЧИ ===",
      questionText,
      "",
      "=== ФОРМА ОТВЕТА (нужно заполнить) ===",
      items || "(нет полей)",
      "",
      "Верни JSON.",
    ].join("\n");
  }

  // -----------------------------
  // Apply answers
  // -----------------------------
  async function applyAnswers(formItems, answers) {
    if (!Array.isArray(answers)) return 0;
    const byId = new Map(formItems.map((i) => [i.id, i]));
    let applied = 0;
    for (const a of answers) {
      const item = byId.get(a.id);
      if (!item) continue;
      try {
        if (item.kind === "text") {
          await humanType(item.el, String(a.value));
          applied++;
        } else if (item.kind === "select") {
          const idx = Number(a.value);
          if (item.options[idx]) {
            item.el.value = item.options[idx].value;
            item.el.dispatchEvent(new Event("change", { bubbles: true }));
            applied++;
          }
        } else if (item.kind === "single_choice") {
          const idx = Number(a.value);
          const opt = item.options[idx];
          if (opt?.el) {
            await checkRadioOrBox(opt);
            applied++;
          }
        } else if (item.kind === "multi_choice") {
          const indices = Array.isArray(a.value) ? a.value.map(Number) : [Number(a.value)];
          // Uncheck all first
          for (const opt of item.options) {
            if (opt.el?.checked) {
              opt.el.checked = false;
              opt.el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
          for (const idx of indices) {
            const opt = item.options[idx];
            if (opt?.el) {
              await checkRadioOrBox(opt);
              applied++;
            }
          }
        }
      } catch (e) {
        log("Не смог применить ответ #" + a.id + ": " + e.message, "warn");
      }
      await sleep(randInt(150, 450));
    }
    return applied;
  }

  // -----------------------------
  // Main action loop
  // -----------------------------
  function fingerprintPage() {
    // Cheap signature for "did the page change after my action".
    const txt = (document.body.innerText || "").slice(0, 600);
    return `${location.href}|${txt}`;
  }

  async function mainLoop() {
    while (state.running) {
      try {
        const action = detectAction();
        log("Действие: " + action.type, "info");

        if (action.type === "unknown") {
          // Wait and retry; this happens during navigations.
          await sleep(1500);
          continue;
        }

        // Stuck detection
        const fp = fingerprintPage();
        if (fp === state.lastFingerprint) {
          state.sameFingerprintCount++;
        } else {
          state.sameFingerprintCount = 0;
          state.lastFingerprint = fp;
        }
        if (state.sameFingerprintCount >= MAX_SAME_FINGERPRINT) {
          log("Страница не меняется уже " + state.sameFingerprintCount + " попыток. Остановка.", "error");
          state.running = false;
          state.stats.status = "stopped";
          break;
        }

        if (action.type === "theory") {
          await humanPause();
          await humanClick(action.btn);
          log("Кликнул «Прочитано»", "success");
        } else if (action.type === "next" || action.type === "finish") {
          await humanPause();
          await humanClick(action.btn);
          log("Перешёл дальше", "success");
        } else if (action.type === "task") {
          await handleTask(action.btn);
        }

        // Wait for navigation / DOM mutation.
        await waitForPageChange(2500);
      } catch (e) {
        log("Ошибка: " + e.message, "error");
        state.stats.errors++;
        await sleep(2000);
      }
    }
    state.stats.status = "stopped";
  }

  async function waitForPageChange(timeoutMs) {
    const startFp = fingerprintPage();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fingerprintPage() !== startFp) return true;
      await sleep(150);
    }
    return false;
  }

  async function handleTask(checkBtn) {
    const container = findTaskContainer(checkBtn);
    const formItems = extractFormElements(container);
    tagFormItems(formItems);
    let questionText;
    try {
      questionText = extractQuestionText(container);
    } finally {
      clearFormItemTags(formItems);
    }

    if (!questionText.trim() && !formItems.length) {
      log("Пустой контейнер задания, пропускаю", "warn");
      return;
    }

    log(`Задание (${formItems.length} полей): ${questionText.slice(0, 120)}`, "info");
    const images = await extractImages(container);

    const prompt = buildPrompt(questionText, formItems);
    log("Отправляю запрос в Gemini...", "info");

    let result;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "GEMINI_REQUEST",
        payload: {
          apiKeys: state.settings.apiKeys,
          model: state.settings.model,
          prompt,
          images,
          systemInstruction:
            "Ты эксперт по школьной программе РФ (5–11 классы): математика, физика, химия, биология, русский язык, литература, история, английский, обществознание, информатика. Отвечай ТОЛЬКО валидным JSON, без пояснений вокруг.",
        },
      });
      if (!resp?.ok) throw new Error(resp?.error || "no response");
      result = resp.result;
    } catch (e) {
      log("Gemini ошибка: " + e.message, "error");
      state.stats.errors++;
      return;
    }

    const answers = result?.answers || [];
    log(`Получен ответ: ${answers.length} полей, conf=${result?.confidence ?? "?"}`, "info");
    if (result?.note) log("Пояснение: " + result.note, "info");

    const applied = await applyAnswers(formItems, answers);
    log(`Заполнил ${applied} из ${formItems.length} полей`, applied ? "success" : "warn");

    await humanPause();

    // Re-locate the check button in case the DOM was reshuffled after we
    // typed into inputs (rare but happens when sites re-render on change).
    const submitBtn = findButtonByTexts(BTN_CHECK) || checkBtn;
    if (submitBtn && isVisible(submitBtn)) {
      await humanClick(submitBtn);
      log("Нажал «Проверить»", "success");
      state.stats.solved++;
    } else {
      log("Не нашёл кнопку «Проверить» после заполнения", "warn");
    }
  }

  // Robustly check a radio / checkbox option: click the visible target,
  // also click the input directly, force-set .checked, and dispatch the
  // standard input/change events. Different frameworks listen to different
  // signals; we cover all bases.
  async function checkRadioOrBox(opt) {
    if (!opt?.el) return;
    const target = opt.clickTarget || opt.el;
    try { await humanClick(target); } catch (_) {}
    if (!opt.el.checked) {
      try { opt.el.click(); } catch (_) {}
    }
    if (!opt.el.checked) {
      opt.el.checked = true;
    }
    opt.el.dispatchEvent(new Event("input", { bubbles: true }));
    opt.el.dispatchEvent(new Event("change", { bubbles: true }));
  }
})();
