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

  // Persisted across page reloads in chrome.storage.local so that the
  // auto-run continues after every "Ответить" / "Проверить" click that
  // triggers a full-page navigation to the next exercise.
  const AUTORUN_KEY = "autorun";

  async function setAutorun(active, settings) {
    try {
      const payload = active
        ? { [AUTORUN_KEY]: { active: true, settings, t: Date.now() } }
        : { [AUTORUN_KEY]: { active: false, t: Date.now() } };
      await chrome.storage.local.set(payload);
    } catch (_) {}
  }

  async function getAutorun() {
    try {
      const data = await chrome.storage.local.get(AUTORUN_KEY);
      return data[AUTORUN_KEY] || { active: false };
    } catch (_) {
      return { active: false };
    }
  }

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
  function startLoop(settings, resumed) {
    if (state.running) return;
    state.settings = settings || {};
    state.running = true;
    state.stats.status = "running";
    const prefix = resumed ? "Продолжаю после перехода…" : "Запуск...";
    log(prefix + " модель=" + state.settings.model, "info");
    mainLoop().catch((e) => {
      log("Цикл упал: " + e.message, "error");
      state.running = false;
      state.stats.status = "stopped";
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "START") {
      if (state.running) {
        sendResponse({ ok: true, alreadyRunning: true });
        return;
      }
      const settings = msg.settings || {};
      // Persist intent so the loop survives the next page navigation.
      setAutorun(true, settings);
      startLoop(settings, false);
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "STOP") {
      state.running = false;
      state.stats.status = "stopped";
      setAutorun(false);
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
    try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
    await sleep(randInt(200, 600));
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const mk = (type) => new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: cx, clientY: cy, button: 0,
    });
    const pk = (type) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: "mouse",
      clientX: cx, clientY: cy, button: 0, isPrimary: true,
    });
    el.dispatchEvent(pk("pointerover"));
    el.dispatchEvent(mk("mouseover"));
    el.dispatchEvent(pk("pointerenter"));
    await sleep(randInt(50, 150));
    try { if (typeof el.focus === "function") el.focus(); } catch (_) {}
    el.dispatchEvent(pk("pointerdown"));
    el.dispatchEvent(mk("mousedown"));
    await sleep(randInt(30, 80));
    el.dispatchEvent(pk("pointerup"));
    el.dispatchEvent(mk("mouseup"));
    el.dispatchEvent(mk("click"));
    try { el.click(); } catch (_) {}
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

  function findButtonByTexts(texts, root) {
    const wanted = texts.map(norm);
    const scope = root || document;
    const candidates = scope.querySelectorAll(
      "button, input[type=button], input[type=submit], a[role=button], .button, [class*=button], [class*=btn]"
    );
    // Prefer exact matches over substring matches; prefer real <button>/inputs
    // over generic <div class="...btn..."> wrappers. For very short keywords
    // (<= 4 chars) we require word-boundary matches so e.g. "ок" doesn't match
    // "блок" or "урок".
    const matches = [];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = norm(visibleText(el) || el.value || el.getAttribute("aria-label") || "");
      if (!label) continue;
      let score = -1;
      for (const w of wanted) {
        if (label === w) { score = 3; break; }
        if (w.length <= 4) {
          // Word-boundary match only.
          const re = new RegExp("(^|\\s)" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s|$|[?!.,:;])");
          if (re.test(label)) { score = Math.max(score, 2); }
        } else {
          if (label.startsWith(w)) { score = Math.max(score, 2); }
          else if (label.includes(w)) { score = Math.max(score, 1); }
        }
      }
      if (score < 0) continue;
      // Bonus for real form-submitting elements.
      const tag = el.tagName.toLowerCase();
      const isReal = tag === "button" || tag === "input";
      matches.push({ el, score: score * 2 + (isReal ? 1 : 0) });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.length ? matches[0].el : null;
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
  const BTN_THEORY_READ = [
    "прочитано", "прочитал", "я прочитал", "я прочитал(а)",
    "понятно", "я понял", "я понял(а)",
  ];
  const BTN_CHECK = ["проверить", "ответить", "отправить ответ", "сохранить", "check", "submit"];
  const BTN_FINISH = ["закончить попытку", "завершить попытку", "завершить", "закончить", "finish"];

  // Buttons that mean "the test is over, return to the list". Their
  // presence is one of the signals for `isResultsPage()`.
  const BTN_RETURN_TO_LIST = [
    "вернуться к списку работ", "вернуться к списку",
    "пройти заново", "к списку работ",
  ];

  // Detect that we are on the final “test results” page («Результаты
  // тестирования: Всё верно … Заработано баллов»). We use two
  // independent signals so transient inline feedback won't trigger this.
  function isResultsPage() {
    const bodyTxt = norm(document.body?.innerText || "");
    const hints = [
      "результаты тестирования",
      "заработано баллов",
      "затраченное время",
      "попыток осталось",
      "ваш результат",
    ];
    const matched = hints.filter((h) => bodyTxt.includes(h)).length;
    const hasReturnBtn = !!findButtonByTexts(BTN_RETURN_TO_LIST);
    return matched >= 2 || (matched >= 1 && hasReturnBtn);
  }

  function detectAction() {
    if (isResultsPage()) return { type: "results" };

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

    // Drag-and-drop task (e.g. "заполни пропуски в таблице"). We
    // detect a pool of draggable chips + a set of drop zones inside the
    // task container. This is appended as a single "drag_match" item.
    const dragItem = extractDragDrop(container);
    if (dragItem) {
      dragItem.id = ++id;
      items.push(dragItem);
      log(`Найден drag-and-drop: ${dragItem.pool.length} плиток → ${dragItem.zones.length} ячеек`, "info");
    }

    return items;
  }

  // Detect a drag-and-drop task in the container. Returns a partial
  // form-item (without id) or null. Looks for two things:
  //   1) a pool of draggable elements (HTML5 `draggable=true` or classes
  //      containing "draggable"/"drag"/"option"/"answer");
  //   2) drop zones (classes containing "drop"/"dropzone"/"droppable" or
  //      empty <td> cells inside an answer table).
  function extractDragDrop(container) {
    // Pool candidates.
    const poolSet = new Set();
    container.querySelectorAll('[draggable="true"]').forEach((e) => poolSet.add(e));
    container.querySelectorAll('[class*="draggable" i]').forEach((e) => poolSet.add(e));
    container.querySelectorAll('[class*="ui-draggable" i]').forEach((e) => poolSet.add(e));

    // Drop zone candidates.
    const zoneSet = new Set();
    container.querySelectorAll('[class*="droppable" i], [class*="dropzone" i], [class*="drop-zone" i]').forEach((e) => zoneSet.add(e));
    container.querySelectorAll('[class*="ui-droppable" i]').forEach((e) => zoneSet.add(e));
    container.querySelectorAll('[class*="answer-cell" i], [data-droppable]').forEach((e) => zoneSet.add(e));

    // Heuristic: empty <td> cells inside an answer table.
    const tables = container.querySelectorAll("table");
    for (const t of tables) {
      for (const c of t.querySelectorAll("td")) {
        const txt = visibleText(c);
        if (txt) continue;
        if (!isVisible(c)) continue;
        if (c.querySelector("input, select, textarea")) continue;
        zoneSet.add(c);
      }
    }

    const pool = [...poolSet].filter(isVisible);
    const zones = [...zoneSet].filter(isVisible);

    // Require sensible sizes: at least 2 chips and 2 zones, and the
    // numbers shouldn't be wildly mismatched (drop zones <= pool size + 4).
    if (pool.length < 2 || zones.length < 1) return null;
    if (zones.length > pool.length + 6) return null;

    return {
      kind: "drag_match",
      label: "Перетаскивание ответов в ячейки",
      pool: pool.map((el, i) => ({ index: i, label: visibleText(el).slice(0, 100), el })),
      zones: zones.map((el, i) => ({ index: i, label: zoneLabel(el).slice(0, 200), el })),
    };
  }

  function zoneLabel(zone) {
    const aria = zone.getAttribute("aria-label") || zone.getAttribute("data-label") || zone.getAttribute("title");
    if (aria) return aria;
    // <td> inside a table: combine row-label + col-header.
    if (zone.tagName === "TD") {
      const tr = zone.closest("tr");
      const table = zone.closest("table");
      let rowLabel = "";
      if (tr) {
        const firstCell = tr.querySelector("th, td");
        if (firstCell && firstCell !== zone) rowLabel = visibleText(firstCell);
      }
      let colLabel = "";
      if (table && tr) {
        const idx = [...tr.children].indexOf(zone);
        // Look for column header(s).
        const headerRows = table.querySelectorAll("thead tr, tr");
        for (const hr of headerRows) {
          if (hr === tr) continue;
          const ths = hr.querySelectorAll("th");
          if (ths.length && ths[idx]) { colLabel = visibleText(ths[idx]); break; }
          // Fallback: same column index in first row if first row has th's.
          const first = hr.children[idx];
          if (first && (first.tagName === "TH" || hr === table.querySelector("tr"))) {
            colLabel = visibleText(first);
            break;
          }
        }
      }
      const combined = [rowLabel, colLabel].filter(Boolean).join(" \u00d7 ");
      return combined || "(ячейка)";
    }
    return visibleText(zone) || "(пусто)";
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
      if (it.kind === "drag_match") {
        const pool = it.pool.map((p) => `  P${p.index}) ${p.label}`).join("\n");
        const zones = it.zones.map((z) => `  Z${z.index}) ${z.label}`).join("\n");
        return `#${it.id} | DRAG-AND-DROP MATCH | label="${it.label}"\nPOOL (варианты ответов):\n${pool}\nZONES (куда тащить):\n${zones}`;
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
      '  - DRAG-AND-DROP MATCH → массив [{"zone": <индекс Z>, "option": <индекс P>}, ...]',
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
        } else if (item.kind === "drag_match") {
          const pairs = Array.isArray(a.value) ? a.value : [];
          for (const p of pairs) {
            const z = item.zones[Number(p?.zone)];
            const o = item.pool[Number(p?.option)];
            if (!z?.el || !o?.el) continue;
            // Re-find the option in the DOM in case it was cloned/replaced.
            const liveOpt = findMatchingPoolItem(item, o);
            const sourceEl = liveOpt || o.el;
            await dragAndDrop(sourceEl, z.el);
            await sleep(randInt(300, 600));
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

        if (action.type === "results") {
          log("Страница результатов теста — работа завершена.", "success");
          state.running = false;
          state.stats.status = "stopped";
          setAutorun(false);
          break;
        }

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
          setAutorun(false);
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

  // Scroll through the task container so any IntersectionObserver-driven
  // lazy-loaded content (images, math formulas, options) gets rendered
  // before we try to parse it. Then scroll back to the top so subsequent
  // clicks land on visible elements.
  async function prepareTaskView(container) {
    try {
      const startY = window.scrollY;
      const rect = container.getBoundingClientRect();
      const containerTop = window.scrollY + rect.top;
      const containerBottom = containerTop + container.scrollHeight;
      // Step from top to bottom in a few stops.
      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const y = containerTop + ((containerBottom - containerTop) * i) / steps;
        window.scrollTo({ top: y, behavior: "instant" in window ? "auto" : "auto" });
        await sleep(120);
      }
      // Park ourselves a bit above the container so the user can see what's
      // happening when watching.
      window.scrollTo({ top: Math.max(containerTop - 60, 0), behavior: "auto" });
      await sleep(150);
      void startY; // not restoring intentionally
    } catch (_) {}
  }

  async function handleTask(checkBtn) {
    const container = findTaskContainer(checkBtn);
    await prepareTaskView(container);
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

    // If the user pressed Stop while we were waiting / talking to Gemini,
    // bail out before clicking submit.
    if (!state.running) {
      log("Остановлено пользователем — не нажимаю «Проверить»", "warn");
      return;
    }

    // Re-locate the check button in case the DOM was reshuffled after we
    // typed into inputs. Restrict to the task container first to avoid
    // accidentally picking up unrelated navigation buttons elsewhere on the
    // page. Fall back to a global search if nothing is found.
    const submitBtn =
      findButtonByTexts(BTN_CHECK, container) ||
      findButtonByTexts(BTN_CHECK) ||
      checkBtn;
    if (!submitBtn || !isVisible(submitBtn)) {
      log("Не нашёл кнопку «Проверить» после заполнения", "warn");
      return;
    }

    log(`Кликаю «${visibleText(submitBtn).slice(0, 40)}» (${submitBtn.tagName.toLowerCase()})`, "info");
    await humanClick(submitBtn);

    // Fallback: if humanClick didn't trigger a form submission (button still
    // visible after 700ms), try submitting the parent form directly.
    await sleep(700);
    if (isVisible(submitBtn) && submitBtn.isConnected) {
      const form = submitBtn.closest("form");
      if (form) {
        try {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit(submitBtn);
            log("Резерв: form.requestSubmit()", "info");
          } else {
            form.submit();
            log("Резерв: form.submit()", "info");
          }
        } catch (e) {
          log("requestSubmit ошибка: " + e.message, "warn");
        }
      } else {
        // No form wrapper — try a second, very direct click via .click().
        try { submitBtn.click(); } catch (_) {}
      }
    }

    log("Нажал «Проверить»", "success");
    state.stats.solved++;
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

  // -----------------------------
  // Drag-and-drop simulation
  // -----------------------------
  // After a "consume on drop" page mutation, the original `el` reference
  // we stored may be detached. Try to re-find a pool item by its label.
  function findMatchingPoolItem(item, opt) {
    if (opt?.el && opt.el.isConnected) return opt.el;
    // Search the document for a node with the same trimmed text.
    const wanted = (opt?.label || "").trim();
    if (!wanted) return null;
    const candidates = document.querySelectorAll('[draggable="true"], [class*="draggable" i], [class*="answer-option" i]');
    for (const c of candidates) {
      if (!isVisible(c)) continue;
      if ((visibleText(c) || "").trim() === wanted) return c;
    }
    return null;
  }

  // Generic drag-and-drop: dispatches both HTML5 native drag events and
  // mouse events. yaklass.ru tasks have historically used both jQuery UI
  // (mouse events) and HTML5 native draggables, so we fire both.
  async function dragAndDrop(source, target) {
    if (!source || !target) return false;
    try { source.scrollIntoView({ block: "center" }); } catch (_) {}
    await sleep(120);
    const sr = source.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const sx = sr.left + sr.width / 2;
    const sy = sr.top + sr.height / 2;
    const tx = tr.left + tr.width / 2;
    const ty = tr.top + tr.height / 2;

    // HTML5 native drag events with a shared DataTransfer.
    let dt = null;
    try { dt = new DataTransfer(); } catch (_) {}
    const mkDrag = (type, x, y) => {
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      if (dt) opts.dataTransfer = dt;
      try {
        return new DragEvent(type, opts);
      } catch (_) {
        return new MouseEvent(type, opts);
      }
    };
    const mkMouse = (type, x, y) => new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0,
    });
    const mkPointer = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: "mouse",
      clientX: x, clientY: y, button: 0, isPrimary: true,
    });

    // 1) Mouse-based simulation (covers jQuery UI / custom impls). Move
    //    through several intermediate positions so listeners that look at
    //    elementFromPoint still see motion.
    source.dispatchEvent(mkPointer("pointerdown", sx, sy));
    source.dispatchEvent(mkMouse("mousedown", sx, sy));
    await sleep(80);

    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = sx + (tx - sx) * (i / steps);
      const y = sy + (ty - sy) * (i / steps);
      const overEl = document.elementFromPoint(x, y) || target;
      overEl.dispatchEvent(mkPointer("pointermove", x, y));
      overEl.dispatchEvent(mkMouse("mousemove", x, y));
      await sleep(20);
    }
    target.dispatchEvent(mkPointer("pointerup", tx, ty));
    target.dispatchEvent(mkMouse("mouseup", tx, ty));
    await sleep(80);

    // 2) HTML5 native drag-drop sequence on top, in case the page listens
    //    for those instead.
    try {
      source.dispatchEvent(mkDrag("dragstart", sx, sy));
      await sleep(40);
      target.dispatchEvent(mkDrag("dragenter", tx, ty));
      await sleep(20);
      target.dispatchEvent(mkDrag("dragover", tx, ty));
      await sleep(20);
      target.dispatchEvent(mkDrag("drop", tx, ty));
      await sleep(20);
      source.dispatchEvent(mkDrag("dragend", tx, ty));
    } catch (_) {}

    return true;
  }
  // -----------------------------
  // Auto-resume after page reload
  // -----------------------------
  // After every "Ответить"/"Проверить" click, yaklass does a full-page
  // navigation to the next exercise. We persisted `autorun.active=true` in
  // chrome.storage.local when the user pressed Start; on every fresh content
  // script load we read that flag and resume the loop with the same settings.
  (async function bootstrap() {
    const ar = await getAutorun();
    if (!ar.active) return;
    // Slight delay so the new page finishes initial rendering before we
    // start poking at it.
    await sleep(800);
    if (state.running) return; // shouldn't happen, but be safe
    if (!ar.settings || !ar.settings.apiKeys || !ar.settings.apiKeys.length) {
      // Migration path: legacy single-key sessions.
      if (ar.settings && ar.settings.apiKey) {
        ar.settings.apiKeys = [ar.settings.apiKey];
      } else {
        log("Авто-возобновление пропущено: нет сохранённых API ключей", "warn");
        setAutorun(false);
        return;
      }
    }
    startLoop(ar.settings, true);
  })();
})();
