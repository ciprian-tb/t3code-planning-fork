"""Launcher checks with fake CLIs; never starts models or the real app."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("start-mtplx.sh")


class LauncherTest(unittest.TestCase):
    def test_reuses_server_and_passes_served_model_without_global_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "project with spaces"
            project.mkdir()
            commands = {
                "curl": 'echo \'{"data":[{"id":"actual-model"}]}\'',
                "mtplx": '''[[ "$1 $2" == "connect opencode" ]] || exit 99
printf '%s\\n' "$@" > "$TEST_LOG/connect"
echo '{"config":{"provider":{"mtplx":{}}}}'
''',
                "opencode": '''printf '%s\\n' "$@" > "$TEST_LOG/args"
pwd > "$TEST_LOG/cwd"
test -f "$OPENCODE_CONFIG"
printf '%s' "$OPENCODE_CONFIG" > "$TEST_LOG/config"
''',
            }
            for name, body in commands.items():
                path = root / name
                path.write_text("#!/bin/bash\nset -eu\n" + body)
                path.chmod(0o755)
            env = {**os.environ, "PATH": f"{tmp}:/usr/bin:/bin", "TEST_LOG": tmp}
            env.pop("OPENCODE_CONFIG_CONTENT", None)
            result = subprocess.run(
                ["bash", str(SCRIPT), "--opencode", str(project)],
                env=env, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "args").read_text().splitlines(), ["--model", "mtplx/actual-model"])
            self.assertEqual(Path((root / "cwd").read_text().strip()).resolve(), project.resolve())
            self.assertIn("actual-model", (root / "connect").read_text())
            config = Path((root / "config").read_text())
            self.assertFalse(config.exists(), "temporary config should be cleaned up")

            # T3 starts from the script's checkout and uses isolated app state.
            (project / "scripts").mkdir()
            (project / "node_modules").mkdir()
            copied = project / "scripts" / SCRIPT.name
            shutil.copyfile(SCRIPT, copied)
            vp = root / "vp"
            vp.write_text('#!/bin/bash\ntest -s "$OPENCODE_CONFIG" || exit 9\nprintf "%s\\n" "$@" > "$TEST_LOG/vp-args"\n')
            vp.chmod(0o755)
            t3 = subprocess.run(
                ["bash", str(copied)], env=env, capture_output=True, text=True,
            )
            self.assertEqual(t3.returncode, 0, t3.stderr)
            args = (root / "vp-args").read_text().splitlines()
            self.assertEqual(args[:3], ["run", "dev", "--home-dir"])
            self.assertEqual(Path(args[3]).resolve(), (project / ".t3").resolve())

            # Terminating only the launcher must also stop its own app process.
            (root / "opencode").write_text('''#!/usr/bin/env python3
import os, signal, sys
from pathlib import Path
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
Path(os.environ["TEST_LOG"], "app-pid").write_text(str(os.getpid()))
print("READY", flush=True)
signal.pause()
''')
            process = subprocess.Popen(
                ["bash", str(SCRIPT), "--opencode", str(project)],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                for line in process.stdout:
                    if line.strip() == "READY":
                        break
                else:
                    self.fail("app never started")
                process.terminate()
                process.communicate(timeout=5)
                self.assertEqual(process.returncode, 143)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int((root / "app-pid").read_text()), 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()

            # A dead backend must not launch an agent or hide the server error.
            (root / "curl").write_text("#!/bin/bash\nexit 7\n")
            (root / "mtplx").write_text("#!/bin/bash\necho 'backend failed' >&2\nexit 17\n")
            (root / "args").unlink()
            failed = subprocess.run(
                ["bash", str(SCRIPT), "--opencode", str(project)],
                env=env, capture_output=True, text=True, timeout=10,
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("backend failed", failed.stderr)
            self.assertFalse((root / "args").exists())


if __name__ == "__main__":
    unittest.main()
