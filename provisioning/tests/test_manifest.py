"""Portable manifest/role contracts. No target connection or package changes."""
import pathlib
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROLE = ROOT / "roles" / "pa_bb_host_dependencies"


def load(path):
    return yaml.safe_load(path.read_text())


def tasks(items):
    for task in items:
        yield task
        for section in ("block", "rescue", "always"):
            yield from tasks(task.get(section, []))


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load(ROLE / "vars/main.yml")["pa_bb_host_manifest"]
        self.tasks = list(tasks(load(ROLE / "tasks/main.yml")))

    def test_platform_and_exact_application_versions(self):
        self.assertEqual(self.manifest["schema"], 1)
        self.assertEqual(self.manifest["platform"], {
            "system": "Linux", "architecture": "x86_64",
            "distribution": "Ubuntu", "distribution_version": "24.04",
        })
        self.assertEqual(self.manifest["rclone"]["version"], "1.75.2")
        self.assertEqual(self.manifest["ripgrep"]["version"], "14.1.0")
        self.assertEqual(self.manifest["packages"], [
            "ca-certificates", "unzip", "util-linux", "ripgrep=14.1.0-1",
        ])

    def test_archive_and_binary_are_independently_pinned(self):
        binary = self.manifest["rclone"]
        self.assertEqual(binary["archive_url"],
                         "https://downloads.rclone.org/v1.75.2/rclone-v1.75.2-linux-amd64.zip")
        self.assertEqual(binary["archive_binary"], "rclone-v1.75.2-linux-amd64/rclone")
        for key in ("archive_sha256", "binary_sha256"):
            self.assertRegex(binary[key], r"^[0-9a-f]{64}$")
        self.assertNotEqual(binary["archive_sha256"], binary["binary_sha256"])

    def test_role_does_not_manage_services_accounts_or_sync(self):
        allowed = {"ansible.builtin." + name for name in (
            "assert", "stat", "set_fact", "command", "apt", "debug",
            "tempfile", "get_url", "unarchive", "copy", "file", "include_tasks",
        )}
        for task in self.tasks:
            modules = {key for key in task if key.startswith("ansible.")}
            self.assertTrue(modules <= allowed, task["name"])
        removals = [t["ansible.builtin.file"] for t in self.tasks
                    if t.get("ansible.builtin.file", {}).get("state") == "absent"]
        self.assertEqual(removals, [{"path": "{{ pa_bb_rclone_temporary.path }}", "state": "absent"}])

    def test_no_automatic_binary_replacement_or_package_upgrade(self):
        defaults = load(ROLE / "defaults/main.yml")
        self.assertIs(defaults["pa_bb_allow_rclone_replacement"], False)
        apt = next(t["ansible.builtin.apt"] for t in self.tasks if "ansible.builtin.apt" in t)
        self.assertEqual(apt["state"], "present")
        self.assertIs(apt["allow_downgrade"], False)
        self.assertIs(apt["update_cache"], False)
        self.assertEqual(apt["policy_rc_d"], 101)
        apt_task = next(t for t in self.tasks if "ansible.builtin.apt" in t)
        self.assertEqual(apt_task["environment"], {"NEEDRESTART_MODE": "l"})
        copy = next(t["ansible.builtin.copy"] for t in self.tasks if "ansible.builtin.copy" in t)
        self.assertIs(copy["unsafe_writes"], False)
        self.assertEqual((copy["owner"], copy["group"], copy["mode"]), ("root", "root", "0755"))
        self.assertTrue(any("pa_bb_allow_rclone_replacement" in str(t.get("ansible.builtin.assert", {}))
                            for t in self.tasks))
        self.assertTrue(any(t.get("ansible.builtin.assert", {}).get("that") == "pa_bb_rclone_process_check.rc == 0"
                            for t in self.tasks))

    def test_browser_packages_stay_in_root_host_role(self):
        chrome = self.manifest["chrome"]
        self.assertEqual(chrome["package"], "google-chrome-stable")
        self.assertEqual(chrome["executable"], "/usr/bin/google-chrome-stable")
        self.assertRegex(chrome["key_sha256"], r"^[0-9a-f]{64}$")
        browser = list(tasks(load(ROLE / "tasks/browser.yml")))
        apt = next(t for t in browser if "ansible.builtin.apt" in t)
        self.assertEqual(apt["ansible.builtin.apt"]["state"], "present")
        self.assertIs(apt["ansible.builtin.apt"]["allow_downgrade"], False)
        self.assertEqual(apt["ansible.builtin.apt"]["policy_rc_d"], 101)
        self.assertEqual(apt["environment"], {"NEEDRESTART_MODE": "l"})
        repo = next(t["ansible.builtin.copy"] for t in browser if "ansible.builtin.copy" in t)
        self.assertIn("signed-by=/etc/apt/keyrings/pa-bb-google.asc", repo["content"])
        self.assertNotIn("trusted=yes", repo["content"])
        user_role = list(tasks(load(ROOT / "roles/pa_bb_browser_automation/tasks/main.yml")))
        self.assertFalse(any("ansible.builtin.apt" in t for t in user_role))
        self.assertFalse(any("plugin" in str(t.get("ansible.builtin.command", {}))
                             for t in self.tasks + browser))

    def test_all_yaml_parses_and_no_inventory_is_shipped(self):
        for path in ROOT.rglob("*.yml"):
            self.assertIsNotNone(load(path), str(path))
        self.assertFalse(list(ROOT.rglob("*inventory*")))
        self.assertFalse(list(ROOT.rglob("*.pem")))
        self.assertFalse(list(ROOT.rglob("*.key")))

    def test_verification_only_uses_read_only_modules(self):
        for task in tasks(load(ROLE / "tasks/verify.yml")):
            self.assertTrue({key for key in task if key.startswith("ansible.")} <= {
                "ansible.builtin.stat", "ansible.builtin.assert", "ansible.builtin.command",
            })
            if "ansible.builtin.command" in task:
                self.assertIs(task["changed_when"], False)
                self.assertIs(task["check_mode"], False)


if __name__ == "__main__":
    unittest.main()
