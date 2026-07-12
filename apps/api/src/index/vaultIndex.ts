import {
  type RankQueryOptions,
  type RankedChunk,
  type SemanticDocument,
  type SemanticHit,
} from '@repo/shared';

import type { EventBus } from '../events/eventBus.js';
import type { FileRepository, TreeNode } from '../storage/fileRepository.js';
import {
  resolveRetrievalEngine,
  type BuiltRetrievalIndex,
  type RetrievalEngine,
} from './retrievalEngine.js';

/**
 * An in-memory, lazily-built retrieval cache over the vault. It reads every
 * note once, builds a ranking index (chunks + per-chunk vectors) once via the
 * configured retrieval engine, and reuses it across queries — so retrieval no
 * longer re-reads the whole vault per request.
 *
 * The ranking engine is pluggable (`retrievalEngine.ts`): offline **TF-IDF** by
 * default, or opt-in **embeddings** (`FSBRAIN_EMBEDDINGS`) behind a TF-IDF
 * fallback. The cache and its lifecycle are identical either way — the engine
 * only changes how a query is scored, never this cache's contract — so every
 * route that reads through the `VaultIndex` is unaffected by the choice.
 *
 * It stays fresh by subscribing to the live-layer `EventBus`: any
 * create/update/move/delete (from the API or the file watcher) invalidates the
 * affected entry and the derived index, so the next query rebuilds from disk —
 * reusing the cached content of unchanged notes — and never serves stale
 * results after a write. Both full-text (`getDocuments`) and semantic
 * (`semanticSearch` / `rankedChunks`) retrieval read through this cache, so
 * ranking is identical to reading the vault fresh each time.
 *
 * Conventions preserved: `.fsbrain/` and other dotfiles never enter the corpus
 * (they are already excluded from `listTree`).
 */
export interface VaultIndex {
  /** The cached corpus (logical path → content), refreshed lazily before return. */
  getDocuments(): Promise<readonly SemanticDocument[]>;
  /** Semantic hits (display snippets) — backs `GET /api/semantic-search`. */
  semanticSearch(query: string, options?: RankQueryOptions): Promise<SemanticHit[]>;
  /** Ranked chunks carrying full text — used to assemble context bundles. */
  rankedChunks(query: string, options?: RankQueryOptions): Promise<RankedChunk[]>;
  /** Unsubscribe from the event bus (called on server close). */
  close(): void;
}

function flattenMarkdownPaths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.isDirectory) {
      paths.push(...flattenMarkdownPaths(node.children ?? []));
    } else {
      paths.push(node.path);
    }
  }
  return paths;
}

