#!/usr/bin/env python3
"""
prep_datasets.py -- download + normalize the three reasoning benchmarks into ONE
unified JSONL schema the TypeScript harness consumes. Python STDLIB ONLY (urllib,
gzip, csv, json, hashlib) -- no pip install, no pandas/pyarrow.

Datasets (all ungated):
  - math    : HuggingFaceH4/MATH-500 (test.jsonl)            -> competition math, boxed answers
  - gpqa    : openaipublic .../gpqa_diamond.csv (OpenAI mirror) -> graduate science MCQ (4-way)
  - coding  : openai/human-eval HumanEval.jsonl.gz           -> programming + unit tests (pass@1)

Unified record (one JSON object per line):
  { id, benchmark, question, retrieval_text, solution_text, gold, meta }

  question        : exact text shown to the model (coding: the function stub).
  retrieval_text  : text embedded for similarity (the problem statement).
  solution_text   : the exemplar (problem + worked solution) injected as a few-shot example.
  gold            : math -> answer string ; gpqa -> correct letter ; coding -> "" (tests in meta).
  meta            : benchmark-specific extras (coding: entry_point/test/prompt; math: level/subject).

Determinism: GPQA option order is a stable hash-sort (md5 of record id + option), so the
correct letter is reproducible run-to-run and machine-to-machine.

Usage:  python prep_datasets.py <out_dir>
"""

import csv
import gzip
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

MATH_URL = "https://huggingface.co/datasets/HuggingFaceH4/MATH-500/resolve/main/test.jsonl"
GPQA_URL = "https://openaipublic.blob.core.windows.net/simple-evals/gpqa_diamond.csv"
HUMANEVAL_URL = "https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz"
AIME24_URL = "https://raw.githubusercontent.com/QwenLM/Qwen2.5-Math/main/evaluation/data/aime24/test.jsonl"
AIME25_URL = "https://huggingface.co/datasets/math-ai/aime25/resolve/main/test.jsonl"
# Separate, leakage-free STUDY corpora (memory banks) — distinct from the test sets above.
MATH_TRAIN_URL = "https://raw.githubusercontent.com/QwenLM/Qwen2.5-Math/main/evaluation/data/math/train.jsonl"
MBPP_URL = "https://raw.githubusercontent.com/google-research/google-research/master/mbpp/mbpp.jsonl"

