#!/usr/bin/env python3
"""Query OpenVINO devices and supplement with OS-level iGPU/Apple Silicon detection."""
import json
import platform
import re
import subprocess
import sys


# ---------------------------------------------------------------------------
# OS-level GPU enumeration helpers
# ---------------------------------------------------------------------------

def _enumerate_gpus_windows() -> list[dict]:
    """Return all display adapters reported by wmic on Windows."""
    try:
        result = subprocess.run(
            ["wmic", "path", "win32_VideoController", "get", "DeviceID,Name", "/format:csv"],
            capture_output=True, text=True, timeout=10,
        )
        gpus = []
        for line in result.stdout.strip().splitlines()[1:]:
            parts = line.split(",")
            if len(parts) < 3:
                continue
            device_id = parts[1].strip()
            name = ",".join(parts[2:]).strip()
            if name:
                gpus.append({"wmic_id": device_id, "name": name})
        return gpus
    except Exception:
        return []


def _enumerate_gpus_macos() -> list[dict]:
    """Return all display adapters reported by system_profiler on macOS."""
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType", "-json"],
            capture_output=True, text=True, timeout=15,
        )
        data = json.loads(result.stdout)
        displays = data.get("SPDisplaysDataType", [])
        gpus = []
        for i, d in enumerate(displays):
            name = d.get("sppci_model") or d.get("_name") or f"GPU {i}"
            gpus.append({"wmic_id": f"GPU:{i}", "name": name})
        return gpus
    except Exception:
        return []


def _is_apple_silicon() -> bool:
    """Return True when running on Apple Silicon (arm64 macOS)."""
    return platform.system() == "Darwin" and platform.machine() == "arm64"


# ---------------------------------------------------------------------------
# Synthesise missing iGPU entries
# ---------------------------------------------------------------------------

def _synthesise_extra_devices(openvino_devices: list[dict]) -> list[dict]:
    """
    Return additional device entries that OpenVINO missed.

    OpenVINO exposes a ``CPU`` device whose FULL_DEVICE_NAME embeds the
    processor brand string.  On AMD APUs (e.g. Ryzen 8845HS w/ Radeon 780M)
    the iGPU is visible via wmic / system_profiler but OpenVINO only lists it
    as the CPU.  We synthesise a separate iGPU entry for it.

    On Apple Silicon, OpenVINO has no GPU plugin for Metal, so we synthesise
    an Apple Silicon entry from the CPU name when running on arm64 macOS.
    """
    existing_ids = {d["id"] for d in openvino_devices}
    extra: list[dict] = []

    # ---- Apple Silicon -------------------------------------------------
    if _is_apple_silicon():
        if "APPLE_SILICON" not in existing_ids:
            # Grab the chip name from the CPU OV device if available
            apple_name = "Apple Silicon"
            for d in openvino_devices:
                if d["id"] == "CPU":
                    m = re.search(r"Apple\s+(M\d\S*)", d["name"], re.IGNORECASE)
                    if m:
                        apple_name = f"Apple {m.group(1)}"
                    break
            extra.append({"id": "APPLE_SILICON", "name": apple_name})
        return extra  # nothing else to do on macOS

    # ---- Windows / Linux iGPU synthesis --------------------------------
    if platform.system() == "Windows":
        os_gpus = _enumerate_gpus_windows()
    else:
        # Linux: OpenVINO usually exposes iGPUs directly; skip extra work.
        return []

    # Build the set of GPU names already known to OpenVINO (excluding CPU)
    ov_gpu_names_lower = {
        d["name"].lower()
        for d in openvino_devices
        if d["id"] != "CPU"
    }

    igpu_index = 0
    for gpu in os_gpus:
        name_lower = gpu["name"].lower()

        # Skip if OpenVINO already reported this GPU (match by substring in either direction)
        if any(name_lower in ov_name or ov_name in name_lower for ov_name in ov_gpu_names_lower):
            continue

        # Skip pure CPU entries (shouldn't appear in wmic VideoController, but guard anyway)
        if re.search(r'\b(core i[3579]|ryzen|xeon|celeron|pentium|athlon)\b', name_lower) and \
                "graphics" not in name_lower and "radeon" not in name_lower:
            continue

        # Assign a stable GPU.N id, avoiding collisions with existing OV device ids
        synth_id = f"GPU.{igpu_index}"
        while synth_id in existing_ids or synth_id in {e["id"] for e in extra}:
            igpu_index += 1
            synth_id = f"GPU.{igpu_index}"

        extra.append({"id": synth_id, "name": gpu["name"]})
        igpu_index += 1

    return extra


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    try:
        import openvino as ov

        core = ov.Core()
        devices = []
        for device_id in core.available_devices:
            if device_id == "AUTO":
                continue
            try:
                full_name = core.get_property(device_id, "FULL_DEVICE_NAME")
            except Exception:
                full_name = device_id
            devices.append({"id": device_id, "name": full_name.strip()})

        extra = _synthesise_extra_devices(devices)
        devices.extend(extra)

        print(json.dumps({"success": True, "devices": devices}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
