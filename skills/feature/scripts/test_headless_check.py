import json
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import headless_check as hc

FIXTURE = (Path(__file__).resolve().parent / "fixtures" / "spec-clear-questions.md").read_text(encoding="utf-8")
SCRIPT = Path(__file__).resolve().parent / "headless_check.py"
RULES = Path(__file__).resolve().parents[2] / "spec-clear" / "references" / "question-rules.md"
BACKEND = textwrap.dedent(RULES.read_text(encoding="utf-8").split("```\n")[1]).replace("<n>", "1").replace("<…>", "Lộ trình").replace("<vì sao>", "BE có ngày xong") if RULES.exists() else ""


def ask_items(**overrides):
    items = {
        "Q1": {"id": "Q1", "decision": "ask", "category": "sample-data", "reason": "dữ liệu mẫu luôn hỏi PO"},
        "Q2": {"id": "Q2", "decision": "ask", "category": "conflict", "reason": "hai mục spec lệch nhau"},
    }
    items.update(overrides)
    return {"items": list(items.values())}


class Run:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp())
        self.dir = self.root / ".harness-run"
        self.dir.mkdir()

    def write(self, rel, content):
        path = self.dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")

    def close(self):
        shutil.rmtree(self.root)


class HeadlessCheckTest(unittest.TestCase):
    def setUp(self):
        self.run = Run()

    def tearDown(self):
        self.run.close()

    def problems(self, segment):
        return hc.check(segment, self.run.root)["problems"]

    def test_ask_ok(self):
        self.run.write("questions.md", FIXTURE)
        self.run.write("triage.json", ask_items())
        result = hc.check("ask", self.run.root)
        self.assertEqual(result["problems"], [])
        self.assertTrue(result["ok"])
        self.assertIsNone(result["blocked"])

    def test_ask_missing_triage(self):
        self.run.write("questions.md", FIXTURE)
        self.assertTrue(any("triage.json" in p for p in self.problems("ask")))

    def test_question_needs_two_options_and_one_proposal(self):
        bad = "## Q1 · Một lựa chọn\n- A. Chỉ một\n- **Đề xuất: A** — x\n\n## Q2 · Hai đề xuất\n- A. a\n- B. b\n- **Đề xuất: A** — x\n- **Đề xuất: B** — y\n"
        self.run.write("questions.md", bad)
        self.run.write("triage.json", ask_items())
        problems = self.problems("ask")
        self.assertTrue(any("Q1" in p and "lựa chọn" in p for p in problems))
        self.assertTrue(any("Q2" in p and "Đề xuất" in p for p in problems))

    def test_duplicate_id(self):
        self.run.write("questions.md", FIXTURE + "\n" + FIXTURE.split("\n\n")[1])
        self.run.write("triage.json", ask_items())
        self.assertTrue(any("Q2" in p and "trùng" in p for p in self.problems("ask")))

    def test_auto_on_ask_only_category_rejected(self):
        self.run.write("questions.md", FIXTURE)
        auto = {"id": "Q2", "decision": "auto", "category": "money", "label": "A", "source": "spec mục 3", "reason": "x"}
        self.run.write("triage.json", ask_items(Q2=auto))
        self.assertTrue(any("Q2" in p and "money" in p for p in self.problems("ask")))

    def test_auto_needs_source_and_valid_label(self):
        self.run.write("questions.md", FIXTURE)
        auto = {"id": "Q2", "decision": "auto", "category": "evidence", "label": "Z", "reason": "x"}
        self.run.write("triage.json", ask_items(Q2=auto))
        problems = self.problems("ask")
        self.assertTrue(any("Q2" in p and "source" in p for p in problems))
        self.assertTrue(any("Q2" in p and "label" in p for p in problems))

    def test_easy_change_auto_without_source_ok(self):
        self.run.write("questions.md", FIXTURE)
        auto = {"id": "Q2", "decision": "auto", "category": "easy-change", "label": "A", "reason": "cách vẽ, dễ đổi"}
        self.run.write("triage.json", ask_items(Q2=auto))
        self.assertEqual(self.problems("ask"), [])

    def test_blocking_question_auto_only_with_evidence(self):
        self.run.write("questions.md", FIXTURE)
        auto = {"id": "Q1", "decision": "auto", "category": "easy-change", "label": "A", "source": "spec", "reason": "x"}
        self.run.write("triage.json", ask_items(Q1=auto))
        self.assertTrue(any("Q1" in p and "[chặn]" in p for p in self.problems("ask")))

    def test_no_questions_line_ok(self):
        self.run.write("questions.md", "Không có câu hỏi\n")
        self.assertEqual(self.problems("ask"), [])

    def test_blocked_is_valid_stop(self):
        self.run.write("blocked.json", {"segment": "ask", "reason": "Figma không đọc được", "missing": ["token Figma"]})
        result = hc.check("ask", self.run.root)
        self.assertTrue(result["ok"])
        self.assertEqual(result["blocked"]["reason"], "Figma không đọc được")

    def test_blocked_needs_reason(self):
        self.run.write("blocked.json", {"segment": "ask", "missing": []})
        self.assertTrue(any("blocked.json" in p and "reason" in p for p in self.problems("ask")))

    def test_clarify_needs_clarified_spec(self):
        answered = FIXTURE.replace("- **Đề xuất: A** — spec ghi", "**PO chọn (2026-11-26): A**\n- **Đề xuất: A** — spec ghi").replace(
            "- **Đề xuất: A** — khớp", "**Agent tự chốt (2026-11-26): A** — nguồn: Figma\n- **Đề xuất: A** — khớp")
        self.run.write("questions.md", answered)
        self.assertTrue(any("clarified/spec-v" in p for p in self.problems("clarify")))
        self.run.write("clarified/spec-v2.md", "# Spec đã làm rõ\n")
        self.assertEqual(self.problems("clarify"), [])

    def test_clarify_with_new_questions_needs_triage_only(self):
        self.run.write("questions.md", FIXTURE)
        self.run.write("triage.json", ask_items())
        self.assertEqual(self.problems("clarify"), [])

    def test_build_result_commit_must_exist(self):
        subprocess.run(["git", "init", "-q", str(self.run.root)], check=True)
        subprocess.run(["git", "-C", str(self.run.root), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
        head = subprocess.run(["git", "-C", str(self.run.root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        result = {"branch": "feature/phase-15", "commit": "0" * 40, "plans": [], "tests": {}, "review": {"verdict": "APPROVE"}}
        self.run.write("result.json", result)
        self.assertTrue(any("commit" in p for p in self.problems("build")))
        self.run.write("result.json", {**result, "commit": head})
        self.assertEqual(self.problems("build"), [])

    def test_progress_status_enum(self):
        self.run.write("questions.md", "Không có câu hỏi\n")
        self.run.write("progress.json", {"plans": [{"id": "p1", "title": "Màn lộ trình", "status": "merged"}]})
        self.assertTrue(any("progress.json" in p and "p1" in p for p in self.problems("ask")))

    def test_spec_clear_backend_example_passes(self):
        self.run.write("questions.md", BACKEND)
        self.run.write("triage.json", {"items": [{"id": "Q1", "decision": "ask", "category": "sample-data", "reason": "chỉ PO chọn dữ liệu mẫu"}]})
        self.assertEqual(self.problems("ask"), [])

    def test_spec_clear_backend_auto_c_rejected(self):
        self.run.write("questions.md", BACKEND)
        auto = {"id": "Q1", "decision": "auto", "category": "sample-data", "label": "C", "source": "scout.md Backend", "reason": "x"}
        self.run.write("triage.json", {"items": [auto]})
        self.assertTrue(any("Q1" in p and "sample-data" in p for p in self.problems("ask")))

    def test_cli_exit_codes(self):
        self.run.write("questions.md", FIXTURE)
        bad = subprocess.run([sys.executable, str(SCRIPT), "ask", str(self.run.root)], capture_output=True, text=True)
        self.assertEqual(bad.returncode, 2)
        self.assertFalse(json.loads(bad.stdout)["ok"])
        self.run.write("triage.json", ask_items())
        good = subprocess.run([sys.executable, str(SCRIPT), "ask", str(self.run.root)], capture_output=True, text=True)
        self.assertEqual(good.returncode, 0)
        usage = subprocess.run([sys.executable, str(SCRIPT), "ship", str(self.run.root)], capture_output=True, text=True)
        self.assertEqual(usage.returncode, 1)


if __name__ == "__main__":
    unittest.main()
