const DEFAULT_ENTITY_PROMPT = `Сделай краткую структурированную выжимку из документа в Markdown.

Извлеки только факты, которые видны в документе. Не додумывай.

Обязательно выдели:
- наименование документа и номер/дату, если есть;
- организации, ИНН/КПП, адреса и роли сторон;
- суммы, НДС, итоги, валюту;
- ключевые текстовые поля: заказчик, исполнитель, автомобиль/объект, основание, назначение, сроки;
- табличные данные: наименование позиции, количество, цена, сумма;
- печати, подписи, ФИО и должности подписантов;
- важные примечания, условия оплаты, гарантию, причины обращения.

Формат ответа:
# Выжимка
## Документ
## Стороны
## Суммы
## Таблица
## Подписи и печати
## Важные детали

Если поле не найдено, напиши: не указано.`;

const state = {
  file: null,
  prompt: DEFAULT_ENTITY_PROMPT,
  text: "",
  lastResult: null,
  previewUrl: "",
  progressTimer: null,
};

const dropzone = document.querySelector("#dropzone");
const fileInput = document.querySelector("#fileInput");
const pickButton = document.querySelector("#pickButton");
const fileRow = document.querySelector("#fileRow");
const fileName = document.querySelector("#fileName");
const runButton = document.querySelector("#runButton");
const statusEl = document.querySelector("#status");
const copyButton = document.querySelector("#copyButton");
const downloadButton = document.querySelector("#downloadButton");
const downloadJsonButton = document.querySelector("#downloadJsonButton");
const promptButton = document.querySelector("#promptButton");
const promptModal = document.querySelector("#promptModal");
const promptEditor = document.querySelector("#promptEditor");
const promptPin = document.querySelector("#promptPin");
const promptError = document.querySelector("#promptError");
const closePromptButton = document.querySelector("#closePromptButton");
const cancelPromptButton = document.querySelector("#cancelPromptButton");
const savePromptButton = document.querySelector("#savePromptButton");
const logoutButton = document.querySelector("#logoutButton");
const preview = document.querySelector("#preview");
const previewFrame = document.querySelector("#previewFrame");
const previewName = document.querySelector("#previewName");
const clearButton = document.querySelector("#clearButton");
const progressBlock = document.querySelector("#progressBlock");
const progressLabel = document.querySelector("#progressLabel");
const progressValue = document.querySelector("#progressValue");
const progressFill = document.querySelector("#progressFill");
const stepUpload = document.querySelector("#stepUpload");
const stepVision = document.querySelector("#stepVision");
const stepDone = document.querySelector("#stepDone");
const resultEmpty = document.querySelector("#resultEmpty");
const renderedOutput = document.querySelector("#renderedOutput");
const processingOverlay = document.querySelector("#processingOverlay");
const scrambleText = document.querySelector("#scrambleText");

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function setBusy(isBusy) {
  runButton.disabled = isBusy;
  pickButton.disabled = isBusy;
  promptButton.disabled = isBusy;
  clearButton.disabled = isBusy;
}

function setProgress(percent, label) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  progressBlock.hidden = false;
  progressFill.style.width = `${safePercent}%`;
  progressValue.textContent = `${safePercent}%`;
  progressLabel.textContent = label;
  stepUpload.classList.toggle("active", safePercent > 0);
  stepVision.classList.toggle("active", safePercent >= 25);
  stepDone.classList.toggle("active", safePercent === 100);
}

function startProcessingProgress() {
  let current = 28;
  clearInterval(state.progressTimer);
  state.progressTimer = setInterval(() => {
    current = Math.min(92, current + Math.max(1, Math.round((94 - current) / 12)));
    setProgress(current, "Qwen анализирует документ");
    if (current >= 92) {
      clearInterval(state.progressTimer);
    }
  }, 1400);
}

function finishProgress() {
  clearInterval(state.progressTimer);
  setProgress(100, "Готово");
  progressBlock.classList.add("done");
  setTimeout(() => {
    progressBlock.classList.remove("done");
    progressBlock.hidden = true;
  }, 1100);
}

async function loadPrompt() {
  const response = await fetch("/api/prompt");
  if (!response.ok) return;
  const data = await response.json();
  state.prompt = data.prompt || state.prompt;
  promptEditor.value = state.prompt;
}

function revokePreviewUrl() {
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = "";
  }
}

function renderPreview(file) {
  revokePreviewUrl();
  previewFrame.innerHTML = "";
  state.previewUrl = URL.createObjectURL(file);
  previewName.textContent = file.name;

  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    const iframe = document.createElement("iframe");
    iframe.src = `${state.previewUrl}#toolbar=1&navpanes=0&view=FitH&zoom=page-width`;
    iframe.title = "Предпросмотр PDF";
    previewFrame.appendChild(iframe);
  } else {
    const image = document.createElement("img");
    image.src = state.previewUrl;
    image.alt = file.name;
    previewFrame.appendChild(image);
  }

  preview.hidden = false;
  dropzone.hidden = true;
  document.querySelector(".upload-panel").classList.add("has-file");
}

