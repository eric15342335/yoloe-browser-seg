from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Annotated

import cv2
import numpy as np
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
from ultralytics import YOLOE
from ultralytics.data.augment import LoadVisualPrompt
from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models"
MODEL_DIR.mkdir(exist_ok=True)

MODEL_SPECS = {
    "yoloe-26n": {
        "checkpoint": "yoloe-26n-seg.pt",
        "yaml": "yoloe-26n.yaml",
        "task": "detect",
    },
    "yoloe-26s": {
        "checkpoint": "yoloe-26s-seg.pt",
        "yaml": "yoloe-26s.yaml",
        "task": "detect",
    },
    "yoloe-26m": {
        "checkpoint": "yoloe-26m-seg.pt",
        "yaml": "yoloe-26m.yaml",
        "task": "detect",
    },
    "yoloe-26l": {
        "checkpoint": "yoloe-26l-seg.pt",
        "yaml": "yoloe-26l.yaml",
        "task": "detect",
    },
    "yoloe-26x": {
        "checkpoint": "yoloe-26x-seg.pt",
        "yaml": "yoloe-26x.yaml",
        "task": "detect",
    },
    "yoloe-26n-seg.pt": {"checkpoint": "yoloe-26n-seg.pt", "task": "segment"},
    "yoloe-26s-seg.pt": {"checkpoint": "yoloe-26s-seg.pt", "task": "segment"},
    "yoloe-26m-seg.pt": {"checkpoint": "yoloe-26m-seg.pt", "task": "segment"},
    "yoloe-26l-seg.pt": {"checkpoint": "yoloe-26l-seg.pt", "task": "segment"},
    "yoloe-26x-seg.pt": {"checkpoint": "yoloe-26x-seg.pt", "task": "segment"},
}
DEFAULT_MODEL = "yoloe-26n"
ALLOWED_IMGSZ = {256, 320, 416, 512, 640}
DEFAULT_IMGSZ = int(os.getenv("YOLOE_IMGSZ", "320"))
APP_VERSION = "12"

export_lock = asyncio.Lock()
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
ERROR_LOG = DATA_DIR / "browser-errors.jsonl"

app = FastAPI(title="YOLOE prompt exporter")


@app.middleware("http")
async def response_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    if request.method == "GET" and (
        request.url.path == "/"
        or request.url.path.startswith("/assets/")
        or request.url.path in {"/sw.js", "/comlink.mjs", "/manifest.webmanifest"}
    ):
        response.headers["Cache-Control"] = "no-store, max-age=0"
    if request.url.path == "/sw.js":
        response.headers["Service-Worker-Allowed"] = "/"
    return response


def _append_error_event(event: dict) -> None:
    event["_received_at"] = (
        __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    )
    if ERROR_LOG.exists() and ERROR_LOG.stat().st_size > 5_000_000:
        lines = ERROR_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
        ERROR_LOG.write_text("\n".join(lines[-500:]) + "\n", encoding="utf-8")
    with ERROR_LOG.open("a", encoding="utf-8") as file:
        file.write(json.dumps(event, ensure_ascii=False) + "\n")


@app.post("/telemetry/api/1/envelope/")
async def sentry_envelope(body: bytes = Body(..., media_type="application/x-sentry-envelope")):
    if len(body) > 2_000_000:
        raise HTTPException(413, "event too large")

    lines = body.decode("utf-8", errors="replace").splitlines()
    saved = 0
    for index, line in enumerate(lines):
        if not line.startswith("{"):
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if index > 0 and any(
            key in candidate for key in ("exception", "message", "logentry", "level", "event_id")
        ):
            _append_error_event(candidate)
            saved += 1

    return Response(status_code=200, headers={"X-Telemetry-Saved": str(saved)})


@app.get("/api/telemetry/health")
def telemetry_health():
    count = 0
    if ERROR_LOG.exists():
        with ERROR_LOG.open("r", encoding="utf-8", errors="replace") as file:
            count = sum(1 for _ in file)
    return {"ok": True, "backend": "sentry-compatible", "stored_events": count}


