#!/usr/bin/env python3
"""
mem0_sidecar.py — a persistent mem0 memory process driven by the TS harness.

Speaks a tiny JSON-lines protocol over stdin/stdout so the Node runner can use mem0 as
the `mem0` arm without any Python in the main harness. mem0 is configured FULLY LOCAL:
Ollama for the LLM + embedder, an embedded (server-less) Qdrant vector store. This is the
genuine external substrate — it uses its OWN embedder/store/ranking, not ours.

Protocol (one JSON object per line, both directions). Every RESPONSE line is prefixed with
the sentinel `@@MEM0@@ ` so mem0's own logging on stdout can never corrupt the channel
(we also redirect stdout→stderr for the duration, keeping the real stdout for responses):

  <- {"cmd":"build","items":[{"idx":0,"text":"..."}, ...]}   ->  @@MEM0@@ {"ok":true,"added":N}
  <- {"cmd":"search","query":"...","k":3}                    ->  @@MEM0@@ {"ok":true,"hits":[{"idx":0,"score":0.7}]}
  <- {"cmd":"close"}                                         ->  @@MEM0@@ {"ok":true}  (then exit)

On startup it emits  @@MEM0@@ {"ok":true,"event":"ready"}  (or ok:false + error and exits).

Config via env: MEM0_LLM, MEM0_EMBED, MEM0_EMBED_DIMS, MEM0_QDRANT_PATH, OLLAMA_HOST.
"""

import json
import os
import sys

SENTINEL = "@@MEM0@@ "
USER = "bench"

# Force UTF-8 on all stdio (Windows defaults to a legacy codepage, which surrogate-escapes
# non-Latin bytes in e.g. GPQA questions and then crashes on re-encode). errors="replace"
# keeps a genuinely malformed character from ever aborting a build.
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

# Keep the REAL stdout for protocol output; send everything else (mem0/posthog/spaCy
# chatter) to stderr so the JSON channel stays clean.
_OUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj: dict) -> None:
    _OUT.write(SENTINEL + json.dumps(obj) + "\n")
    _OUT.flush()


def build_memory():
    from mem0 import Memory

    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    llm = os.environ.get("MEM0_LLM", "qwen2.5:7b")
    embed = os.environ.get("MEM0_EMBED", "nomic-embed-text")
    dims = int(os.environ.get("MEM0_EMBED_DIMS", "768"))
    qpath = os.environ.get("MEM0_QDRANT_PATH", "")

    vs_config = {"embedding_model_dims": dims, "on_disk": False, "collection_name": "bench"}
    if qpath:
        vs_config["path"] = qpath

    config = {
        "llm": {"provider": "ollama", "config": {"model": llm, "temperature": 0, "ollama_base_url": host}},
        "embedder": {"provider": "ollama", "config": {"model": embed, "ollama_base_url": host, "embedding_dims": dims}},
        "vector_store": {"provider": "qdrant", "config": vs_config},
    }
    return Memory.from_config(config)


def main() -> None:
    try:
        mem = build_memory()
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "event": "ready", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        return
    emit({"ok": True, "event": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            if cmd == "build":
                added = 0
                for it in req.get("items", []):
                    mem.add(it["text"], user_id=USER, metadata={"idx": int(it["idx"])}, infer=False)
                    added += 1
                emit({"ok": True, "added": added})
            elif cmd == "search":
                res = mem.search(req["query"], filters={"user_id": USER}, top_k=int(req.get("k", 3)))
                results = res.get("results", res) if isinstance(res, dict) else res
                hits = []
                for r in results:
                    md = r.get("metadata") or {}
                    if "idx" in md:
                        hits.append({"idx": int(md["idx"]), "score": float(r.get("score", 0.0))})
                emit({"ok": True, "hits": hits})
            elif cmd == "close":
                emit({"ok": True})
                return
            else:
                emit({"ok": False, "error": f"unknown cmd: {cmd}"})
        except Exception as e:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"})


if __name__ == "__main__":
    main()
