import os
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analyzer import analyze, expand_coverage, statement_spans


def states(source, lines):
    return {
        number: item['state'] for item in expand_coverage(source, lines)
        for number in range(item['start'], item['end'] + 1)
    }


class StatementTests(unittest.TestCase):
    def test_dict_and_call_expand_without_bleeding_into_next_statement(self):
        source = 'result = {\n    "x": call(\n        1,\n    ),\n}\nnext_value = 2\n'
        self.assertEqual(states(source, [{'number': '1', 'hits': '1'}, {'number': '6', 'hits': '0'}]),
                         {1: 'covered', 2: 'covered', 3: 'covered', 4: 'covered', 5: 'covered', 6: 'uncovered'})

    def test_signature_does_not_color_function_body(self):
        source = 'def fn(\n    arg,\n):\n    return arg\n'
        self.assertEqual(states(source, [{'number': '1', 'hits': '1'}, {'number': '4', 'hits': '0'}]),
                         {1: 'covered', 2: 'covered', 3: 'covered', 4: 'uncovered'})

    def test_partial_and_unexecuted_branches(self):
        source = 'if (\n    value\n):\n    fail()\n'
        lines = [{'number': '1', 'hits': '1', 'branch': 'true', 'condition-coverage': '50% (1/2)'},
                 {'number': '4', 'hits': '0', 'branch': 'true', 'condition-coverage': '0% (0/2)'}]
        self.assertEqual(states(source, lines), {1: 'partial', 2: 'partial', 3: 'partial', 4: 'uncovered'})

    def test_comments_blank_lines_and_unmeasured_code_not_guessed(self):
        source = '# comment\nx = 1\n\n# comment\ny = 2\n'
        self.assertEqual(states(source, [{'number': '2', 'hits': '1'}]), {2: 'covered'})

    def test_backslash_continuation_and_multiline_string(self):
        source = 'x = 1 + \\\n    2\ny = """hello\nworld"""\n'
        self.assertEqual(statement_spans(source), [(1, 2), (3, 4)])

    def test_explicit_measurements_win_inside_one_logical_statement(self):
        source = 'value = (\n    one\n    + two\n)\n'
        result = states(source, [{'number': '1', 'hits': '1'}, {'number': '3', 'hits': '0'}])
        self.assertEqual(result[3], 'uncovered')
        self.assertEqual(result[4], 'covered')

    def test_incomplete_source_does_not_guess_a_span(self):
        with self.assertRaises(ValueError):
            statement_spans('value = (\n')

    def test_blank_gap_inherits_matching_neighbor_status(self):
        source = '\nx = 1\n\n  \n\ty = 2\n\n'
        for hits, state in [('1', 'covered'), ('0', 'uncovered')]:
            with self.subTest(state=state):
                result = states(source, [{'number': '2', 'hits': hits}, {'number': '5', 'hits': hits}])
                self.assertEqual(result, {2: state, 3: state, 4: state, 5: state})

    def test_blank_gap_between_partial_statements_is_yellow(self):
        line = {'hits': '1', 'branch': 'true', 'condition-coverage': '50% (1/2)'}
        self.assertEqual(states('if x: pass\n\nif y: pass\n', [dict(line, number='1'), dict(line, number='3')]),
                         {1: 'partial', 2: 'partial', 3: 'partial'})

    def test_gap_between_different_states_stays_unpainted(self):
        result = states('x = 1\n\ny = 2\n', [{'number': '1', 'hits': '1'}, {'number': '3', 'hits': '0'}])
        self.assertEqual(result, {1: 'covered', 3: 'uncovered'})

    def test_does_not_bridge_comments_or_unmeasured_statements(self):
        for middle in ['# comment', 'z = 3']:
            with self.subTest(middle=middle):
                source = 'x = 1\n\n' + middle + '\n\ny = 2\n'
                result = states(source, [{'number': '1', 'hits': '1'}, {'number': '5', 'hits': '1'}])
                self.assertEqual(result, {1: 'covered', 5: 'covered'})

    def test_blank_gap_can_be_disabled(self):
        ranges = expand_coverage('x = 1\n\ny = 2\n',
                                 [{'number': '1', 'hits': '1'}, {'number': '3', 'hits': '1'}],
                                 fill_blank_lines=False)
        self.assertEqual([(r['start'], r['end']) for r in ranges], [(1, 1), (3, 3)])


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.a = self.root / 'one' / 'same.py'
        self.b = self.root / 'two' / 'same.py'
        for filename in [self.a, self.b]:
            filename.parent.mkdir()
            filename.write_text('value = [\n    1,\n]\n')
        self.report = self.root / 'coverage.xml'
        root = ET.Element('coverage')
        ET.SubElement(ET.SubElement(root, 'sources'), 'source').text = str(self.root)
        classes = ET.SubElement(ET.SubElement(ET.SubElement(root, 'packages'), 'package'), 'classes')
        for filename, hits in [(self.a, '1'), (self.b, '0')]:
            cls = ET.SubElement(classes, 'class', filename=str(filename.relative_to(self.root)))
            ET.SubElement(ET.SubElement(cls, 'lines'), 'line', number='1', hits=hits)
        ET.ElementTree(root).write(self.report)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, **kwargs):
        return analyze(dict(report=str(self.report), workspace=str(self.root),
                            files=[str(self.a), str(self.b)], **kwargs))

    def test_exact_paths_and_percentages_from_original_report(self):
        result = self.request()
        a, b = result[str(self.a)], result[str(self.b)]
        self.assertEqual((a['covered'], a['total']), (1, 1))
        self.assertEqual((b['covered'], b['total']), (0, 1))
        self.assertEqual(a['ranges'], [{'start': 1, 'end': 3, 'state': 'covered', 'anchor': 1}])
        self.assertEqual(b['ranges'][0]['state'], 'uncovered')

    def test_missing_file_is_not_painted_uncovered(self):
        missing = self.root / 'not-measured.py'
        missing.write_text('x = 1\n')
        result = analyze(dict(report=str(self.report), workspace=str(self.root), files=[str(missing)]))
        self.assertEqual(result[str(missing)], {'status': 'missing', 'ranges': []})

    def test_stale_report_hidden_and_can_be_overridden(self):
        later = self.report.stat().st_mtime_ns + 1_000_000_000
        os.utime(self.a, ns=(later, later))
        self.assertEqual(self.request()[str(self.a)]['status'], 'stale')
        self.assertEqual(self.request(hideStale=False)[str(self.a)]['status'], 'ok')

    def test_malformed_report_fails_instead_of_painting_all_red(self):
        self.report.write_text('<coverage>')
        with self.assertRaises(ET.ParseError):
            self.request()


if __name__ == '__main__':
    unittest.main()