export function createVaultIndex(options: {
  repository: FileRepository;
  eventBus: EventBus;
  /** Vault root, used to persist the embedding index under `.fsbrain/`. */
  contentRoot?: string;
  /** Ranking engine; defaults to the env-selected engine (TF-IDF unless
   * `FSBRAIN_EMBEDDINGS` is on). Injectable for tests. */
  engine?: RetrievalEngine;
}): VaultIndex {
  const { repository, eventBus } = options;
  const engine =
    options.engine ??
    resolveRetrievalEngine({
      contentRoot: options.contentRoot,
      onFallback: (reason, error) => {
        // eslint-disable-next-line no-console
        console.warn(`[vaultIndex] embeddings ${reason} fallback to TF-IDF:`, error);
      },
    });

  // Cached note contents, the ordered corpus, and the derived, queryable index.
  const contentCache = new Map<string, string>();
  let documents: SemanticDocument[] = [];
  let builtIndex: BuiltRetrievalIndex | null = null;

  // A monotonically increasing change counter. Every relevant event bumps it;
  // `indexedSeq` records the value the current `builtIndex` reflects. They
  // diverge exactly when a rebuild is due.
  let mutationSeq = 0;
  let indexedSeq = -1;
  // Paths whose cached content is known-stale and must be re-read on next build.
  const dirtyPaths = new Set<string>();
  // Coalesce concurrent rebuilds into one.
  let rebuilding: Promise<void> | null = null;

  function markChanged(paths: string[]): void {
    mutationSeq += 1;
    for (const path of paths) {
      dirtyPaths.add(path);
    }
    builtIndex = null;
  }

  const unsubscribe = eventBus.subscribe((event) => {
    switch (event.type) {
      case 'created':
      case 'updated':
      case 'deleted':
        markChanged([event.path]);
        break;
      case 'moved':
        markChanged(event.toPath ? [event.path, event.toPath] : [event.path]);
        break;
      // `dir_created` adds no markdown; proposal events are followed by the
      // underlying create/update/delete event, which carries the content change.
      default:
        break;
    }
  });

  async function doRebuild(): Promise<void> {
    // Rebuild until the index reflects the latest `mutationSeq`. If a change
    // lands mid-read (`mutationSeq` advances past `target`), redo the pass so we
    // never commit a corpus that is already stale.
    for (;;) {
      const target = mutationSeq;
      const dirtySnapshot = new Set(dirtyPaths);

      const paths = flattenMarkdownPaths(await repository.listTree(''));
      const nextDocuments: SemanticDocument[] = [];
      for (const path of paths) {
        let content = contentCache.get(path);
        if (content === undefined || dirtySnapshot.has(path)) {
          try {
            content = await repository.readMarkdownFile(path);
          } catch {
            // A file that vanished mid-rebuild (e.g. a race with delete) — skip
            // it; the delete event will have bumped the seq, forcing a redo.
            content = undefined;
          }
          if (content !== undefined) {
            contentCache.set(path, content);
          }
        }
        if (content !== undefined) {
          nextDocuments.push({ path, content });
        }
      }

      if (mutationSeq !== target) {
        // A change arrived during the awaited reads; its dirty paths are still
        // pending. Redo without clearing them.
        continue;
      }

      // Build the queryable index. For the embedding engine this awaits the
      // provider; the chunk-vector cache makes an incremental rebuild cheap.
      const nextIndex = await engine.build(nextDocuments);

      if (mutationSeq !== target) {
        // A change landed during the (possibly network-bound) build; redo rather
        // than commit a corpus that is already stale.
        continue;
      }

      // No change occurred during this pass, so it is safe to commit and to
      // clear the serviced dirty set wholesale.
      dirtyPaths.clear();
      const present = new Set(paths);
      for (const cached of [...contentCache.keys()]) {
        if (!present.has(cached)) {
          contentCache.delete(cached);
        }
      }

      documents = nextDocuments;
      builtIndex = nextIndex;
      indexedSeq = target;
      return;
    }
  }

  async function ensureFresh(): Promise<void> {
    // Loop until we observe an index that reflects the latest mutation. A write
    // publishes synchronously (`markChanged` nulls `builtIndex` and bumps
    // `mutationSeq`) and can land in the microtask gap after `doRebuild` commits
    // but before our `await` resumes; re-checking on each turn closes that race
    // instead of returning a stale/empty result. Concurrent callers coalesce on
    // the in-flight `rebuilding` promise.
    while (!(builtIndex && indexedSeq === mutationSeq)) {
      if (rebuilding) {
        await rebuilding;
        continue;
      }
      rebuilding = doRebuild();
      try {
        await rebuilding;
      } finally {
        rebuilding = null;
      }
    }
  }

  return {
    async getDocuments(): Promise<readonly SemanticDocument[]> {
      await ensureFresh();
      return documents;
    },
    async semanticSearch(
      query: string,
      queryOptions: RankQueryOptions = {},
    ): Promise<SemanticHit[]> {
      await ensureFresh();
      return builtIndex ? builtIndex.querySemantic(query, queryOptions) : [];
    },
    async rankedChunks(query: string, queryOptions: RankQueryOptions = {}): Promise<RankedChunk[]> {
      await ensureFresh();
      return builtIndex ? builtIndex.queryRanked(query, queryOptions) : [];
    },
    close(): void {
      unsubscribe();
    },
  };
}
