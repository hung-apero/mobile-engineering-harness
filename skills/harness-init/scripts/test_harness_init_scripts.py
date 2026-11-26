import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = HERE.parents[2] / "overlay.schema.yaml"


def project(root, files):
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


SINGLE = {
    "settings.gradle.kts": 'include(":app")\ninclude(":monetize")\n',
    "gradle/libs.versions.toml": '[libraries]\nkoin = { module = "io.insert-koin:koin-android" }\nretrofit = { module = "com.squareup.retrofit2:retrofit" }\nroom = { module = "androidx.room:room-runtime" }\n',
    "app/build.gradle.kts": 'plugins { alias(libs.plugins.android.application) }\nandroid {\n    namespace = "com.acme.learn"\n}\ndependencies { implementation("androidx.compose.ui:ui") }\n',
    "monetize/build.gradle.kts": 'plugins { alias(libs.plugins.android.library) }\nandroid { namespace = "com.acme.monetize" }\n',
}


class HarnessInitScriptsTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.root)

    def detect(self):
        out = subprocess.run(["bash", str(HERE / "detect-stack.sh"), str(self.root)], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def render(self, stack):
        stack_file = self.root / "stack.json"
        stack_file.write_text(json.dumps(stack), encoding="utf-8")
        out_file = self.root / "overlay.yaml"
        env = {**os.environ, "PRODUCT_NAME": "AcmeLearn", "THEME_PREFIX": "AcmeLearn", "THEME_CLASS": "AcmeLearnTheme"}
        done = subprocess.run(["bash", str(HERE / "render-overlay.sh"), str(self.root), str(stack_file), str(out_file)], capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        return out_file.read_text(encoding="utf-8")

    def test_detect_survives_files_without_namespace(self):
        project(self.root, SINGLE)
        stack = self.detect()
        self.assertEqual(stack["package_root"], "com.acme.learn")
        self.assertEqual([stack["ui_framework"], stack["di_framework"], stack["network_framework"], stack["database_framework"]], ["compose-android", "koin", "retrofit", "room"])
        self.assertEqual(stack["modules"], ["app", "monetize"])

    def test_render_maps_missing_layers_to_app_and_android_only_targets(self):
        project(self.root, SINGLE)
        text = self.render(self.detect())
        for line in ["  app: app", "  presenter: app", "  domain: app", "  data: app", "  - android"]:
            self.assertIn(line, text.splitlines())
        self.assertNotIn("  - ios", text.splitlines())

    def test_validate_reads_json_without_pyyaml(self):
        overlay = {
            "harness_version": ">=0.1.0", "product": {"name": "AcmeLearn", "package": "com.acme.learn"},
            "modules": {"app": "app", "presenter": "app", "domain": "app", "data": "app"},
            "ui": {"theme_prefix": "AcmeLearn", "theme_class": "AcmeLearnTheme"},
            "stack": {"ui": "compose-android", "mvi": "BaseViewModel", "di": "koin", "network": "retrofit", "database": "room", "image": "coil", "serialization": "kotlinx-serialization"},
            "features_root": "feature", "targets": ["android"],
        }
        path = self.root / "overlay.json"
        path.write_text(json.dumps(overlay), encoding="utf-8")
        ok = subprocess.run(["python3", "-I", str(HERE / "validate-overlay.py"), str(path), str(SCHEMA)], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        overlay["stack"]["di"] = "dagger"
        path.write_text(json.dumps(overlay), encoding="utf-8")
        bad = subprocess.run(["python3", "-I", str(HERE / "validate-overlay.py"), str(path), str(SCHEMA)], capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("stack.di", bad.stdout)


if __name__ == "__main__":
    unittest.main()
