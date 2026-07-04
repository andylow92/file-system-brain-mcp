import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { getPageType, type GraphData, type GraphNode } from '@repo/shared';
import { colorForTag, computeAdjacency, computeGraphLayout, type Point } from './graphLayout';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 720;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const BASE_RADIUS = 6;
const UNRESOLVED_RADIUS = 5;

interface KnowledgeGraphProps {
  graph: GraphData;
  onSelectFile: (path: string) => void;
  /** The currently-open note, highlighted in the graph. */
  selectedPath?: string | null;
}

interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

function nodeColor(node: GraphNode): string {
  if (node.unresolved) {
    return 'var(--color-danger)';
  }
  // A canonical page type wins over tags: colour a note by *what it is* first.
  const pageType = getPageType(node.type);
  if (pageType) {
    return pageType.color;
  }
  if (node.tags.length > 0) {
    return colorForTag(node.tags[0]);
  }
  return 'var(--color-accent)';
}

/** A gentle quadratic arc between two points — softer than a straight line. */
function edgePath(a: Point, b: Point): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Bow the curve perpendicular to the edge by a small fraction of its length.
  const cx = mx - dy * 0.08;
  const cy = my + dx * 0.08;
  return `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`;
}

/**
 * Render the vault's wikilink graph as an interactive, force-directed SVG.
 * Layout is computed deterministically (see `graphLayout`), so this component
 * is pure render + interaction: hover to highlight a node and its neighbors,
 * click a note to open it, pan/zoom to explore. Lazy-loaded so it stays out of
 * the main bundle.
 */
