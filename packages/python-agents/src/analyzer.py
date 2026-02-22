"""
KA-CHOW Dependency Analyzer
============================
Builds a directed dependency graph from AST scan results using NetworkX,
then derives health signals to feed the knowledge graph.

Called as a subprocess by the Node.js ingestion engine (Phase 1).

Usage:
    python analyzer.py <scan_results.json>

Input:
    JSON file containing a list of ScanResult objects (output of scanner.py).

Output:
    JSON to stdout with graph nodes, edges, and health signals.
"""

import json
import sys
import os
from typing import Any

try:
    import networkx as nx
    HAS_NETWORKX = True
except ImportError:
    HAS_NETWORKX = False


# ── Graph builder ─────────────────────────────────────────────────────────────

def _filepath_to_module(filepath: str) -> str:
    """
    Convert a file path to a short Python module name for use as a graph node.

    Args:
        filepath: Absolute or relative path to a .py file.

    Returns:
        Dot-separated module name using the last two path components.
    """
    # Normalise separators, strip .py extension
    normalised = filepath.replace('\\', '/').rstrip('/')
    if normalised.endswith('.py'):
        normalised = normalised[:-3]

    parts = normalised.split('/')
    # Use last 2 parts for readability (e.g. "inventory.pool")
    return '.'.join(parts[-2:]) if len(parts) >= 2 else parts[-1]


def build_dependency_graph(scan_results: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Build a directed dependency graph from a list of AST scan results.

    Args:
        scan_results: Output of scanner.scan_directory() or scan_file().

    Returns:
        Dict with keys: nodes, edges, node_count, edge_count.
        Returns an error dict if networkx is not installed.
    """
    if not HAS_NETWORKX:
        return {'error': 'networkx is not installed. Run: pip install networkx'}

    graph: nx.DiGraph = nx.DiGraph()

    for result in scan_results:
        if result.get('error'):
            continue

        filepath = result.get('filepath', '')
        module_name = _filepath_to_module(filepath)
        graph.add_node(module_name, filepath=filepath)

        for imp in result.get('imports', []):
            # Skip private/dunder modules and standard lib noise
            if not imp or imp.startswith('_'):
                continue
            top_level = imp.split('.')[0]
            graph.add_edge(module_name, top_level)

    return {
        'nodes': [{'id': n, **d} for n, d in graph.nodes(data=True)],
        'edges': [{'source': u, 'target': v} for u, v in graph.edges()],
        'node_count': graph.number_of_nodes(),
        'edge_count': graph.number_of_edges(),
    }


# ── Health signal calculator ──────────────────────────────────────────────────

def calculate_health_signals(scan_results: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Derive health signals from scan results that feed into the health score formula.

    Signals detected:
      - missing_error_handling: HTTP calls without surrounding try/except
      - http_calls_total: Total external HTTP calls found

    Args:
        scan_results: Output of scanner.scan_directory() or scan_file().

    Returns:
        Dict with total_issues, issues list, and per-signal counts.
    """
    issues: list[dict[str, Any]] = []
    total_http = 0

    for result in scan_results:
        if result.get('error'):
            continue

        filepath = result.get('filepath', '')
        http_calls = result.get('http_calls', [])
        missing = result.get('missing_error_handling', [])
        total_http += len(http_calls)

        for call in missing:
            issues.append({
                'type': 'missing-error-handling',
                'filepath': filepath,
                'call': call.get('call'),
                'line': call.get('line'),
            })

    return {
        'total_issues': len(issues),
        'total_http_calls': total_http,
        'issues': issues,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: analyzer.py <scan_results.json>'}))
        sys.exit(1)

    input_path = sys.argv[1]

    if not os.path.isfile(input_path):
        print(json.dumps({'error': f'File not found: {input_path}'}))
        sys.exit(1)

    with open(input_path, 'r') as f:
        scan_results = json.load(f)

    if not isinstance(scan_results, list):
        scan_results = [scan_results]

    output = {
        'graph': build_dependency_graph(scan_results),
        'health': calculate_health_signals(scan_results),
    }

    print(json.dumps(output, indent=2))
