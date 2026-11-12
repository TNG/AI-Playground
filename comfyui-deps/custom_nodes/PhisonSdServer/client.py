"""HTTP client for the Phison sd-server image route. Kept free of torch so it tests alone."""

import json
import urllib.error
import urllib.parse
import urllib.request


def _check_scheme(url: str) -> None:
    """`base_url` is free text, so `file:///...` and other local schemes must not reach urlopen."""
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise RuntimeError(
            f"Unsupported URL scheme {scheme or '(none)'!r} in {url}: "
            "base_url must be an http:// or https:// address"
        )


def _error_sentence(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return text[:2000]
    if isinstance(data, dict) and isinstance(data.get("error"), str):
        return data["error"]
    return text[:2000]


def generate_file(
    base_url: str,
    prompt: str,
    width: int,
    height: int,
    steps: int,
    seed: int,
    timeout: float = 600.0,
) -> bytes:
    """One picture from sd-server's `POST /generate/file`; returns the PNG bytes."""
    url = f"{base_url.rstrip('/')}/generate/file"
    _check_scheme(url)
    body = {
        "prompt": prompt,
        "width": int(width),
        "height": int(height),
        "num_inference_steps": int(steps),
        "seed": int(seed),
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # nosec B310 - scheme checked above
            return response.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"sd-server HTTP {e.code} at {url}: {_error_sentence(e.read())}"
        ) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"sd-server request failed for {url}: {e.reason}") from e
