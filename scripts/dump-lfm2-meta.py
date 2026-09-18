import pathlib
import struct

p = pathlib.Path(
    r"C:\AI-Playground-schuettm\models\LLM\ggufLLM\LiquidAI---LFM2.5-350M-GGUF\LFM2.5-350M-Q4_K_M.gguf"
)


def ru32(f):
    return struct.unpack("<I", f.read(4))[0]


def ru64(f):
    return struct.unpack("<Q", f.read(8))[0]


def rstr(f):
    n = ru64(f)
    return f.read(n).decode("utf-8", "replace")


def rval(f, t):
    if t == 0:
        return struct.unpack("<B", f.read(1))[0]
    if t == 1:
        return struct.unpack("<b", f.read(1))[0]
    if t == 2:
        return struct.unpack("<H", f.read(2))[0]
    if t == 3:
        return struct.unpack("<h", f.read(2))[0]
    if t == 4:
        return ru32(f)
    if t == 5:
        return struct.unpack("<i", f.read(4))[0]
    if t == 6:
        return struct.unpack("<f", f.read(4))[0]
    if t == 7:
        return bool(f.read(1)[0])
    if t == 8:
        return rstr(f)
    if t == 10:
        return ru64(f)
    if t == 11:
        return struct.unpack("<q", f.read(8))[0]
    if t == 12:
        return struct.unpack("<d", f.read(8))[0]
    if t == 9:
        et = ru32(f)
        n = ru64(f)
        if et == 8:
            for _ in range(n):
                ln = ru64(f)
                f.read(ln)
            return f"<str n={n}>"
        if et == 5:
            return [struct.unpack("<i", f.read(4))[0] for _ in range(n)]
        if et == 4:
            return [ru32(f) for _ in range(n)]
        if et == 7:
            return [bool(f.read(1)[0]) for _ in range(n)]
        sizes = {0: 1, 1: 1, 2: 2, 3: 2, 6: 4, 10: 8, 11: 8, 12: 8}
        f.read(n * sizes.get(et, 0))
        return f"<t={et} n={n}>"
    raise ValueError(t)


with p.open("rb") as f:
    f.read(4)
    ru32(f)
    ru64(f)
    nkv = ru64(f)
    for _ in range(nkv):
        k = rstr(f)
        t = ru32(f)
        v = rval(f, t)
        if k.startswith("lfm2.") or k == "general.architecture":
            print(f"{k} = {v}")
