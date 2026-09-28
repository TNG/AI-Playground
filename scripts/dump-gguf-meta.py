import pathlib
import struct

files = [
    r"C:\AI-Playground-schuettm\models\LLM\ggufLLM\unsloth---gemma-3-4b-it-GGUF\gemma-3-4b-it-Q4_K_M.gguf",
    r"C:\AI-Playground-schuettm\models\LLM\ggufLLM\unsloth---gemma-4-E4B-it-GGUF\gemma-4-E4B-it-Q4_K_M.gguf",
    r"C:\AI-Playground-schuettm\models\LLM\ggufLLM\bartowski---Meta-Llama-3.1-8B-Instruct-GGUF\Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    r"C:\AI-Playground-schuettm\models\LLM\ggufLLM\LiquidAI---LFM2.5-350M-GGUF\LFM2.5-350M-Q4_K_M.gguf",
]
want = (
    "architecture",
    "block_count",
    "embedding_length",
    "head_count",
    "head_count_kv",
    "sliding_window",
    "key_length",
    "value_length",
    "context_length",
    "ssm",
    "expert",
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
            return f"<array str n={n}>"
        sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
        f.read(n * sizes.get(et, 0))
        return f"<array t={et} n={n}>"
    raise ValueError(t)


for path in files:
    p = pathlib.Path(path)
    print(f"==== {p.name}  {p.stat().st_size / 1024 / 1024:.1f} MiB")
    with p.open("rb") as f:
        magic = f.read(4)
        ver = ru32(f)
        _tc = ru64(f)
        nkv = ru64(f)
        print(f"  gguf v{ver} kv={nkv}")
        for _ in range(nkv):
            k = rstr(f)
            t = ru32(f)
            v = rval(f, t)
            if any(w in k for w in want) and "tokenizer" not in k:
                print(f"  {k} = {v}")
    print()