def ensure_checkpoint(checkpoint_name: str) -> Path:
    checkpoint = MODEL_DIR / checkpoint_name
    if checkpoint.exists():
        return checkpoint

    cwd = Path.cwd()
    os.chdir(MODEL_DIR)
    try:
        model = YOLOE(checkpoint_name)
        path = Path(getattr(model, "ckpt_path", checkpoint_name))
        if path.exists() and path.resolve() != checkpoint.resolve():
            shutil.copy2(path, checkpoint)
    finally:
        os.chdir(cwd)

    if not checkpoint.exists():
        raise RuntimeError(f"checkpoint download did not produce {checkpoint_name}")
    return checkpoint


class MaskPromptSegPredictor(YOLOEVPSegPredictor):
    """YOLOE visual-prompt predictor with correct N×H×W mask letterboxing."""

    def _process_single_image(self, dst_shape, src_shape, category, bboxes=None, masks=None):
        if masks is not None and (bboxes is None or len(bboxes) == 0):
            dh, dw = dst_shape
            sh, sw = src_shape
            gain = min(dh / sh, dw / sw)
            nw, nh = round(sw * gain), round(sh * gain)
            left = round((dw - nw) / 2 - 0.1)
            top = round((dh - nh) / 2 - 0.1)
            processed = []
            for mask in np.asarray(masks):
                resized = cv2.resize(
                    mask.astype(np.uint8),
                    (nw, nh),
                    interpolation=cv2.INTER_NEAREST,
                )
                canvas = np.zeros((dh, dw), dtype=np.uint8)
                canvas[top : top + nh, left : left + nw] = resized
                processed.append(canvas)
            return LoadVisualPrompt().get_visuals(
                category,
                dst_shape,
                masks=np.stack(processed),
            )
        return super()._process_single_image(dst_shape, src_shape, category, bboxes, masks)


