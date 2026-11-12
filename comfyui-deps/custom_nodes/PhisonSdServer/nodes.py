import io
import threading

import numpy as np
import torch
from PIL import Image

from .client import generate_file

# How often a running request checks whether the user pressed Stop.
_INTERRUPT_POLL_SECONDS = 0.2


def _png_to_image(png: bytes) -> torch.Tensor:
    pil = Image.open(io.BytesIO(png)).convert("RGB")
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


class PhisonSdServerImageGeneration:
    """Text-to-image through the Phison sd-server (`POST /generate/file`)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base_url": (
                    "STRING",
                    {"default": "http://127.0.0.1:46000", "multiline": False},
                ),
                "text": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFFFFFFFFFF}),
                "steps": ("INT", {"default": 9, "min": 1, "max": 100}),
                "width": (
                    "INT",
                    {"default": 1024, "min": 16, "max": 2048, "step": 16},
                ),
                "height": (
                    "INT",
                    {"default": 1024, "min": 16, "max": 2048, "step": 16},
                ),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "generate"
    CATEGORY = "AIPG/remote"

    def generate(self, base_url, text, seed, steps, width, height):
        import comfy.model_management

        result = {}

        def request():
            try:
                result["png"] = generate_file(
                    base_url, text, width, height, steps, seed
                )
            except Exception as e:
                result["error"] = e

        # The route cannot be cancelled, so the request runs on its own thread and a
        # Stop ends this node at once; the server still finishes the picture it is on.
        worker = threading.Thread(target=request, daemon=True)
        worker.start()
        while worker.is_alive():
            comfy.model_management.throw_exception_if_processing_interrupted()
            worker.join(_INTERRUPT_POLL_SECONDS)
        if "error" in result:
            raise result["error"]
        return (_png_to_image(result["png"]),)


NODE_CLASS_MAPPINGS = {
    "PhisonSdServerImageGeneration": PhisonSdServerImageGeneration,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PhisonSdServerImageGeneration": "Phison sd-server Image (aiDAPTIV)",
}