function selectFile(file) {
  if (!file) return;
  state.file = file;
  state.lastResult = null;
  fileName.textContent = file.name;
  fileRow.hidden = false;
  progressBlock.hidden = true;
  showResult("");
  renderPreview(file);
  setStatus("Файл выбран. Можно запускать распознавание.");
}

function clearFile() {
  state.file = null;
  fileInput.value = "";
  fileRow.hidden = true;
  preview.hidden = true;
  previewFrame.innerHTML = "";
  dropzone.hidden = false;
  document.querySelector(".upload-panel").classList.remove("has-file");
  progressBlock.hidden = true;
  revokePreviewUrl();
  setStatus("Готов к загрузке.");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function renderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let inList = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      html.push("</tbody></table>");
      inTable = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      closeTable();
      continue;
    }

    if (line.startsWith("|") && line.endsWith("|")) {
      closeList();
      const cells = line.split("|").slice(1, -1).map((cell) => renderInline(cell.trim()));
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      if (!inTable) {
        html.push("<table><tbody>");
        inTable = true;
      }
      html.push(`<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
      continue;
    }

    closeTable();

    if (line.startsWith("### ")) {
      closeList();
      html.push(`<h3>${renderInline(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      closeList();
      html.push(`<h2>${renderInline(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      closeList();
      html.push(`<h1>${renderInline(line.slice(2))}</h1>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else {
      closeList();
      html.push(`<p>${renderInline(line)}</p>`);
    }
  }

  closeList();
  closeTable();
  return html.join("");
}

function showResult(text) {
  state.text = text || "";
  renderedOutput.innerHTML = renderMarkdown(state.text);
  renderedOutput.hidden = !state.text;
  resultEmpty.hidden = Boolean(state.text);
}

/* Scramble / decode effect --------------------------------------------- */
const SCRAMBLE_POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789АБВГДЕЖЗИКЛМНОП#%&@/=+";
const SCRAMBLE_TEMPLATE = [
  "# Выжимка",
  "",
  "## Документ",
  "Тип: ____________________",
  "Номер: ______________",
  "Дата: ________________",
  "",
  "## Стороны",
  "Заказчик: ____________________",
  "ИНН / КПП: _______________",
  "Исполнитель: ____________________",
  "",
  "## Суммы",
  "Итого: ______________ руб.",
  "НДС: _______________",
  "",
  "## Таблица",
  "| Позиция | Кол-во | Цена | Сумма |",
  "| _______ | ______ | ____ | _____ |",
  "",
  "## Подписи и печати",
  "Подписант: ____________________",
  "Печать: ____________________",
  "",
  "## Важные детали",
  "Примечания: ____________________",
].join("\n");

let scrambleState = { timer: null, reveal: 0 };

function randomChar() {
  return SCRAMBLE_POOL[Math.floor(Math.random() * SCRAMBLE_POOL.length)];
}

function startScramble() {
  resultEmpty.hidden = true;
  renderedOutput.hidden = true;
  processingOverlay.hidden = false;
  scrambleState.reveal = 0;

  const render = () => {
    const total = SCRAMBLE_TEMPLATE.length;
    // advance the decode front; reset to loop forever while waiting
    scrambleState.reveal = Math.min(total, scrambleState.reveal + 3);
    if (scrambleState.reveal >= total) {
      scrambleState.reveal = 0;
    }

    let out = "";
    for (let i = 0; i < total; i++) {
      const ch = SCRAMBLE_TEMPLATE[i];
      if (ch === "\n") {
        out += "\n";
        continue;
      }
      const dist = i - scrambleState.reveal;
      if (dist < 0) {
        // already decoded: sharp
        out += ch;
      } else if (dist < 6) {
        // decode front: blurred + glowing random
        out += `<span class="scramble-char scrambling">${randomChar()}</span>`;
      } else {
        // not yet reached: faint noise
        out += `<span class="scramble-char">${randomChar()}</span>`;
      }
    }
    scrambleText.innerHTML = out + '<span class="scramble-cursor">▋</span>';
  };

  render();
  scrambleState.timer = setInterval(render, 55);
}

function stopScramble() {
  if (scrambleState.timer) {
    clearInterval(scrambleState.timer);
    scrambleState.timer = null;
  }
  processingOverlay.hidden = true;
  scrambleText.innerHTML = "";
}

function recognize() {
  if (!state.file) {
    setStatus("Сначала выберите файл.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("file", state.file);
  formData.append("prompt", state.prompt);

  setBusy(true);
  showResult("");
  setStatus("Загружаем файл и передаем его модели.");
  setProgress(0, "Начинаем загрузку");

  const request = new XMLHttpRequest();
  request.open("POST", "/api/recognize");
  request.timeout = 900000;

  request.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const uploadPercent = (event.loaded / event.total) * 24;
    setProgress(uploadPercent, "Загрузка файла");
  };

  request.upload.onload = () => {
    setProgress(26, "Файл загружен");
    startProcessingProgress();
    startScramble();
    setStatus("Qwen распознает и извлекает сущности. Это может занять несколько минут.");
  };

  request.onload = () => {
    clearInterval(state.progressTimer);
    let data = {};
    try {
      data = JSON.parse(request.responseText);
    } catch {
      data = { detail: "Сервер вернул некорректный ответ." };
    }

    stopScramble();

    if (request.status < 200 || request.status >= 300) {
      if (request.status === 401) {
        window.location.href = "/login";
        return;
      }
      setStatus(data.detail || "Ошибка распознавания.", "error");
      setProgress(0, "Ошибка");
      setBusy(false);
      return;
    }

    showResult(data.text || "");
    state.lastResult = data;
    finishProgress();
    setStatus(`Готово. Обработано страниц: ${data.pages}.`, "success");
    setBusy(false);
  };

  request.onerror = () => {
    clearInterval(state.progressTimer);
    stopScramble();
    setStatus("Сетевая ошибка при распознавании.", "error");
    setBusy(false);
  };

  request.ontimeout = () => {
    clearInterval(state.progressTimer);
    stopScramble();
    setStatus("Модель отвечает слишком долго. Попробуйте файл меньше или другой промпт.", "error");
    setBusy(false);
  };

  request.send(formData);
}

async function savePrompt() {
  const nextPrompt = promptEditor.value.trim();
  const pin = promptPin.value.trim();

  promptError.hidden = true;

  if (!nextPrompt) {
    showPromptError("Промпт не может быть пустым.");
    return;
  }
  if (!pin) {
    showPromptError("Введите PIN-код для сохранения.");
    return;
  }

  savePromptButton.disabled = true;

  try {
    const response = await fetch("/api/prompt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: nextPrompt, pin }),
    });
    const data = await response.json();
    if (!response.ok) {
      showPromptError(data.detail || "Не удалось сохранить промпт.");
      return;
    }
    state.prompt = data.prompt;
    promptModal.hidden = true;
    promptPin.value = "";
    setStatus("Промпт сохранен. Новые запуски будут использовать его.", "success");
  } catch {
    showPromptError("Сетевая ошибка. Попробуйте ещё раз.");
  } finally {
    savePromptButton.disabled = false;
  }
}

function showPromptError(message) {
  promptError.textContent = message;
  promptError.hidden = false;
}

function downloadText() {
  const blob = new Blob([state.text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "recognized.txt";
  link.click();
  URL.revokeObjectURL(url);
}

function sectionizeMarkdown(markdown) {
  const sections = {};
  let current = "Без раздела";
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      current = heading[1].trim();
      sections[current] = [];
      continue;
    }
    if (line.trim()) {
      sections[current] ||= [];
      sections[current].push(line.trim());
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value.join("\n")]));
}

function downloadJson() {
  const payload = {
    filename: state.file?.name || null,
    exported_at: new Date().toISOString(),
    prompt: state.prompt,
    pages: state.lastResult?.pages ?? null,
    model: state.lastResult?.model ?? null,
    done_reason: state.lastResult?.done_reason ?? null,
    total_duration_ns: state.lastResult?.total_duration ?? null,
    eval_count: state.lastResult?.eval_count ?? null,
    text: state.text,
    sections: sectionizeMarkdown(state.text),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "recognized.json";
  link.click();
  URL.revokeObjectURL(url);
}

pickButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
runButton.addEventListener("click", recognize);
clearButton.addEventListener("click", clearFile);

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("is-dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragging");
  selectFile(event.dataTransfer.files[0]);
});

promptButton.addEventListener("click", () => {
  promptEditor.value = state.prompt;
  promptPin.value = "";
  promptError.hidden = true;
  promptModal.hidden = false;
  promptEditor.focus();
});

closePromptButton.addEventListener("click", () => {
  promptModal.hidden = true;
});

cancelPromptButton.addEventListener("click", () => {
  promptModal.hidden = true;
});

savePromptButton.addEventListener("click", savePrompt);

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
  window.location.href = "/login";
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.text);
  setStatus("Текст скопирован.", "success");
});

downloadButton.addEventListener("click", downloadText);
downloadJsonButton.addEventListener("click", downloadJson);

loadPrompt().catch(() => undefined);
