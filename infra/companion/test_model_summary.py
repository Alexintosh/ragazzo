import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('summary', Path(__file__).with_name('model-summary.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class ModelSummaryTests(unittest.TestCase):
    def test_projection_omits_credentials_endpoints_and_prompts(self):
        result = summary.summarize({
            'providers': {'private': {'chat': 'https://provider.invalid/v1/chat/completions', 'headers': {'Authorization': 'private-key'}}},
            'tasks': {'chat_companion': {'model': 'test-model', 'fallback': ['backup-model'], 'temperature': 0.7, 'max_tokens': 800, 'tiers': {'test_profile': {'model': 'other'}}, 'filter_prompt': 'private instructions'}},
        })
        self.assertEqual(result, {'profiles': ['test_profile'], 'tasks': [{'name': 'chat_companion', 'models': ['test-model'], 'fallback': ['backup-model'], 'temperature': 0.7, 'maxTokens': 800}]})
        self.assertNotIn('private', str(result))

    def test_weighted_models_and_missing_configuration(self):
        self.assertEqual(summary.summarize({}), {'tasks': [], 'profiles': []})
        result = summary.summarize({'tasks': {'affinity_evaluation': {'model': {'one': 0.4, 'two': 0.6}}}})
        self.assertEqual(result['tasks'][0]['models'], ['one', 'two'])
        self.assertIsNone(result['tasks'][0]['temperature'])

    def test_profiles_and_models_match_public_string_limits(self):
        result = summary.summarize({'tasks': {'chat_companion': {
            'model': ['valid-model', '\U0001f600' * 128, '\U0001f600' * 129, 'm' * 257],
            'tiers': {'advanced': {}, 'valid_2': {}, 'invalid-profile': {}, 'A': {}, 'a' * 33: {}},
        }}})
        self.assertEqual(result['profiles'], ['advanced', 'valid_2'])
        self.assertEqual(result['tasks'][0]['models'], ['valid-model', '\U0001f600' * 128])

    def test_invalid_numbers_are_omitted_without_invalid_json(self):
        for value in (True, False, float('nan'), float('inf'), -float('inf'), 10 ** 1000):
            with self.subTest(value=value):
                result = summary.summarize({'tasks': {'chat_companion': {
                    'temperature': value, 'max_tokens': value,
                }}})
                self.assertIsNone(result['tasks'][0]['temperature'])
                self.assertIsNone(result['tasks'][0]['maxTokens'])
                json.dumps(result, allow_nan=False)
        result = summary.summarize({'tasks': {'chat_companion': {
            'temperature': 1, 'max_tokens': 9007199254740991,
        }}})
        self.assertEqual(result['tasks'][0]['temperature'], 1)
        self.assertEqual(result['tasks'][0]['maxTokens'], 9007199254740991)
        result = summary.summarize({'tasks': {'chat_companion': {'max_tokens': 9007199254740992}}})
        self.assertIsNone(result['tasks'][0]['maxTokens'])

    def test_malformed_task_sections_leave_projection_available(self):
        self.assertEqual(summary.summarize({'tasks': []}), {'tasks': [], 'profiles': []})
        self.assertEqual(summary.summarize({'tasks': {'chat_companion': False}}), {'tasks': [], 'profiles': []})


if __name__ == '__main__':
    unittest.main()