def bake_export(
    image_bytes: bytes,
    polygon_raw: str,
    width: int,
    height: int,
    model_name: str,
    imgsz: int,
) -> Path:
    if model_name not in MODEL_SPECS:
        raise ValueError("unsupported model")
    if imgsz not in ALLOWED_IMGSZ:
        raise ValueError("unsupported processing resolution")

    points = json.loads(polygon_raw)
    if not isinstance(points, list) or len(points) < 3:
        raise ValueError("polygon needs at least 3 points")

    temp = Path(tempfile.mkdtemp(prefix="yoloe-export-"))
    image_path = temp / "reference.jpg"
    spec = MODEL_SPECS[model_name]
    source_checkpoint = ensure_checkpoint(spec["checkpoint"])
    local_checkpoint = temp / spec["checkpoint"]
    shutil.copy2(source_checkpoint, local_checkpoint)

    image_path.write_bytes(image_bytes)
    with Image.open(image_path) as image:
        image = image.convert("RGB")
        if image.size != (width, height):
            width, height = image.size
        image.save(image_path, quality=95)

    polygon = []
    for point in points:
        x = float(point["x"])
        y = float(point["y"])
        polygon.append(
            (
                max(0.0, min(width - 1.0, x)),
                max(0.0, min(height - 1.0, y)),
            )
        )

    prompt_mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(prompt_mask).polygon(polygon, fill=1)
    mask_array = np.asarray(prompt_mask, dtype=np.uint8)[None, ...]

    prompt_model = YOLOE(str(local_checkpoint))
    prompt_model.model.model[-1].nc = 1
    prompt_model.model.names = ["object0"]

    predictor_options = {
        "task": "segment",
        "mode": "predict",
        "save": False,
        "verbose": False,
        "batch": 1,
        "device": "cpu",
        "imgsz": imgsz,
    }

    try:
        predictor = MaskPromptSegPredictor(
            overrides=predictor_options,
            _callbacks=prompt_model.callbacks,
        )
        predictor.set_prompts({"masks": mask_array, "cls": np.array([0], dtype=np.int64)})
        predictor.setup_model(model=prompt_model.model, verbose=False)
        vpe = predictor.get_vpe(str(image_path))
    except Exception:
        xs = [point[0] for point in polygon]
        ys = [point[1] for point in polygon]
        bbox = np.array([[min(xs), min(ys), max(xs), max(ys)]], dtype=np.float32)
        predictor = MaskPromptSegPredictor(
            overrides=predictor_options,
            _callbacks=prompt_model.callbacks,
        )
        predictor.set_prompts({"bboxes": bbox, "cls": np.array([0], dtype=np.int64)})
        predictor.setup_model(model=prompt_model.model, verbose=False)
        vpe = predictor.get_vpe(str(image_path))

    if not np.isfinite(vpe.detach().cpu().numpy()).all():
        raise ValueError("visual prompt embedding contains non-finite values")

    if spec["task"] == "detect":
        # Ultralytics documents this transfer path for a detection-only YOLOE model:
        # load the matching YOLOE architecture from prompted segmentation weights,
        # then apply the same prompt embedding before export.
        model = YOLOE(spec["yaml"]).load(str(local_checkpoint))
        model.model.model[-1].nc = 1
        model.model.names = ["object0"]
        model.model.set_classes(model.model.names, vpe)
        model.predictor = None
    else:
        model = prompt_model
        model.model.set_classes(model.model.names, vpe)
        model.predictor = None

    exported = model.export(
        format="onnx",
        imgsz=imgsz,
        dynamic=False,
        simplify=True,
        nms=False,
        device="cpu",
        verbose=False,
    )
    output = Path(str(exported))
    if not output.is_absolute():
        output = (Path.cwd() / output).resolve()
    if output.parent != temp:
        target = temp / "prompted.onnx"
        shutil.copy2(output, target)
        output = target
    return output


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "default_model": DEFAULT_MODEL,
        "default_imgsz": DEFAULT_IMGSZ,
        "models": sorted(MODEL_SPECS),
        "processing_sizes": sorted(ALLOWED_IMGSZ),
        "app_version": APP_VERSION,
    }


@app.get("/api/version")
def version():
    return {"version": APP_VERSION}


@app.post("/api/export")
async def export_model(
    background_tasks: BackgroundTasks,
    image: Annotated[UploadFile, File()],
    polygon: Annotated[str, Form()],
    width: Annotated[int, Form()],
    height: Annotated[int, Form()],
    model_name: Annotated[str, Form()] = DEFAULT_MODEL,
    imgsz: Annotated[int, Form()] = DEFAULT_IMGSZ,
):
    if width <= 0 or height <= 0 or width > 8192 or height > 8192:
        raise HTTPException(400, "invalid image dimensions")
    if model_name not in MODEL_SPECS:
        raise HTTPException(400, "unsupported model")
    if imgsz not in ALLOWED_IMGSZ:
        raise HTTPException(400, "unsupported processing resolution")

    data = await image.read()
    if not data or len(data) > 25_000_000:
        raise HTTPException(400, "invalid image")

    async with export_lock:
        try:
            path = await asyncio.to_thread(
                bake_export,
                data,
                polygon,
                width,
                height,
                model_name,
                imgsz,
            )
        except (ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(500, f"export failed: {exc}") from exc

    background_tasks.add_task(shutil.rmtree, path.parent, ignore_errors=True)
    task = MODEL_SPECS[model_name]["task"]
    filename = (
        f"{model_name}-prompted-detect.onnx"
        if task == "detect"
        else f"{Path(model_name).stem}-prompted-seg.onnx"
    )
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=filename,
        headers={
            "X-Model-Input-Size": str(imgsz),
            "X-Model-Name": model_name,
            "X-Model-Task": task,
            "Cache-Control": "no-store",
        },
        background=background_tasks,
    )


DIST = ROOT / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
