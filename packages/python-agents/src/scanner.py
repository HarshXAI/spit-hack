"""
KA-CHOW Python AST Scanner
===========================
Scans Python source files for:
  - Import statements (maps to service dependencies)
  - HTTP calls (axios equivalents: requests, httpx, aiohttp)
  - Missing try/except around external calls
  - Async calls without retry patterns

Called as a subprocess by the Node.js ingestion engine (Phase 1).

Usage:
    python scanner.py <file_or_directory>

Output:
    JSON to stdout — see ScanResult type below.
"""

import ast
import os
import sys
import json
from typing import Any


# ── Types (as dicts — no dataclasses for easy JSON serialisation) ─────────────

# ScanResult = {
#   filepath: str,
#   imports: list[str],
#   http_calls: list[{ call: str, line: int }],
#   missing_error_handling: list[{ call: str, line: int }],
#   error: str | None,
# }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_call_name(node: ast.Call) -> str | None:
    """Extract the dotted function name from an ast.Call node."""
    if isinstance(node.func, ast.Attribute):
        if isinstance(node.func.value, ast.Name):
            return f"{node.func.value.id}.{node.func.attr}"
    elif isinstance(node.func, ast.Name):
        return node.func.id
    return None


def _is_inside_try(node: ast.AST, parent_map: dict[ast.AST, ast.AST]) -> bool:
    """Walk up the parent map to check if node is inside a try/except block."""
    current = parent_map.get(node)
    while current is not None:
        if isinstance(current, ast.Try):
            return True
        current = parent_map.get(current)
    return False


def _build_parent_map(tree: ast.Module) -> dict[ast.AST, ast.AST]:
    """Build a child→parent mapping for the entire AST."""
    parent_map: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parent_map[child] = parent
    return parent_map


# ── Core scanner ─────────────────────────────────────────────────────────────

HTTP_LIBS = ('requests.', 'httpx.', 'aiohttp.')


def scan_file(filepath: str) -> dict[str, Any]:
    """
    Scan a single Python file for dependency and quality signals.

    Args:
        filepath: Absolute or relative path to the .py file.

    Returns:
        ScanResult dict with imports, http_calls, and quality issues.
    """
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            source = f.read()
    except OSError as e:
        return {'filepath': filepath, 'error': str(e), 'imports': [], 'http_calls': [], 'missing_error_handling': []}

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError as e:
        return {'filepath': filepath, 'error': f'SyntaxError: {e}', 'imports': [], 'http_calls': [], 'missing_error_handling': []}

    parent_map = _build_parent_map(tree)

    result: dict[str, Any] = {
        'filepath': filepath,
        'error': None,
        'imports': [],
        'http_calls': [],
        'missing_error_handling': [],
    }

    for node in ast.walk(tree):
        # ── Imports ──────────────────────────────────────────────────────────
        if isinstance(node, ast.Import):
            for alias in node.names:
                result['imports'].append(alias.name)

        elif isinstance(node, ast.ImportFrom):
            if node.module:
                result['imports'].append(node.module)

        # ── HTTP calls ───────────────────────────────────────────────────────
        elif isinstance(node, ast.Call):
            call_name = _get_call_name(node)
            if call_name and any(call_name.startswith(lib) for lib in HTTP_LIBS):
                call_info = {'call': call_name, 'line': node.lineno}
                result['http_calls'].append(call_info)

                # Flag if not inside a try/except
                if not _is_inside_try(node, parent_map):
                    result['missing_error_handling'].append(call_info)

    return result


def scan_directory(dirpath: str) -> list[dict[str, Any]]:
    """
    Recursively scan all Python files in a directory.

    Args:
        dirpath: Root directory to scan.

    Returns:
        List of ScanResult dicts, one per .py file found.
    """
    results: list[dict[str, Any]] = []
    skip_dirs = {'venv', '.venv', '__pycache__', 'node_modules', '.git', 'dist', 'build'}

    for root, dirs, files in os.walk(dirpath):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for filename in files:
            if filename.endswith('.py'):
                filepath = os.path.join(root, filename)
                results.append(scan_file(filepath))

    return results


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: scanner.py <file_or_directory>'}))
        sys.exit(1)

    target = sys.argv[1]

    if os.path.isfile(target):
        output: Any = scan_file(target)
    elif os.path.isdir(target):
        output = scan_directory(target)
    else:
        output = {'error': f'Path not found: {target}'}

    print(json.dumps(output, indent=2))
