"""Score qwen on fixed tasks, by script where possible. Fixtures in bench/fixtures/ keep the runs comparable.

  python bench/LocalBench.py [--only task]

Tasks: digest (game log; score = share of distinct [error] lines kept), describe (banner; score = share of its title
words named), svg (score = valid SVG with viewBox), draft (changelog from commits; read by hand).
Answers and results.tsv go to data/bench/. Numbers and history: bench/BENCHMARKS.md.
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from studio import qwen  # noqa: E402
from studio.jobs import JobError  # noqa: E402
from studio.paths import DATA, ROOT  # noqa: E402

FIX = os.path.join(ROOT, "bench", "fixtures")
OUT = os.path.join(DATA, "bench")


def read(name):
    with open(os.path.join(FIX, name), encoding="utf-8", errors="replace") as f:
        return f.read()


def norm_error(line):
    return re.sub(r"^\[[^\]]*\] \[[^\]]*\] \[error\] *", "", line).strip()[:60]


def score_digest(answer, log):
    errors = {norm_error(l) for l in log.splitlines() if "[error]" in l and norm_error(l)}
    if not errors:
        return None, "no errors in log"
    kept = sum(1 for e in errors if e[:40] in answer)
    return kept / len(errors), f"{kept}/{len(errors)} errors kept"


def score_describe(answer, words):
    hit = [w for w in words if w.lower() in answer.lower()]
    return len(hit) / len(words), f"{len(hit)}/{len(words)} words: {' '.join(sorted(set(words) - set(hit)))}"


def score_svg(answer):
    try:
        root = ET.fromstring(answer)
    except ET.ParseError as e:
        return 0.0, f"invalid XML: {e}"
    if not root.tag.endswith("svg") or "viewBox" not in root.attrib:
        return 0.5, "parses, but no svg root or viewBox"
    return 1.0, f"valid, {len(answer)} chars"


def main():
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    os.makedirs(OUT, exist_ok=True)
    log = read("log.txt")
    words = sorted({w for w in re.findall(r"[A-Za-z]{3,}", read("banner_text.txt"))})
    tasks = [
        ("digest", "digest", "Summarize this REFramework log.", log, [], lambda a: score_digest(a, log)),
        ("describe", "describe", "Describe this banner image.", "", [os.path.join(FIX, "banner.png")], lambda a: score_describe(a, words)),
        ("svg", "svg", "A 512x512 logo icon named Slow Motion: an hourglass with motion lines, dark background, gold accents.",
         "", [], score_svg),
        ("draft", "draft", "Write a short player-facing changelog (BBCode list) from these commit messages. "
                           "Skip internal or test-only changes.", read("commits.txt"), [], lambda a: (None, "read by hand")),
    ]
    rows = []
    for name, preset, prompt, material, images, scorer in tasks:
        if only and name != only:
            continue
        try:
            j = qwen.run(preset, prompt, material, images, force=True)
            answer = j["text"]
            stats = f"{j['prompt_tokens']} in, {j['tokens']} out, {j['tok_per_s']} tok/s, {j['ended'] - j['started']:.0f}s"
        except JobError as e:
            answer, stats = None, str(e)
        with open(os.path.join(OUT, f"qwen_{name}.txt"), "w", encoding="utf-8") as f:
            f.write(answer or "")
        score, note = scorer(answer) if answer is not None else (0.0, "failed")
        rows.append(("qwen", name, "-" if score is None else f"{score:.2f}", note, stats))
        print("\t".join(rows[-1]), flush=True)
    with open(os.path.join(OUT, "results.tsv"), "w", encoding="utf-8", newline="\n") as f:
        f.write("model\ttask\tscore\tnote\tstats\n")
        f.writelines("\t".join(r) + "\n" for r in rows)


if __name__ == "__main__":
    main()
