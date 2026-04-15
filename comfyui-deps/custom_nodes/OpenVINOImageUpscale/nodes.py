import logging
import os
from pathlib import Path

import numpy as np
import torch
from PIL import Image

try:
    import openvino as ov
except ImportError:  # pragma: no cover - exercised at runtime in ComfyUI
    ov = None

log = logging.getLogger("OpenVINOImageUpscale")

MODEL_ROOT_ENV = "AIPG_OPENVINO_IMAGE_MODELS"
PREFERRED_MODEL_SUFFIXES = (".xml", ".onnx")
_COMPILED_MODEL_CACHE: dict[tuple[str, str], "ov.CompiledModel"] = {}


def _tensor_image_to_pil(image: torch.Tensor) -> Image.Image:
    if image.dim() != 4:
        raise RuntimeError(f"Expected IMAGE tensor shape NHWC, got {tuple(image.shape)}")
    tensor = image[0].detach().cpu().clamp(0.0, 1.0).numpy()
    if tensor.shape[-1] < 3:
        raise RuntimeError(f"Expected IMAGE tensor with at least 3 channels, got {tensor.shape[-1]}")
    rgb = (tensor[..., :3] * 255.0).round().astype(np.uint8)
    return Image.fromarray(rgb, mode="RGB")


def _pil_to_tensor(image: Image.Image) -> torch.Tensor:
    rgb = image.convert("RGB")
    array = np.asarray(rgb, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def _normalize_model_reference(model_ref: str) -> str:
    return model_ref.replace("\\", os.sep).replace("/", os.sep).strip()


def _candidate_model_roots() -> list[Path]:
    roots: list[Path] = []
    env_root = os.environ.get(MODEL_ROOT_ENV)
    if env_root:
        roots.append(Path(env_root).expanduser())

    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        roots.append(parent / "models" / "openvino-image")

    unique_roots: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        resolved = root.resolve()
        if resolved in seen or not resolved.exists():
            continue
        seen.add(resolved)
        unique_roots.append(resolved)
    return unique_roots


def _pick_model_file(directory: Path) -> Path | None:
    files = [path for path in directory.rglob("*") if path.is_file()]
    for suffix in PREFERRED_MODEL_SUFFIXES:
        matches = [path for path in files if path.suffix.lower() == suffix]
        if matches:
            return sorted(matches, key=lambda path: (len(path.parts), str(path)))[0]
    return None


def _resolve_model_file(model_ref: str) -> Path:
    normalized_ref = _normalize_model_reference(model_ref)
    if not normalized_ref:
        raise RuntimeError("OpenVINO upscale model path is empty")

    raw_path = Path(normalized_ref)
    if raw_path.is_absolute():
        if raw_path.is_file():
            return raw_path
        if raw_path.is_dir():
            file_path = _pick_model_file(raw_path)
            if file_path:
                return file_path
        raise RuntimeError(f"OpenVINO upscale model path does not exist: {raw_path}")

    repo_style_path = raw_path
    repo_parts = normalized_ref.replace("\\", "/").split("/")
    if len(repo_parts) >= 2 and "---" not in repo_parts[0]:
        repo_root = Path(f"{repo_parts[0]}---{repo_parts[1]}")
        repo_style_path = repo_root.joinpath(*repo_parts[2:])

    for root in _candidate_model_roots():
        for candidate in [root / raw_path, root / repo_style_path]:
            if candidate.is_file():
                return candidate
            if candidate.is_dir():
                file_path = _pick_model_file(candidate)
                if file_path:
                    return file_path

    searched_roots = ", ".join(str(root) for root in _candidate_model_roots()) or "(none)"
    raise RuntimeError(
        f"Could not resolve OpenVINO upscale model '{model_ref}'. Searched: {searched_roots}"
    )


def _normalize_device_name(device: str) -> str:
    value = str(device).strip().upper()
    return value or "AUTO"


def _load_compiled_model(model_ref: str, device: str):
    if ov is None:
        raise RuntimeError(
            "OpenVINO Python package is not installed in the ComfyUI environment. "
            "Install the preset requirements and try again."
        )

    device_name = _normalize_device_name(device)
    model_path = _resolve_model_file(model_ref)
    cache_key = (str(model_path), device_name)
    compiled_model = _COMPILED_MODEL_CACHE.get(cache_key)
    if compiled_model is None:
        log.info("Compiling OpenVINO upscale model %s on %s", model_path, device_name)
        core = ov.Core()
        model = core.read_model(model=str(model_path))
        compiled_model = core.compile_model(model=model, device_name=device_name)
        _COMPILED_MODEL_CACHE[cache_key] = compiled_model
    return compiled_model


def _input_hw_from_port(port, source_size: tuple[int, int]) -> tuple[int, int]:
    width, height = source_size
    try:
        shape = [int(dim) for dim in port.shape]
    except Exception:  # pragma: no cover - depends on OpenVINO shape API details
        return width, height

    if len(shape) != 4:
        return width, height

    input_height = shape[2] if shape[2] > 0 else height
    input_width = shape[3] if shape[3] > 0 else width
    return input_width, input_height


def _prepare_model_input(image: Image.Image, port) -> tuple[np.ndarray, dict[str, object]]:
    source_rgb = image.convert("RGB")
    input_width, input_height = _input_hw_from_port(port, source_rgb.size)
    channels = 1
    try:
        shape = [int(dim) for dim in port.shape]
        if len(shape) == 4 and shape[1] > 0:
            channels = shape[1]
    except Exception:  # pragma: no cover - depends on OpenVINO shape API details
        pass

    if channels == 1:
        y_channel, cb_channel, cr_channel = source_rgb.convert("YCbCr").split()
        y_input = y_channel.resize((input_width, input_height), Image.BICUBIC)
        input_array = np.asarray(y_input, dtype=np.float32)[None, None, :, :] / 255.0
        metadata = {
            "mode": "ycbcr",
            "cb": cb_channel,
            "cr": cr_channel,
            "source_size": source_rgb.size,
        }
        return input_array, metadata

    resized = source_rgb.resize((input_width, input_height), Image.BICUBIC)
    chw = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1)[None, :, :, :] / 255.0
    metadata = {"mode": "rgb", "source_size": source_rgb.size}
    return chw, metadata


