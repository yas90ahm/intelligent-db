#!/usr/bin/env python3
"""
poisonedrag/prep.py — build a tractable, provenance-labelled knowledge base from the real
PoisonedRAG attack data + a BEIR corpus, for benchmarking our memory substrate.

Inputs (in <cache>):
  - <dataset>.json        the PoisonedRAG attack file (100 target Qs: question, correct /
                          incorrect answer, 5 adv_texts) — already fetched.
  - <dataset>.zip         the BEIR dataset (corpus.jsonl + qrels/test.tsv), streamed.

Outputs (in <cache>):
  - pr_<dataset>_kb.jsonl        the knowledge base, one passage per line:
        { id, text, kind: "gold"|"negative"|"poison", query_id, value, source, anchor_class }
      gold     = a qrels-relevant passage for a target question (asserts the CORRECT answer);
                 each gold passage is its OWN independent source/anchor class.
      poison   = one of the 5 adv_texts for a target question (asserts the INCORRECT answer);
                 ALL 5 for a question share ONE anchor class (a Sybil cluster, one witness).
      negative = a random corpus passage (distractor); independent source.
  - pr_<dataset>_questions.jsonl  { id, question, correct, incorrect }

So the substrate arm can adjudicate gold (corroborated, independent) vs poison (one Sybil
class) per question; rag/mem0 retrieve by similarity and get crowded out by the poison.

Usage: python prep.py <cache_dir> <dataset> [neg_sample]
"""

import json
import random
import sys
import zipfile
from pathlib import Path


def main() -> None:
    cache = Path(sys.argv[1])
    dataset = sys.argv[2] if len(sys.argv) > 2 else "nq"
    neg_sample = int(sys.argv[3]) if len(sys.argv) > 3 else 50000

    attack = json.load(open(cache / f"{dataset}.json", encoding="utf-8"))
    # target query ids + their answers
    questions = []
    target_qids = set()
    for k, e in attack.items():
        qid = str(e.get("id", k))
        target_qids.add(qid)
        questions.append({
            "id": qid,
            "question": e["question"],
            "correct": str(e.get("correct answer", "")).strip(),
            "incorrect": str(e.get("incorrect answer", "")).strip(),
        })

    zf = zipfile.ZipFile(cache / f"{dataset}.zip")
    names = zf.namelist()
    corpus_name = next(n for n in names if n.endswith("corpus.jsonl"))

    # qrels: union ALL splits (train/test/dev) and keep gold for the target queries — the
    # PoisonedRAG target ids can live in any split (e.g. MS-MARCO uses the train qrels).
    qrels_files = [n for n in names if n.endswith(".tsv") and "/qrels/" in n]
    if not qrels_files:
        raise SystemExit(f"no qrels in {dataset}.zip: {[n for n in names if 'qrels' in n]}")
    gold_doc_ids = set()
    gold_by_doc = {}  # corpus-id -> query-id (first owner)
    for qn in qrels_files:
        with zf.open(qn) as f:
            for i, raw in enumerate(f):
                line = raw.decode("utf-8").strip()
                if i == 0 or not line:
                    continue  # header
                parts = line.split("\t")
                if len(parts) < 3:
                    continue
                qid, cid, score = parts[0], parts[1], parts[2]
                if qid in target_qids and score not in ("0", "0.0"):
                    gold_doc_ids.add(cid)
                    gold_by_doc.setdefault(cid, qid)

    # stream the corpus: capture gold passages exactly; reservoir-sample negatives.
    rng = random.Random(13)
    gold_text = {}
    negatives = []  # reservoir of (id, text)
    seen = 0
    with zf.open(corpus_name) as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            d = json.loads(line)
            cid = str(d.get("_id"))
            text = (d.get("title", "") + ". " + d.get("text", "")).strip(". ").strip()
            if cid in gold_doc_ids:
                gold_text[cid] = text
                continue
            # reservoir sampling for negatives
            seen += 1
            if len(negatives) < neg_sample:
                negatives.append((cid, text))
            else:
                j = rng.randint(0, seen - 1)
                if j < neg_sample:
                    negatives[j] = (cid, text)

    # write KB
    out_kb = (cache / f"pr_{dataset}_kb.jsonl").open("w", encoding="utf-8")
    n_gold = n_pois = n_neg = 0
    # gold
    for cid, qid in gold_by_doc.items():
        if cid not in gold_text:
            continue
        out_kb.write(json.dumps({
            "id": f"gold:{cid}", "text": gold_text[cid], "kind": "gold", "query_id": qid,
            "value": "correct", "source": f"src:gold:{cid}", "anchor_class": f"cls:gold:{cid}",
        }, ensure_ascii=False) + "\n")
        n_gold += 1
    # poison (5 per target Q, ONE shared anchor class per Q)
    for e in attack.values():
        qid = str(e.get("id"))
        for k, adv in enumerate(e.get("adv_texts", [])):
            out_kb.write(json.dumps({
                "id": f"poison:{qid}:{k}", "text": adv, "kind": "poison", "query_id": qid,
                "value": "incorrect", "source": f"src:sybil:{qid}:{k}", "anchor_class": f"cls:sybil:{qid}",
            }, ensure_ascii=False) + "\n")
            n_pois += 1
    # negatives
    for cid, text in negatives:
        out_kb.write(json.dumps({
            "id": f"neg:{cid}", "text": text, "kind": "negative", "query_id": "",
            "value": "", "source": f"src:neg:{cid}", "anchor_class": f"cls:neg:{cid}",
        }, ensure_ascii=False) + "\n")
        n_neg += 1
    out_kb.close()

    with (cache / f"pr_{dataset}_questions.jsonl").open("w", encoding="utf-8") as f:
        for q in questions:
            # keep only questions that actually have a gold passage (so ID has something to corroborate)
            has_gold = any(gold_by_doc.get(cid) == q["id"] and cid in gold_text for cid in gold_doc_ids)
            q2 = dict(q)
            q2["has_gold"] = has_gold
            f.write(json.dumps(q2, ensure_ascii=False) + "\n")

    print(json.dumps({
        "dataset": dataset, "questions": len(questions),
        "gold_passages": n_gold, "poison_passages": n_pois, "negatives": n_neg,
        "questions_with_gold": sum(1 for q in questions if any(gold_by_doc.get(cid) == q["id"] and cid in gold_text for cid in gold_doc_ids)),
    }))


if __name__ == "__main__":
    main()