# csv fields can be large (GPQA explanations are long).
csv.field_size_limit(10_000_000)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "idb-bench/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def prep_math(out: Path):
    """Returns (count, set_of_unique_ids) — the ids let the study corpus exclude overlap."""
    raw = fetch(MATH_URL).decode("utf-8")
    n = 0
    ids = set()
    with (out / "math.jsonl").open("w", encoding="utf-8") as f:
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            problem = r["problem"]
            solution = r.get("solution", "")
            answer = str(r.get("answer", "")).strip()
            uid = r.get("unique_id", str(n))
            ids.add(uid)
            rec = {
                "id": f"math/{uid}",
                "benchmark": "math",
                "question": problem,
                "retrieval_text": problem,
                "solution_text": f"Problem: {problem}\nSolution: {solution}\nFinal answer: {answer}",
                "gold": answer,
                "meta": {"level": r.get("level"), "subject": r.get("subject")},
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return n, ids


def _aime_records(url: str, year: str):
    raw = fetch(url).decode("utf-8")
    for i, line in enumerate(raw.splitlines()):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        problem = r["problem"]
        solution = r.get("solution", "")
        answer = str(r.get("answer", "")).strip()
        sol = (
            f"Problem: {problem}\nSolution: {solution}\nFinal answer: {answer}"
            if solution
            else f"Problem: {problem}\nFinal answer: {answer}"
        )
        yield {
            "id": f"aime/{year}/{r.get('id', i)}",
            "benchmark": "aime",
            "question": problem,
            "retrieval_text": problem,
            "solution_text": sol,
            "gold": answer,
            "meta": {"year": year},
        }


def prep_aime(out: Path) -> int:
    n = 0
    with (out / "aime.jsonl").open("w", encoding="utf-8") as f:
        for url, year in ((AIME24_URL, "2024"), (AIME25_URL, "2025")):
            for rec in _aime_records(url, year):
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n += 1
    return n


def prep_study_math(out: Path, exclude_ids) -> int:
    """MATH train as the math/AIME memory bank, EXCLUDING any unique_id in the MATH-500 test set."""
    raw = fetch(MATH_TRAIN_URL).decode("utf-8")
    n = 0
    with (out / "study_math.jsonl").open("w", encoding="utf-8") as f:
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            uid = r.get("unique_id", "")
            if uid in exclude_ids:
                continue  # leakage guard: never let a MATH-500 test item into the bank
            problem = r["problem"]
            solution = r.get("solution", "")
            answer = str(r.get("answer", "")).strip()
            rec = {
                "id": f"study_math/{uid or n}",
                "benchmark": "math",
                "question": problem,
                "retrieval_text": problem,
                "solution_text": f"Problem: {problem}\nSolution: {solution}\nFinal answer: {answer}",
                "gold": answer,
                "meta": {"level": r.get("level"), "subject": r.get("subject")},
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return n


def prep_study_coding(out: Path) -> int:
    """MBPP as the coding memory bank (distinct from HumanEval)."""
    raw = fetch(MBPP_URL).decode("utf-8")
    n = 0
    with (out / "study_coding.jsonl").open("w", encoding="utf-8") as f:
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            text = r.get("text", "")
            code = r.get("code", "")
            rec = {
                "id": f"study_coding/mbpp-{r.get('task_id', n)}",
                "benchmark": "coding",
                "question": text,
                "retrieval_text": text,
                "solution_text": f"# {text}\n{code}",
                "gold": "",
                "meta": {"task_id": r.get("task_id")},
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return n


def prep_gpqa(out: Path) -> int:
    text = fetch(GPQA_URL).decode("utf-8")
    rows = list(csv.DictReader(text.splitlines()))
    n = 0
    with (out / "gpqa.jsonl").open("w", encoding="utf-8") as f:
        for i, r in enumerate(rows):
            q = (r.get("Question") or "").strip()
            correct = (r.get("Correct Answer") or "").strip()
            incorrect = [
                (r.get("Incorrect Answer 1") or "").strip(),
                (r.get("Incorrect Answer 2") or "").strip(),
                (r.get("Incorrect Answer 3") or "").strip(),
            ]
            if not q or not correct or any(x == "" for x in incorrect):
                continue
            rid = (r.get("Record ID") or f"row{i}").strip()
            options = [correct] + incorrect
            # stable shuffle: sort by md5(record-id + option)
            options.sort(key=lambda o: hashlib.md5((rid + "::" + o).encode("utf-8")).hexdigest())
            letters = ["A", "B", "C", "D"]
            correct_letter = letters[options.index(correct)]
            opt_block = "\n".join(f"{letters[k]}) {options[k]}" for k in range(4))
            question = f"{q}\n\n{opt_block}"
            rec = {
                "id": f"gpqa/{rid}",
                "benchmark": "gpqa",
                "question": question,
                "retrieval_text": q,
                "solution_text": f"Question: {q}\nThe correct answer is: {correct}",
                "gold": correct_letter,
                "meta": {
                    "subdomain": r.get("Subdomain"),
                    "domain": r.get("High-level domain"),
                    "correct_text": correct,
                },
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return n


def prep_coding(out: Path) -> int:
    raw = gzip.decompress(fetch(HUMANEVAL_URL)).decode("utf-8")
    n = 0
    with (out / "coding.jsonl").open("w", encoding="utf-8") as f:
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            prompt = r["prompt"]
            canonical = r.get("canonical_solution", "")
            rec = {
                "id": f"coding/{r['task_id']}",
                "benchmark": "coding",
                "question": prompt,
                "retrieval_text": prompt,
                "solution_text": f"{prompt}{canonical}",
                "gold": "",
                "meta": {
                    "task_id": r["task_id"],
                    "entry_point": r["entry_point"],
                    "test": r["test"],
                    "prompt": prompt,
                },
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return n


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    counts = {}
    math_n, math_ids = prep_math(out)
    counts["math"] = math_n
    counts["gpqa"] = prep_gpqa(out)
    counts["coding"] = prep_coding(out)
    counts["aime"] = prep_aime(out)
    counts["study_math"] = prep_study_math(out, math_ids)
    counts["study_coding"] = prep_study_coding(out)
    print(json.dumps({"out": str(out), "counts": counts}))


if __name__ == "__main__":
    main()