export function KnowledgeGraph({ graph, onSelectFile, selectedPath }: KnowledgeGraphProps) {
  const positions = useMemo(
    () => computeGraphLayout(graph, { width: VIEW_WIDTH, height: VIEW_HEIGHT }),
    [graph],
  );
  const adjacency = useMemo(() => computeAdjacency(graph), [graph]);

  // Node colour by id, so an edge can fade from its source's colour to its
  // target's (a softer, more organic look than a flat line).
  const colorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graph.nodes) {
      map.set(node.id, nodeColor(node));
    }
    return map;
  }, [graph]);

  // A quiet key for the colours actually in use. Mirrors `nodeColor`'s
  // precedence: a note with a canonical page type is keyed by that type, else by
  // its first tag — so the legend can never claim a colour the graph isn't using.
  const legend = useMemo(() => {
    const types = new Map<string, string>();
    const tags = new Set<string>();
    let hasUnresolved = false;
    for (const node of graph.nodes) {
      if (node.unresolved) {
        hasUnresolved = true;
        continue;
      }
      const pageType = getPageType(node.type);
      if (pageType) {
        types.set(pageType.type, pageType.color);
      } else if (node.tags[0]) {
        tags.add(node.tags[0]);
      }
    }
    return {
      types: [...types.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 8),
      tags: [...tags].sort().slice(0, 8),
      hasUnresolved,
    };
  }, [graph]);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: ViewTransform;
  } | null>(null);

  // Non-passive wheel listener so zoom can preventDefault the page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((current) => {
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
        return { ...current, scale };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const neighbors = hoveredId ? adjacency.get(hoveredId) : undefined;

  // A node's radius grows with how connected it is, giving hubs visual weight.
  function radiusFor(node: GraphNode): number {
    const base = node.unresolved ? UNRESOLVED_RADIUS : BASE_RADIUS;
    return base + Math.min(adjacency.get(node.id)?.size ?? 0, 10) * 0.85;
  }

  function handleBackgroundPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    // Only start a pan when the background itself was grabbed (not a node).
    if (event.target !== event.currentTarget) {
      return;
    }
    panState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: view,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const pan = panState.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    const unitsPerPxX = rect && rect.width > 0 ? VIEW_WIDTH / rect.width : 1;
    const unitsPerPxY = rect && rect.height > 0 ? VIEW_HEIGHT / rect.height : 1;
    setView({
      scale: pan.origin.scale,
      tx: pan.origin.tx + (event.clientX - pan.startX) * unitsPerPxX,
      ty: pan.origin.ty + (event.clientY - pan.startY) * unitsPerPxY,
    });
  }

  function endPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (panState.current?.pointerId === event.pointerId) {
      panState.current = null;
    }
  }

  function adjustZoom(factor: number) {
    setView((current) => ({
      ...current,
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor)),
    }));
  }

  return (
    <div className="graph-canvas">
      <div className="graph-controls" role="toolbar" aria-label="Graph zoom">
        <button
          type="button"
          className="graph-control-btn"
          onClick={() => adjustZoom(1.2)}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="graph-control-btn"
          onClick={() => adjustZoom(1 / 1.2)}
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="graph-control-btn"
          onClick={() => setView({ scale: 1, tx: 0, ty: 0 })}
          aria-label="Reset view"
        >
          Reset
        </button>
      </div>
      <svg
        ref={svgRef}
        className="graph-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Knowledge graph with ${graph.nodes.length} nodes`}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <defs>
          {graph.edges.map((edge, i) => {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b || edge.type) {
              return null;
            }
            return (
              <linearGradient
                key={i}
                id={`graph-edge-grad-${i}`}
                gradientUnits="userSpaceOnUse"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
              >
                <stop offset="0%" style={{ stopColor: colorById.get(edge.source) }} />
                <stop offset="100%" style={{ stopColor: colorById.get(edge.target) }} />
              </linearGradient>
            );
          })}
        </defs>
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {graph.edges.map((edge, i) => {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b) {
              return null;
            }
            const mod = !hoveredId
              ? ''
              : edge.source === hoveredId || edge.target === hoveredId
                ? ' graph-edge--active'
                : ' graph-edge--dim';
            return (
              <path
                key={`${edge.source}->${edge.target}:${edge.type ?? ''}`}
                className={`graph-edge${edge.type ? ' graph-edge--typed' : ''}${mod}`}
                d={edgePath(a, b)}
                stroke={edge.type ? undefined : `url(#graph-edge-grad-${i})`}
              >
                {edge.type ? <title>{edge.type}</title> : null}
              </path>
            );
          })}

          {graph.nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) {
              return null;
            }
            const radius = radiusFor(node);
            const color = nodeColor(node);
            const active = !!hoveredId && (node.id === hoveredId || !!neighbors?.has(node.id));
            const dim = !!hoveredId && !active;
            const selected = node.id === selectedPath;
            const classes = [
              'graph-node',
              node.unresolved ? 'graph-node--unresolved' : '',
              selected ? 'graph-node--selected' : '',
              active ? 'graph-node--active' : '',
              dim ? 'graph-node--dim' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <g
                key={node.id}
                className={classes}
                style={{
                  transform: `translate(${pos.x}px, ${pos.y}px)`,
                  cursor: node.unresolved ? 'help' : 'pointer',
                }}
                role={node.unresolved ? undefined : 'button'}
                tabIndex={node.unresolved ? undefined : 0}
                aria-label={node.unresolved ? `${node.label} (unresolved link)` : node.label}
                onClick={() => {
                  if (!node.unresolved) {
                    onSelectFile(node.id);
                  }
                }}
                onKeyDown={(event) => {
                  if (!node.unresolved && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onSelectFile(node.id);
                  }
                }}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() =>
                  setHoveredId((current) => (current === node.id ? null : current))
                }
                onFocus={() => setHoveredId(node.id)}
                onBlur={() => setHoveredId((current) => (current === node.id ? null : current))}
              >
                <circle className="graph-node__halo" r={radius * 2.2} style={{ fill: color }} />
                {selected ? <circle className="graph-node__ring" r={radius + 4} /> : null}
                <circle className="graph-node__dot" r={radius} style={{ fill: color }} />
                <text className="graph-node__label" y={radius + 13}>
                  {node.label}
                </text>
                <title>{node.id}</title>
              </g>
            );
          })}
        </g>
      </svg>

      {legend.types.length > 0 || legend.tags.length > 0 || legend.hasUnresolved ? (
        <div className="graph-legend" aria-hidden="true">
          {legend.types.map(([type, color]) => (
            <span key={`type:${type}`} className="graph-legend__item">
              <span className="graph-legend__swatch" style={{ backgroundColor: color, color }} />
              {type}
            </span>
          ))}
          {legend.tags.map((tag) => (
            <span key={tag} className="graph-legend__item">
              <span
                className="graph-legend__swatch"
                style={{ backgroundColor: colorForTag(tag), color: colorForTag(tag) }}
              />
              {tag}
            </span>
          ))}
          {legend.hasUnresolved ? (
            <span className="graph-legend__item">
              <span className="graph-legend__swatch graph-legend__swatch--unresolved" />
              unresolved
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
