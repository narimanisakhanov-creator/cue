"""cue local speech-to-text service.

faster-whisper "small" on CPU (int8), bound to loopback only, no credentials, no
LLM access. It exposes the [OI]-compatible subset cue's renderer needs:

    GET  /health                    -> {"status":"ok","model":"small","model_ready":true,...}
    POST /v1/audio/transcriptions   -> multipart: file=<audio>, model=small,
                                       language=ru|en (optional)
                                       response: {"text": "..."}

The model is loaded once at startup, so a healthy /health means the model is
actually resident and usable. Inference is serialized (one decode at a time) and
runs in a worker thread, so the event loop stays responsive. Only the configured
model is served; any other model id gets a clear 400 instead of a download.

Run (venv python, see speech/install-windows.ps1):
    <venv>\\Scripts\\python.exe speech\\server.py                    # serve on 127.0.0.1:8765
    <venv>\\Scripts\\python.exe speech\\server.py --download-model   # fetch + verify model, exit

Environment (all optional):
    CUE_SPEECH_MODEL          model to serve; only "small" is supported   [small]
    CUE_SPEECH_MODELS_DIR     model cache, kept outside the repo          [%LOCALAPPDATA%\\cue-speech\\models]
    CUE_SPEECH_LOG_FILE       log file                                    [<home>\\logs\\server.log]
    CUE_SPEECH_HOST           bind address, loopback only                 [127.0.0.1]
    CUE_SPEECH_PORT           bind port                                   [8765]
    CUE_SPEECH_MAX_UPLOAD_MB  upload limit per request                    [32]
    CUE_SPEECH_OFFLINE=1      never touch the network; cached model only
"""

from __future__ import annotations

import argparse
import io
import logging
import os
import re
import sys
import threading
from dataclasses import dataclass
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
SUPPORTED_MODELS = ("small",)
DEFAULT_PORT = 8765
DEFAULT_MAX_UPLOAD_MB = 32
LOG_MAX_BYTES = 1_000_000
LANGUAGE_RE = re.compile(r"^[a-z]{2,3}$")

log = logging.getLogger("cue.speech")


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    model: str
    models_dir: Path
    log_file: Optional[Path]
    max_upload_bytes: int
    offline: bool


def default_home() -> Path:
    """Per-user data root, outside the repo (same layout the installer uses)."""
    explicit = os.environ.get('CUE_SPEECH_HOME')
    if explicit:
        return Path(explicit)
    base = os.environ.get('LOCALAPPDATA') or str(Path.home() / '.local' / 'share')
    return Path(base) / 'cue-speech'


def normalize_model(name: str) -> str:
    """Map client model ids to a short name: 'small', 'whisper-small',
    'Systran/faster-whisper-small' -> 'small'."""
    value = (name or "").strip().lower()
    if not value:
        return ""
    value = value.rsplit("/", 1)[-1]
    value = re.sub(r"^(faster-whisper-|whisper-)", "", value)
    return re.sub(r"-ct2$", "", value)


def looks_like_audio(data: bytes) -> bool:
    """Containers the decoder accepts: WAV (what cue sends), plus the common
    compressed formats so a manual upload still works."""
    return (
        data[:4] in (b"RIFF", b"OggS", b"fLaC", b"FORM", b"\x1a\x45\xdf\xa3")
        or data[:3] == b"ID3"
        or data[:1] == b"\xff"
    )


def setup_logging(log_file: Optional[Path]) -> None:
    """Log to a rotating file always (pythonw has no console) and to stdout when
    a console exists."""
    root = logging.getLogger()
    if root.handlers:
        return
    root.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    if log_file is not None:
        try:
            log_file.parent.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(
                str(log_file), maxBytes=LOG_MAX_BYTES, backupCount=2, encoding="utf-8"
            )
            handler.setFormatter(formatter)
            root.addHandler(handler)
        except OSError:
            pass  # keep serving even if the log path is not writable
    if sys.stdout is not None:
        stream = logging.StreamHandler(sys.stdout)
        stream.setFormatter(formatter)
        root.addHandler(stream)


