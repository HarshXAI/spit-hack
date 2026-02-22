/**
 * Graph layout algorithm.
 * Assigns deterministic x/y coordinates to service nodes for frontend rendering.
 * Uses a tier-based layout: INGRESS → CORE → DOMAIN → INFRA
 * arranged left-to-right across a 1400×700 virtual canvas.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawNode {
    id: string;
}

interface RawEdge {
    source_id: string;
    target_id: string;
}

export interface LayoutCoords {
    x: number;
    y: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Virtual canvas dimensions — match the frontend SVG viewBox. */
const CANVAS_WIDTH = 1400;
const CANVAS_HEIGHT = 700;

/** X position for each tier column (0=INGRESS, 1=CORE, 2=DOMAIN, 3=INFRA). */
const TIER_X: readonly number[] = [150, 450, 800, 1200];

// ── Tier detection ────────────────────────────────────────────────────────────

/**
 * Assigns a tier index (0–3) to a node based on its in/out degree.
 *
 * Tier 0 — INGRESS: produces output, receives nothing (pure sources)
 * Tier 1 — CORE:    many outbound connections (fan-out hubs)
 * Tier 3 — INFRA:   receives connections, sends nothing (pure sinks)
 * Tier 2 — DOMAIN:  everything else
 *
 * @param outDeg - Number of outbound edges for the node
 * @param inDeg  - Number of inbound edges for the node
 * @returns Tier index 0–3
 */
function detectTier(outDeg: number, inDeg: number): number {
    if (outDeg > 0 && inDeg === 0) return 0;   // INGRESS
    if (outDeg === 0 && inDeg > 0) return 3;   // INFRA
    if (outDeg >= 3) return 1;                 // CORE — heavy fan-out
    return 2;                                  // DOMAIN
}

// ── Layout function ───────────────────────────────────────────────────────────

/**
 * Computes a layout map of nodeId → {x, y} for the given nodes and edges.
 * Nodes with no edges are placed in the DOMAIN tier.
 * Y positions are evenly distributed within each tier.
 *
 * @param nodes - Array of objects with an `id` field
 * @param edges - Array of objects with `source_id` and `target_id` fields
 * @returns Map from nodeId to layout coordinates
 */
export function computeLayout(
    nodes: RawNode[],
    edges: RawEdge[],
): Map<string, LayoutCoords> {
    // Build degree maps
    const outDeg = new Map<string, number>();
    const inDeg = new Map<string, number>();

    for (const n of nodes) {
        outDeg.set(n.id, 0);
        inDeg.set(n.id, 0);
    }
    for (const e of edges) {
        outDeg.set(e.source_id, (outDeg.get(e.source_id) ?? 0) + 1);
        inDeg.set(e.target_id, (inDeg.get(e.target_id) ?? 0) + 1);
    }

    // Group nodes by tier
    const tiers: Map<number, string[]> = new Map([[0, []], [1, []], [2, []], [3, []]]);
    for (const n of nodes) {
        const tier = detectTier(outDeg.get(n.id) ?? 0, inDeg.get(n.id) ?? 0);
        tiers.get(tier)!.push(n.id);
    }

    // Assign coordinates
    const layout = new Map<string, LayoutCoords>();

    /** Max nodes to stack vertically in a single sub-column before splitting */
    const MAX_PER_COL = 4;
    /** Horizontal spacing between sub-columns within the same tier */
    const SUB_COL_SPACING = 120;

    for (const [tier, ids] of tiers) {
        if (ids.length === 0) continue;
        const baseX = TIER_X[tier] ?? CANVAS_WIDTH / 2;

        if (ids.length <= MAX_PER_COL) {
            // Single column — original behaviour
            const step = CANVAS_HEIGHT / (ids.length + 1);
            ids.forEach((id, i) => {
                layout.set(id, { x: baseX, y: Math.round(step * (i + 1)) });
            });
        } else {
            // Split into multiple sub-columns so nodes fan out horizontally
            const numCols = Math.ceil(ids.length / MAX_PER_COL);
            const rowCount = Math.ceil(ids.length / numCols);
            ids.forEach((id, i) => {
                const col = i % numCols;
                const row = Math.floor(i / numCols);
                // Centre the sub-columns symmetrically around baseX
                const xOffset = (col - (numCols - 1) / 2) * SUB_COL_SPACING;
                const step = CANVAS_HEIGHT / (rowCount + 1);
                layout.set(id, {
                    x: Math.round(baseX + xOffset),
                    y: Math.round(step * (row + 1)),
                });
            });
        }
    }

    return layout;
}
