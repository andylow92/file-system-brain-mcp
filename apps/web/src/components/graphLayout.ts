/**
 * A tiny, dependency-free force-directed layout (Fruchterman–Reingold). We
 * compute node positions ourselves rather than pull in a graph library so the
 * lazy-loaded Graph chunk stays small and the layout is fully deterministic —
 * seeded from a hash of each node id, with no `Math.random`, so the same vault
 * always lays out the same way (and tests stay stable).
 */
import type { GraphData } from '@repo/shared';

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
}

/** Deterministic 32-bit FNV-1a hash of a string. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Compute a position for every node in the graph. Returns a map of node id →
 * `{ x, y }` in the coordinate space `[0, width] × [0, height]`.
 */
export function computeGraphLayout(
  graph: GraphData,
  options: LayoutOptions = {},
): Map<string, Point> {
  const width = options.width ?? 1000;
  const height = options.height ?? 720;
  const { nodes, edges } = graph;
  const count = nodes.length;
  const positions = new Map<string, Point>();

  if (count === 0) {
    return positions;
  }

  // Deterministic seed: scatter nodes around the centre using a hash of the id,
  // so the layout is reproducible and isolated nodes don't all stack up.
  nodes.forEach((node) => {
    const hash = hashString(node.id);
    const angle = (hash % 360) * (Math.PI / 180);
    const radius = ((hash >>> 9) % 1000) / 1000; // 0..1
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius * (width / 3),
      y: height / 2 + Math.sin(angle) * radius * (height / 3),
    });
  });

  if (count === 1) {
    return positions;
  }

  const indexById = new Map(nodes.map((node, i) => [node.id, i]));
  const area = width * height;
  const k = Math.sqrt(area / count); // ideal edge length
  const iterations = options.iterations ?? 300;
  let temperature = width / 10;
  const cooling = temperature / (iterations + 1);
  const disp = nodes.map(() => ({ x: 0, y: 0 }));

  for (let iter = 0; iter < iterations; iter += 1) {
    for (let i = 0; i < count; i += 1) {
      disp[i].x = 0;
      disp[i].y = 0;
    }

    // Repulsive forces between every pair (O(n²) — fine for a personal vault).
    for (let i = 0; i < count; i += 1) {
      const pi = positions.get(nodes[i].id)!;
      for (let j = i + 1; j < count; j += 1) {
        const pj = positions.get(nodes[j].id)!;
        let dx = pi.x - pj.x;
        let dy = pi.y - pj.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          // Deterministic nudge so coincident seeds separate (no Math.random).
          dx = (i + 1) * 0.013 - (j + 1) * 0.017;
          dy = (i + 1) * 0.011 - (j + 1) * 0.019;
          dist = Math.hypot(dx, dy) || 0.01;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }

    // Attractive forces along edges.
    for (const edge of edges) {
      const si = indexById.get(edge.source);
      const ti = indexById.get(edge.target);
      if (si === undefined || ti === undefined) {
        continue;
      }
      const ps = positions.get(edge.source)!;
      const pt = positions.get(edge.target)!;
      const dx = ps.x - pt.x;
      const dy = ps.y - pt.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[si].x -= fx;
      disp[si].y -= fy;
      disp[ti].x += fx;
      disp[ti].y += fy;
    }

    // Apply displacement, capped by the current temperature, kept in-bounds.
    for (let i = 0; i < count; i += 1) {
      const p = positions.get(nodes[i].id)!;
      const d = disp[i];
      const len = Math.hypot(d.x, d.y) || 0.01;
      p.x += (d.x / len) * Math.min(len, temperature);
      p.y += (d.y / len) * Math.min(len, temperature);
      p.x = Math.min(width - 24, Math.max(24, p.x));
      p.y = Math.min(height - 24, Math.max(24, p.y));
    }

    temperature = Math.max(temperature - cooling, 1);
  }

  return positions;
}

/** Map each node id to the set of node ids it is directly connected to. */
export function computeAdjacency(graph: GraphData): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) {
      adjacency.set(a, new Set());
    }
    adjacency.get(a)!.add(b);
  };
  for (const edge of graph.edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  return adjacency;
}

/**
 * A curated palette of soft, harmonious colours for tag-based node colouring —
 * chosen to sit alongside the app's system-blue accent on the graphite canvas
 * without the clashing neon you get from a raw hash-to-hue.
 */
export const GRAPH_TAG_COLORS = [
  '#0a84ff', // system blue (the app accent)
  '#7cb89a', // sage
  '#6fa8c7', // dusty blue
  '#b58bc4', // mauve
  '#d98a72', // terracotta
  '#c9a14a', // amber
  '#84b06a', // moss
  '#c77f9e', // rose
] as const;

/** Pick a stable colour from the curated palette for a tag. */
export function colorForTag(tag: string): string {
  return GRAPH_TAG_COLORS[hashString(tag) % GRAPH_TAG_COLORS.length];
}
