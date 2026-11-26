import json
import re
import subprocess
import sys
from pathlib import Path

RUN_DIR = ".harness-run"
SEGMENTS = ("ask", "clarify", "build")
ASK_ONLY = ("money", "ads", "premium", "reward", "delete-data", "drop-requirement", "sample-data", "library-gap", "conflict")
AUTO_OK = ("evidence", "easy-change")
CATEGORIES = ASK_ONLY + ("unclear",) + AUTO_OK
PLAN_STATUSES = ("pending", "coding", "done", "blocked")
NO_QUESTIONS = "Không có câu hỏi"

HEAD = re.compile(r"^## (Q\d+)\b")
OPTION = re.compile(r"^- ([A-Z])\.\s+")
PROPOSAL = re.compile(r"\*\*Đề xuất")
ANSWER = re.compile(r"\*\*(?:PO (?:trả lời|chọn)|Agent tự chốt) \(")
SPEC_VERSION = re.compile(r"^spec-v(\d+)\.md$")
SHA = re.compile(r"^[0-9a-f]{40}$")


def parse_questions(md):
    blocks = [b for b in re.split(r"^(?=## Q\d+\b)", md, flags=re.M) if HEAD.match(b)]
    questions = []
    for block in blocks:
        lines = block.replace("\r", "").split("\n")
        questions.append({
            "id": HEAD.match(lines[0]).group(1),
            "blocking": "[chặn]" in lines[0],
            "labels": [OPTION.match(l).group(1) for l in lines[1:] if OPTION.match(l)],
            "proposals": sum(1 for l in lines[1:] if PROPOSAL.search(l)),
            "answered": any(ANSWER.search(l) for l in lines[1:]),
        })
    return questions


def read_json(path, problems):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        problems.append(f"{path.name} không phải JSON hợp lệ")
        return None


def filled(value):
    return isinstance(value, str) and value.strip() != ""


def blocked_of(run, problems):
    path = run / "blocked.json"
    if not path.exists():
        return None
    data = read_json(path, problems)
    if not isinstance(data, dict) or not filled(data.get("reason")):
        problems.append("blocked.json thiếu reason")
        return None
    missing = data.get("missing", [])
    if not isinstance(missing, list) or not all(isinstance(m, str) for m in missing):
        problems.append("blocked.json: missing phải là danh sách chuỗi")
        return None
    return data


def question_problems(questions):
    problems, seen = [], set()
    for q in questions:
        if q["id"] in seen:
            problems.append(f"{q['id']} trùng id")
        seen.add(q["id"])
        if len(q["labels"]) < 2:
            problems.append(f"{q['id']}: cần ít nhất 2 lựa chọn")
        if q["proposals"] != 1:
            problems.append(f"{q['id']}: cần đúng một dòng Đề xuất")
    return problems


def item_problems(q, item):
    at = f"triage.json {q['id']}"
    if not isinstance(item, dict):
        return [f"triage.json thiếu {q['id']}"]
    problems = []
    if item.get("decision") not in ("ask", "auto"):
        problems.append(f"{at}: decision phải là ask|auto")
    if item.get("category") not in CATEGORIES:
        problems.append(f"{at}: category phải là {'|'.join(CATEGORIES)}")
    if not filled(item.get("reason")):
        problems.append(f"{at}: thiếu reason")
    if item.get("decision") != "auto":
        return problems
    if item.get("category") not in AUTO_OK:
        problems.append(f"{at}: {item.get('category')} luôn hỏi PO, không được auto")
    if item.get("label") not in q["labels"]:
        problems.append(f"{at}: label phải là một trong {', '.join(q['labels'])}")
    if not filled(item.get("source")):
        problems.append(f"{at}: auto cần source")
    if q["blocking"] and item.get("category") != "evidence":
        problems.append(f"{at}: câu [chặn] chỉ auto khi category là evidence")
    return problems


def triage_problems(run, open_questions):
    if not open_questions:
        return []
    path = run / "triage.json"
    if not path.exists():
        return ["chưa có triage.json"]
    problems = []
    data = read_json(path, problems)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return problems or ["triage.json sai định dạng: cần { \"items\": [...] }"]
    by_id = {i.get("id"): i for i in data["items"] if isinstance(i, dict)}
    for q in open_questions:
        problems += item_problems(q, by_id.get(q["id"]))
    return problems


def questions_check(run):
    path = run / "questions.md"
    if not path.exists():
        return ["chưa có questions.md"], []
    md = path.read_text(encoding="utf-8")
    questions = parse_questions(md)
    if not questions:
        return ([] if NO_QUESTIONS in md else ["questions.md không có câu Q<n> nào và không ghi Không có câu hỏi"]), []
    open_questions = [q for q in questions if not q["answered"]]
    return question_problems(questions) + triage_problems(run, open_questions), open_questions


def clarified_versions(run):
    folder = run / "clarified"
    if not folder.is_dir():
        return []
    return [int(m.group(1)) for m in (SPEC_VERSION.match(p.name) for p in folder.iterdir()) if m and int(m.group(1)) >= 2]


def progress_problems(run):
    path = run / "progress.json"
    if not path.exists():
        return []
    problems = []
    data = read_json(path, problems)
    plans = data.get("plans") if isinstance(data, dict) else None
    if not isinstance(plans, list):
        return problems or ["progress.json: cần { \"plans\": [...] }"]
    for plan in plans:
        if not isinstance(plan, dict) or not filled(plan.get("id")) or plan.get("status") not in PLAN_STATUSES:
            problems.append(f"progress.json {plan.get('id') if isinstance(plan, dict) else '?'}: cần id và status {'|'.join(PLAN_STATUSES)}")
    return problems


def commit_exists(root, sha):
    found = subprocess.run(["git", "-C", str(root), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True)
    return found.returncode == 0


def result_problems(root, run):
    path = run / "result.json"
    if not path.exists():
        return ["chưa có result.json"]
    problems = []
    data = read_json(path, problems)
    if not isinstance(data, dict):
        return problems or ["result.json phải là object"]
    if not filled(data.get("branch")):
        problems.append("result.json thiếu branch")
    if not isinstance(data.get("commit"), str) or not SHA.match(data["commit"]) or not commit_exists(root, data["commit"]):
        problems.append("result.json: commit không có trong repo")
    if not isinstance(data.get("plans"), list):
        problems.append("result.json: plans phải là danh sách")
    if not isinstance(data.get("review"), dict) or not filled(data["review"].get("verdict")):
        problems.append("result.json: thiếu review.verdict")
    return problems


def check(segment, root):
    root = Path(root)
    run = root / RUN_DIR
    problems = []
    blocked = blocked_of(run, problems)
    if blocked is not None:
        return {"ok": True, "problems": [], "blocked": blocked}
    problems += progress_problems(run)
    if segment == "build":
        problems += result_problems(root, run)
    else:
        found, open_questions = questions_check(run)
        problems += found
        if segment == "clarify" and not open_questions and not clarified_versions(run):
            problems.append("chưa có clarified/spec-v<N>.md (N ≥ 2)")
    return {"ok": not problems, "problems": problems, "blocked": None}


def main(argv):
    if len(argv) != 3 or argv[1] not in SEGMENTS:
        print(f"dùng: headless_check.py <{'|'.join(SEGMENTS)}> <repo>", file=sys.stderr)
        return 1
    result = check(argv[1], argv[2])
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