class Transcriber:
    """Owns the single faster-whisper model instance and serializes inference."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._model = None
        self._lock = threading.Lock()

    def load(self, force_download: bool = False) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # wrong interpreter is the usual cause
            raise RuntimeError(
                "faster-whisper is not installed for this Python; run "
                "speech\\install-windows.ps1 and start the service with the venv python"
            ) from exc

        self._cfg.models_dir.mkdir(parents=True, exist_ok=True)
        kwargs = dict(
            device="cpu",
            compute_type="int8",
            download_root=str(self._cfg.models_dir),
            num_workers=1,
        )
        if not force_download:
            try:
                self._model = WhisperModel(self._cfg.model, local_files_only=True, **kwargs)
                log.info("loaded model '%s' from cache %s", self._cfg.model, self._cfg.models_dir)
                return
            except Exception as exc:
                if self._cfg.offline:
                    raise RuntimeError(
                        f"model '{self._cfg.model}' is not cached in {self._cfg.models_dir} and "
                        "offline mode is on; run speech\\install-windows.ps1 once with network "
                        "access to download it"
                    ) from exc
                log.info(
                    "model '%s' not in the local cache (%s); downloading to %s",
                    self._cfg.model,
                    type(exc).__name__,
                    self._cfg.models_dir,
                )
        self._model = WhisperModel(self._cfg.model, local_files_only=False, **kwargs)
        log.info("model '%s' ready in %s", self._cfg.model, self._cfg.models_dir)

    def transcribe(self, data: bytes, language: Optional[str]) -> str:
        if self._model is None:
            raise RuntimeError("model is not loaded")
        with self._lock:  # serial inference: one decode at a time
            segments, _info = self._model.transcribe(
                io.BytesIO(data),
                language=language,
                beam_size=5,
                vad_filter=True,  # drop silence/noise instead of hallucinating on it
                condition_on_previous_text=False,
            )
            parts = [segment.text.strip() for segment in segments]
        return " ".join(part for part in parts if part).strip()


def create_app(cfg: Config, transcriber: Transcriber):
    def error(status_code: int, code: str, message: str) -> JSONResponse:
        # [OI]-shaped error body: the client SDK surfaces error.message
        return JSONResponse(
            status_code=status_code,
            content={"error": {"message": message, "type": "invalid_request_error", "code": code}},
        )

    app = FastAPI(title="cue-speech", docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RequestValidationError)
    def on_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # keep the [OI]-shaped error body even for framework-level validation errors
        errors = exc.errors()
        location = [str(part) for part in errors[0].get("loc", ()) if part != "body"] if errors else []
        field = ".".join(location) or "request"
        return error(400, "invalid_request", f"invalid request: '{field}' is required")

    @app.middleware("http")
    async def reject_oversized_uploads(request: Request, call_next):
        # runs before the body is parsed, so a huge upload is never buffered
        raw = request.headers.get("content-length")
        if request.method == 'POST' and (not raw or not raw.isdigit()):
            return error(411, 'length_required', 'audio uploads require Content-Length')
        if request.method == "POST" and raw and raw.isdigit() and int(raw) > cfg.max_upload_bytes:
            return error(
                413,
                "audio_too_large",
                f"audio exceeds the {cfg.max_upload_bytes // (1024 * 1024)} MB upload limit",
            )
        return await call_next(request)

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "model": cfg.model,
            "model_ready": True,
            "device": "cpu",
            "compute_type": "int8",
        }

    @app.post("/v1/audio/transcriptions")
    def transcribe_audio(
        file: UploadFile = File(...),
        model: Optional[str] = Form(None),
        language: Optional[str] = Form(None),
    ):
        # sync endpoint: FastAPI runs it in a worker thread, the transcriber lock
        # keeps actual inference serial
        requested = normalize_model(model) if model else cfg.model
        if requested not in SUPPORTED_MODELS:
            return error(
                400,
                "unsupported_model",
                f"model '{model}' is not served locally; supported: {', '.join(SUPPORTED_MODELS)}",
            )

        lang = None
        if language and language.strip().lower() not in ("", "auto"):
            lang = language.strip().lower()
            if not LANGUAGE_RE.match(lang):
                return error(
                    400,
                    "invalid_language",
                    f"language '{language}' is not a whisper language code (ru, en, ...); "
                    "omit it to detect automatically",
                )

        data = file.file.read(cfg.max_upload_bytes + 1)
        if not data:
            return error(400, "unsupported_audio", "empty audio upload")
        if len(data) > cfg.max_upload_bytes:
            return error(
                413,
                "audio_too_large",
                f"audio exceeds the {cfg.max_upload_bytes // (1024 * 1024)} MB upload limit",
            )
        if not looks_like_audio(data):
            return error(400, "unsupported_audio", "unsupported audio container; send a WAV file")

        try:
            text = transcriber.transcribe(data, lang)
        except Exception as exc:
            log.exception("transcription failed")
            return error(400, "decode_failed", f"could not decode audio: {exc}")
        return {"text": text}

    return app


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="cue-speech",
        description="cue local speech-to-text service (faster-whisper, CPU int8, loopback only)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("CUE_SPEECH_HOST", "127.0.0.1"),
        choices=LOOPBACK_HOSTS,
        help="loopback bind address; non-loopback values are rejected",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("CUE_SPEECH_PORT", DEFAULT_PORT)))
    parser.add_argument("--model", default=os.environ.get("CUE_SPEECH_MODEL", "small"))
    parser.add_argument(
        "--models-dir",
        default=os.environ.get("CUE_SPEECH_MODELS_DIR") or str(default_home() / "models"),
    )
    parser.add_argument(
        "--log-file",
        default=os.environ.get("CUE_SPEECH_LOG_FILE") or str(default_home() / "logs" / "server.log"),
    )
    parser.add_argument(
        "--max-upload-mb",
        type=int,
        default=int(os.environ.get("CUE_SPEECH_MAX_UPLOAD_MB", DEFAULT_MAX_UPLOAD_MB)),
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        default=os.environ.get("CUE_SPEECH_OFFLINE", "").strip().lower() not in ("", "0", "false"),
        help="never contact the network; use the cached model only",
    )
    parser.add_argument(
        "--download-model",
        action="store_true",
        help="download/verify the model into --models-dir, then exit",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    model = normalize_model(args.model)
    if model not in SUPPORTED_MODELS:
        sys.stderr.write(
            f"cue-speech: model '{args.model}' is not supported; supported: {', '.join(SUPPORTED_MODELS)}\n"
        )
        return 2

    cfg = Config(
        host=args.host,
        port=args.port,
        model=model,
        models_dir=Path(args.models_dir).expanduser(),
        log_file=Path(args.log_file).expanduser() if args.log_file else None,
        max_upload_bytes=max(1, args.max_upload_mb) * 1024 * 1024,
        offline=args.offline,
    )
    setup_logging(cfg.log_file)
    log.info(
        "cue-speech: model=%s host=%s port=%s models_dir=%s offline=%s",
        cfg.model,
        cfg.host,
        cfg.port,
        cfg.models_dir,
        cfg.offline,
    )
    if cfg.host not in LOOPBACK_HOSTS:  # belt and braces: argparse already enforces this
        log.error("refusing to bind %s: only loopback addresses are allowed", cfg.host)
        return 2
    if cfg.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"  # set before faster-whisper imports huggingface_hub

    transcriber = Transcriber(cfg)
    try:
        transcriber.load(force_download=args.download_model)
    except Exception as exc:
        log.error("could not load model '%s': %s", cfg.model, exc)
        return 1

    if args.download_model:
        log.info("model '%s' verified in %s", cfg.model, cfg.models_dir)
        return 0

    import uvicorn

    app = create_app(cfg, transcriber)
    log.info("listening on http://%s:%s (health: /health)", cfg.host, cfg.port)
    uvicorn.run(
        app,
        host=cfg.host,
        port=cfg.port,
        log_config=None,  # keep our file handler; uvicorn loggers propagate to root
        access_log=True,
        proxy_headers=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
