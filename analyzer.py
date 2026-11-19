"""Expand Cobertura line coverage to Python logical statements; never import project code."""

import bisect
import io
import json
from pathlib import Path
import sys
import tokenize
import xml.etree.ElementTree as ET


def statement_spans(source):
    """Token NEWLINE ends a logical statement; NL inside brackets does not."""
    spans = []
    start = end = None
    ignored = {tokenize.ENCODING, tokenize.INDENT, tokenize.DEDENT,
               tokenize.NL, tokenize.COMMENT, tokenize.ENDMARKER}
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.NEWLINE:
                if start is not None:
                    spans.append((start, end))
                start = end = None
            elif token.type not in ignored:
                if token.type == tokenize.ERRORTOKEN and token.string.strip():
                    raise ValueError("Source contains invalid Python tokens")
                if start is None:
                    start = token.start[0]
                end = token.end[0]
    except (tokenize.TokenError, IndentationError) as exc:
        raise ValueError(f"Cannot tokenize source: {exc}") from exc
    if start is not None:
        spans.append((start, end))
    return spans


def line_state(line):
    if int(line.get("hits", "0")) == 0:
        return "uncovered"
    condition = line.get("condition-coverage", "100%")
    if line.get("branch") == "true" and float(condition.split("%", 1)[0]) < 100:
        return "partial"
    return "covered"


def expand_coverage(source, lines, fill_blank_lines=True):
    """Keep explicit measurements authoritative, expanding only unmeasured continuations."""
    spans = statement_spans(source)
    starts = [start for start, _ in spans]
    explicit = {int(line["number"]): line_state(line) for line in lines}
    result = {number: (state, number) for number, state in explicit.items()}
    for number, state in sorted(explicit.items()):
        index = bisect.bisect_right(starts, number) - 1
        if index < 0:
            continue
        start, end = spans[index]
        if number <= end:
            for continuation in range(start, end + 1):
                result.setdefault(continuation, (state, number))

    if fill_blank_lines:
        source_lines = source.splitlines()
        measured = sorted(result)
        for previous, following in zip(measured, measured[1:]):
            if following <= previous + 1 or result[previous][0] != result[following][0]:
                continue
            # Only bridge whitespace: never infer coverage for comments or unmeasured code.
            if following > len(source_lines) or any(
                source_lines[number - 1].strip() for number in range(previous + 1, following)
            ):
                continue
            for number in range(previous + 1, following):
                result[number] = result[previous]

    # Coalesce only lines with the same state AND origin for accurate hover information.
    ranges = []
    for number, (state, anchor) in sorted(result.items()):
        if ranges and ranges[-1]["end"] == number - 1 and (
            ranges[-1]["state"], ranges[-1]["anchor"]
        ) == (state, anchor):
            ranges[-1]["end"] = number
        else:
            ranges.append({"start": number, "end": number, "state": state, "anchor": anchor})
    return ranges


def report_index(report, workspace, requested):
    """Resolve only exact paths; never confuse same-named files in different packages."""
    root = ET.parse(report).getroot()
    sources = [element.text for element in root.findall("./sources/source") if element.text]
    bases = [Path(workspace)]
    for source in sources:
        path = Path(source)
        bases.append(path if path.is_absolute() else Path(workspace) / path)
    indexed = {}
    for cls in root.findall(".//class"):
        filename = cls.get("filename", "")
        if not filename:
            continue
        path = Path(filename)
        candidates = [path.resolve()] if path.is_absolute() else [(base / path).resolve() for base in bases]
        matches = set(candidates) & requested
        if len(matches) > 1:
            raise ValueError(f"Ambiguous coverage path: {filename}")
        for match in matches:
            measured = indexed.setdefault(match, {})
            for line in cls.findall("./lines/line"):
                number = int(line.attrib["number"])
                # Duplicate classes are merged without manufacturing execution counts.
                previous = measured.get(number)
                rank = {"uncovered": 0, "partial": 1, "covered": 2}
                if previous is None or rank[line_state(line.attrib)] > rank[line_state(previous)]:
                    measured[number] = dict(line.attrib)
    return indexed


def analyze(request):
    report = Path(request["report"]).resolve()
    requested = {Path(filename).resolve() for filename in request["files"]}
    index = report_index(report, request["workspace"], requested)
    report_time = report.stat().st_mtime_ns
    results = {}
    for filename in requested:
        key = str(filename)
        if filename not in index:
            results[key] = {"status": "missing", "ranges": []}
            continue
        if request.get("hideStale", True) and filename.stat().st_mtime_ns > report_time:
            results[key] = {"status": "stale", "ranges": []}
            continue
        try:
            with tokenize.open(filename) as source_file:
                source = source_file.read()
            lines = list(index[filename].values())
            ranges = expand_coverage(source, lines, request.get("fillBlankLines", True))
            # Percentages are based on original report entries, never on expanded display lines.
            total = len(lines)
            covered = sum(int(line.get("hits", "0")) > 0 for line in lines)
            results[key] = {"status": "ok", "ranges": ranges, "covered": covered, "total": total}
        except (ValueError, SyntaxError, OSError) as exc:
            results[key] = {"status": "error", "error": str(exc), "ranges": []}
    return results


if __name__ == "__main__":
    try:
        json.dump(analyze(json.load(sys.stdin)), sys.stdout)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
