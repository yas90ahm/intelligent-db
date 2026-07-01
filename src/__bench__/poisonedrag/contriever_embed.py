#!/usr/bin/env python
"""
contriever_embed.py — embed a JSONL field with the PoisonedRAG paper's exact retriever
(facebook/contriever-msmarco) on CPU, exporting un-normalized dot-product vectors.

The paper retrieves by DOT PRODUCT over Contriever (MS-MARCO) embeddings with mean
pooling over the attention mask. The TS arms rank by `cosine(a,b)` which is a RAW dot
product (no per-vector normalization), so we deliberately do NOT L2-normalize here:
un-normalized Contriever vectors make the TS ranking identical to the paper's dot-product.

Output binary format (little-endian):
    uint32 n          # number of rows
    uint32 dim        # embedding dimension
    float32[n*dim]    # row-major vectors

Usage:
    contriever_embed.py <in.jsonl> <text_field> <out.f32> [--device {cpu,cuda}]

--device defaults to cpu (the original behavior; existing CPU runs are unaffected).
With --device cuda the model is loaded and embedding runs on the GPU; the binary
output format is byte-identical (vectors are moved back to CPU float32 before write).
"""

import json
import os
import struct
import sys

# Parse the optional --device flag BEFORE importing torch: when CPU is requested
# (the default) we keep the original hard CUDA_VISIBLE_DEVICES="" guard so a busy
# GPU is never contended. Only an explicit --device cuda lifts that guard.
def _parse_args(argv):
    device = "cpu"
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--device":
            if i + 1 >= len(argv):
                sys.stderr.write("error: --device requires a value (cpu|cuda)\n")
                sys.exit(2)
            device = argv[i + 1]
            i += 2
            continue
        if a.startswith("--device="):
            device = a.split("=", 1)[1]
            i += 1
            continue
        positional.append(a)
        i += 1
    if device not in ("cpu", "cuda"):
        sys.stderr.write(f"error: --device must be 'cpu' or 'cuda', got {device!r}\n")
        sys.exit(2)
    return positional, device


_POSITIONAL, _DEVICE = _parse_args(sys.argv[1:])

# Force CPU off the GPU — the GPU is busy; never contend for it — UNLESS the caller
# explicitly asked for cuda.
if _DEVICE == "cpu":
    os.environ["CUDA_VISIBLE_DEVICES"] = ""

import torch  # noqa: E402
from transformers import AutoModel, AutoTokenizer  # noqa: E402

MODEL_ID = "facebook/contriever-msmarco"
BATCH = 32
MAX_LENGTH = 512


def mean_pooling(token_embeddings, mask):
    """Contriever's pooling: mean of last_hidden_state over the attention mask."""
    mask = mask.unsqueeze(-1).to(token_embeddings.dtype)
    summed = (token_embeddings * mask).sum(dim=1)
    counts = mask.sum(dim=1).clamp(min=1e-9)
    return summed / counts


def read_field(path, field):
    texts = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            texts.append(str(obj[field]))
    return texts


def main():
    if len(_POSITIONAL) != 3:
        sys.stderr.write("usage: contriever_embed.py <in.jsonl> <text_field> <out.f32> [--device {cpu,cuda}]\n")
        sys.exit(2)
    in_path, field, out_path = _POSITIONAL[0], _POSITIONAL[1], _POSITIONAL[2]

    if _DEVICE == "cuda":
        if not torch.cuda.is_available():
            sys.stderr.write("error: --device cuda requested but torch.cuda.is_available() is False\n")
            sys.exit(2)
        device = torch.device("cuda")
    else:
        # Cap threads — oversubscription on many-core boxes can destabilize CPU torch.
        torch.set_num_threads(min(os.cpu_count() or 4, 8))
        device = torch.device("cpu")

    texts = read_field(in_path, field)
    n = len(texts)
    dev_label = torch.cuda.get_device_name(0) if _DEVICE == "cuda" else "CPU"
    sys.stderr.write(f"[contriever] loading {MODEL_ID} on {dev_label}; {n} rows from {in_path} field '{field}'\n")
    sys.stderr.flush()

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModel.from_pretrained(MODEL_ID)
    model.eval()
    model.to(device)

    dim = int(model.config.hidden_size)

    # Write header first, then stream rows so peak memory is bounded.
    with open(out_path, "wb") as out:
        out.write(struct.pack("<II", n, dim))
        with torch.no_grad():
            for start in range(0, n, BATCH):
                batch = texts[start:start + BATCH]
                enc = tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=MAX_LENGTH,
                    return_tensors="pt",
                ).to(device)
                outputs = model(**enc)
                emb = mean_pooling(outputs[0], enc["attention_mask"])
                # NO L2 normalization — paper ranks by raw dot product.
                arr = emb.cpu().to(torch.float32).numpy()
                out.write(arr.tobytes())
                done = min(start + BATCH, n)
                if (start // BATCH) % 20 == 0 or done == n:
                    sys.stderr.write(f"[contriever] {done}/{n}\n")
                    sys.stderr.flush()

    sys.stderr.write(f"[contriever] wrote {out_path}: n={n} dim={dim}\n")
    sys.stderr.flush()


if __name__ == "__main__":
    main()
