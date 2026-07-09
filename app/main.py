import base64
import io
import os
import secrets
from pathlib import Path
from typing import Any

import fitz
import httpx
from PIL import Image
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, Depends
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
PROMPT_FILE = Path(os.getenv("PROMPT_FILE", DATA_DIR / "prompt.txt"))
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://nm-ollama:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3.6:35b-a3b-q4_K_M")
PDF_DPI = int(os.getenv("PDF_DPI", "150"))
MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "30"))
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "4096"))
MAX_IMAGE_SIDE = int(os.getenv("MAX_IMAGE_SIDE", "1024"))
JPEG_QUALITY = int(os.getenv("JPEG_QUALITY", "85"))
OLLAMA_NUM_PREDICT = int(os.getenv("OLLAMA_NUM_PREDICT", "2048"))
REQUEST_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "900"))
DEFAULT_PROMPT = """Сделай краткую структурированную выжимку из документа в Markdown.

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

Если поле не найдено, напиши: не указано."""

# Auth config (override via env) ------------------------------------------------
AUTH_USERNAME = os.getenv("AUTH_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "123456")
PROMPT_PIN = os.getenv("PROMPT_PIN", "0000")
SESSION_SECRET = os.getenv("SESSION_SECRET", "jpg-txt-dev-insecure-secret-change-me")
SESSION_COOKIE = "jpg_txt_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 days

_session_serializer = URLSafeTimedSerializer(SESSION_SECRET, salt="jpg-txt-auth")

# Public paths that do not require authentication.
PUBLIC_PATHS = {"/login", "/api/login", "/logout", "/health"}
PUBLIC_PREFIXES = ("/static/",)

app = FastAPI(title="JPG/PDF -> TXT", version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def verify_credentials(username: str, password: str) -> bool:
    user_ok = secrets.compare_digest(username, AUTH_USERNAME)
    pass_ok = secrets.compare_digest(password, AUTH_PASSWORD)
    return user_ok and pass_ok


def create_session_cookie() -> str:
    return _session_serializer.dumps({"u": AUTH_USERNAME})


def read_session(request: Request) -> bool:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return False
    try:
        _session_serializer.loads(token, max_age=SESSION_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


def require_auth(request: Request) -> None:
    if request.url.path in PUBLIC_PATHS or any(
        request.url.path.startswith(p) for p in PUBLIC_PREFIXES
    ):
        return
    if read_session(request):
        return
    raise HTTPException(status_code=401, detail="Требуется авторизация.")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    try:
        require_auth(request)
    except HTTPException as exc:
        if exc.status_code == 401 and not request.url.path.startswith("/api/"):
            return RedirectResponse("/login", status_code=303)
        return JSONResponse(status_code=401, content={"detail": exc.detail})
    return await call_next(request)


class PromptPayload(BaseModel):
    prompt: str


class LoginPayload(BaseModel):
    username: str
    password: str


class PromptPinPayload(BaseModel):
    prompt: str
    pin: str


def ensure_prompt_file() -> None:
    PROMPT_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not PROMPT_FILE.exists():
        PROMPT_FILE.write_text(DEFAULT_PROMPT, encoding="utf-8")


def read_prompt() -> str:
    ensure_prompt_file()
    value = PROMPT_FILE.read_text(encoding="utf-8").strip()
    return value or DEFAULT_PROMPT


def write_prompt(prompt: str) -> str:
    normalized = prompt.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Промпт не может быть пустым.")
    PROMPT_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROMPT_FILE.write_text(normalized, encoding="utf-8")
    return normalized


def normalize_image(content: bytes) -> bytes:
    try:
        with Image.open(io.BytesIO(content)) as image:
            image = image.convert("RGB")
            image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            return output.getvalue()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Не удалось обработать изображение.") from exc


def encode_upload_image(content: bytes) -> str:
    return base64.b64encode(normalize_image(content)).decode("ascii")


def encode_pdf_pages(content: bytes) -> list[str]:
    images: list[str] = []
    try:
        doc = fitz.open(stream=content, filetype="pdf")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Не удалось открыть PDF.") from exc

    page_count = min(doc.page_count, MAX_PDF_PAGES)
    matrix = fitz.Matrix(PDF_DPI / 72, PDF_DPI / 72)

    for page_index in range(page_count):
        page = doc.load_page(page_index)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        images.append(base64.b64encode(normalize_image(pix.tobytes("png"))).decode("ascii"))

    doc.close()
    if not images:
        raise HTTPException(status_code=400, detail="В PDF не найдено страниц.")
    return images


async def ask_qwen(images: list[str], prompt: str) -> dict[str, Any]:
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": False,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": images,
            }
        ],
        "options": {
            "temperature": 0,
            "num_ctx": OLLAMA_NUM_CTX,
            "num_predict": OLLAMA_NUM_PREDICT,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama недоступна: {exc}") from exc

    message = data.get("message") or {}
    text = (message.get("content") or data.get("response") or "").strip()
    return {
        "text": text,
        "model": data.get("model", OLLAMA_MODEL),
        "done_reason": data.get("done_reason"),
        "total_duration": data.get("total_duration"),
        "eval_count": data.get("eval_count"),
    }


async def recognize_pages(images: list[str], prompt: str) -> dict[str, Any]:
    page_results = []
    total_duration = 0
    eval_count = 0

    for index, image in enumerate(images, start=1):
        result = await ask_qwen([image], prompt)
        text = result["text"]
        if len(images) > 1:
            text = f"--- Страница {index} ---\n{text}"
        page_results.append(text)
        total_duration += result.get("total_duration") or 0
        eval_count += result.get("eval_count") or 0

    return {
        "text": "\n\n".join(page_results).strip(),
        "model": OLLAMA_MODEL,
        "done_reason": "stop",
        "total_duration": total_duration,
        "eval_count": eval_count,
    }


@app.on_event("startup")
def startup() -> None:
    ensure_prompt_file()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/login")
def login_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "login.html")


@app.post("/api/login")
async def login(payload: LoginPayload) -> JSONResponse:
    if not verify_credentials(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль.")
    response = JSONResponse({"ok": True})
    response.set_cookie(
        key=SESSION_COOKIE,
        value=create_session_cookie(),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=False,
    )
    return response


@app.post("/api/logout")
async def logout() -> JSONResponse:
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE)
    return response


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/prompt")
async def get_prompt() -> dict[str, str]:
    return {"prompt": read_prompt()}


@app.put("/api/prompt")
async def update_prompt(payload: PromptPinPayload) -> dict[str, str]:
    if not secrets.compare_digest(payload.pin, PROMPT_PIN):
        raise HTTPException(status_code=403, detail="Неверный PIN-код.")
    return {"prompt": write_prompt(payload.prompt)}


@app.post("/api/recognize")
async def recognize(file: UploadFile = File(...), prompt: str | None = Form(default=None)) -> JSONResponse:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Файл пустой.")

    filename = file.filename or "upload"
    content_type = (file.content_type or "").lower()
    suffix = Path(filename).suffix.lower()

    if suffix == ".pdf" or content_type == "application/pdf":
        images = encode_pdf_pages(content)
    elif suffix in {".jpg", ".jpeg", ".png", ".webp"} or content_type.startswith("image/"):
        images = [encode_upload_image(content)]
    else:
        raise HTTPException(status_code=400, detail="Поддерживаются PDF, JPEG, PNG и WEBP.")

    active_prompt = (prompt or read_prompt()).strip()
    result = await recognize_pages(images, active_prompt)
    return JSONResponse(
        {
            **result,
            "filename": filename,
            "pages": len(images),
            "prompt": active_prompt,
        }
    )
