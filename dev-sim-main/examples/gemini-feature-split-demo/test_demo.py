#!/usr/bin/env python3
"""Smoke tests for demo.py — no live API calls required."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demo  # noqa: E402


MINIMAL_FEATURE = {
    "sprint": 1,
    "name": "User Auth",
    "user_outcome": "Users can sign up and log in.",
    "frontend": ["Login form", "Sign-up form"],
    "backend": ["POST /auth/register", "POST /auth/login"],
    "contract": ["JWT token in response"],
    "risks": ["Token expiry UX"],
    "definition_of_done": ["Integration test for login flow"],
}

MINIMAL_PLAN = {
    "summary": "A simple app.",
    "dependencies": ["Sprint 1 must ship before Sprint 2"],
    "assumptions": ["Web-first", "No mobile in v1"],
    "features": [MINIMAL_FEATURE],
}


class TestParseResponse(unittest.TestCase):
    def test_clean_json(self):
        raw = json.dumps(MINIMAL_PLAN)
        result = demo.parse_response(raw)
        self.assertEqual(result["summary"], "A simple app.")

    def test_json_wrapped_in_prose(self):
        raw = f"Sure, here you go:\n{json.dumps(MINIMAL_PLAN)}\nEnd."
        result = demo.parse_response(raw)
        self.assertIn("features", result)

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            demo.parse_response("No JSON here at all.")


class TestValidatePlan(unittest.TestCase):
    def test_valid_plan_passes(self):
        demo.validate_plan(MINIMAL_PLAN)

    def test_missing_top_key(self):
        bad = {k: v for k, v in MINIMAL_PLAN.items() if k != "summary"}
        with self.assertRaises(ValueError, msg="should catch missing 'summary'"):
            demo.validate_plan(bad)

    def test_empty_features_list(self):
        bad = {**MINIMAL_PLAN, "features": []}
        with self.assertRaises(ValueError):
            demo.validate_plan(bad)

    def test_feature_missing_key(self):
        bad_feat = {k: v for k, v in MINIMAL_FEATURE.items() if k != "backend"}
        bad = {**MINIMAL_PLAN, "features": [bad_feat]}
        with self.assertRaises(ValueError, msg="should catch missing 'backend'"):
            demo.validate_plan(bad)

    def test_feature_sprint_not_number(self):
        bad_feat = {**MINIMAL_FEATURE, "sprint": "one"}
        bad = {**MINIMAL_PLAN, "features": [bad_feat]}
        with self.assertRaises(ValueError):
            demo.validate_plan(bad)

    def test_feature_list_field_wrong_type(self):
        bad_feat = {**MINIMAL_FEATURE, "frontend": "not a list"}
        bad = {**MINIMAL_PLAN, "features": [bad_feat]}
        with self.assertRaises(ValueError):
            demo.validate_plan(bad)


class TestToFeaturePlan(unittest.TestCase):
    def test_basic_conversion(self):
        fp = demo.to_feature_plan(MINIMAL_FEATURE)
        self.assertEqual(fp.sprint, 1)
        self.assertEqual(fp.name, "User Auth")
        self.assertEqual(fp.frontend, ["Login form", "Sign-up form"])
        self.assertEqual(fp.support, [])

    def test_optional_support_field(self):
        with_support = {**MINIMAL_FEATURE, "support": ["Design review"]}
        fp = demo.to_feature_plan(with_support)
        self.assertEqual(fp.support, ["Design review"])


class TestSlugify(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(demo.slugify("User Auth"), "user-auth")

    def test_special_chars(self):
        self.assertEqual(demo.slugify("Sprint #1: Login & Register!"), "sprint-1-login-register")

    def test_empty(self):
        self.assertEqual(demo.slugify(""), "feature")


class TestWriteDocs(unittest.TestCase):
    def test_files_created(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            demo.write_docs(MINIMAL_PLAN, "Test idea", out_dir=out)

            overview = out / "srs" / "overview.md"
            self.assertTrue(overview.exists(), "overview.md not created")
            content = overview.read_text()
            self.assertIn("Test idea", content)
            self.assertIn("User Auth", content)

            feat_file = out / "features" / "01-user-auth.md"
            self.assertTrue(feat_file.exists(), f"{feat_file} not created")
            feat_content = feat_file.read_text()
            self.assertIn("Sprint 1", feat_content)
            self.assertIn("Login form", feat_content)

    def test_multi_feature_ordering(self):
        import tempfile
        feat2 = {**MINIMAL_FEATURE, "sprint": 2, "name": "Dashboard"}
        plan = {**MINIMAL_PLAN, "features": [feat2, MINIMAL_FEATURE]}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            demo.write_docs(plan, "Two sprints", out_dir=out)
            overview = (out / "srs" / "overview.md").read_text()
            self.assertLess(
                overview.index("Sprint 1"),
                overview.index("Sprint 2"),
                "Features should appear in sprint order",
            )


class TestBuildLlmPrompt(unittest.TestCase):
    def test_contains_idea(self):
        prompt = demo.build_llm_prompt("seed text", "my project idea")
        self.assertIn("my project idea", prompt)
        self.assertIn("seed text", prompt)
        self.assertIn("JSON", prompt)


if __name__ == "__main__":
    unittest.main()