def _extract_output_image(output: np.ndarray, metadata: dict[str, object]) -> Image.Image:
    array = np.asarray(output)
    if array.ndim == 4:
        array = array[0]

    if array.ndim == 3 and array.shape[0] in (1, 3):
        array = np.transpose(array, (1, 2, 0))

    if array.ndim == 2:
        array = array[:, :, None]

    if array.ndim != 3:
        raise RuntimeError(f"Unexpected OpenVINO upscale output shape {tuple(np.asarray(output).shape)}")

    array = np.clip(array, 0.0, 1.0)
    if array.shape[-1] == 1:
        if metadata["mode"] != "ycbcr":
            raise RuntimeError("Single-channel OpenVINO output requires YCbCr preprocessing metadata")
        y_image = Image.fromarray((array[:, :, 0] * 255.0).round().astype(np.uint8), mode="L")
        cb_channel = metadata["cb"].resize(y_image.size, Image.BICUBIC)
        cr_channel = metadata["cr"].resize(y_image.size, Image.BICUBIC)
        return Image.merge("YCbCr", [y_image, cb_channel, cr_channel]).convert("RGB")

    if array.shape[-1] >= 3:
        rgb = (array[:, :, :3] * 255.0).round().astype(np.uint8)
        return Image.fromarray(rgb, mode="RGB")

    raise RuntimeError(f"Unsupported OpenVINO upscale output channels: {array.shape[-1]}")


class OpenVINOImageUpscale:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "model_path": (
                    "STRING",
                    {
                        "default": "onnxmodelzoo---super-resolution-10/super-resolution-10.onnx",
                        "multiline": False,
                    },
                ),
                "target_scale": (
                    "FLOAT",
                    {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.1},
                ),
                "device": (
                    "STRING",
                    {"default": "AUTO", "multiline": False},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "upscale"
    CATEGORY = "AIPG/openvino"

    def upscale(self, image, model_path, target_scale, device):
        source = _tensor_image_to_pil(image)
        if float(target_scale) <= 1.0:
            return (_pil_to_tensor(source),)

        compiled_model = _load_compiled_model(model_path, device)
        model_input, metadata = _prepare_model_input(source, compiled_model.input(0))
        result = compiled_model([model_input])
        output = result[compiled_model.output(0)]
        upscaled = _extract_output_image(output, metadata)

        target_width = max(1, int(round(source.width * float(target_scale))))
        target_height = max(1, int(round(source.height * float(target_scale))))
        if upscaled.size != (target_width, target_height):
            upscaled = upscaled.resize((target_width, target_height), Image.BICUBIC)

        return (_pil_to_tensor(upscaled),)


NODE_CLASS_MAPPINGS = {
    "OpenVINOImageUpscale": OpenVINOImageUpscale,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OpenVINOImageUpscale": "OpenVINO Image Upscale",
}
