import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { FileNode } from '@repo/shared';
import { useVaultEvents } from './hooks/useVaultEvents';
import { ActivityPanel } from './components/ActivityPanel';
import { BacklinksPanel } from './components/BacklinksPanel';
import { FileViewerTabs, type ViewerTabKey } from './components/FileViewerTabs';
import { GlobalLayout } from './components/GlobalLayout';
import { GraphView } from './components/GraphView';
import { MaintenancePanel } from './components/MaintenancePanel';
import { ReviewPanel } from './components/ReviewPanel';
import { SearchDialog } from './components/SearchDialog';
import { ModalDialog } from './components/ModalDialog';

// The markdown renderer (react-markdown + katex + highlight.js) is heavy, so it
// is code-split and loaded on demand when a file preview is first shown.
const MarkdownPreviewPane = lazy(() =>
  import('./components/MarkdownPreviewPane').then((module) => ({
    default: module.MarkdownPreviewPane,
  })),
);
import { RichTextEditorPane } from './components/RichTextEditorPane';
import {
  createDirectory,
  createFile,
  deletePath,
  fetchFile,
  fetchProposals,
  fetchTree,
  getErrorMessage,
  renamePath,
  type RemoteFile,
  updateFile,
} from './api/files';

type AppModalState = {
  title: string;
  description: string;
  variant?: 'info' | 'error' | 'destructive';
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onClose?: () => void;
};

export function App() {
  const [activeTab, setActiveTab] = useState<ViewerTabKey>('preview');
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [savedFiles, setSavedFiles] = useState<Record<string, RemoteFile>>({});
  const [draftContents, setDraftContents] = useState<Record<string, string>>({});
  const [modalState, setModalState] = useState<AppModalState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activityKey, setActivityKey] = useState(0);
  const [pendingProposals, setPendingProposals] = useState(0);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);

  const bumpActivity = () => setActivityKey((value) => value + 1);

  // Keep the Review tab's pending-proposal badge fresh (on load + after any
  // vault change or proposal resolution, which bump `activityKey`).
  useEffect(() => {
    let cancelled = false;
    fetchProposals('pending')
      .then((proposals) => {
        if (!cancelled) {
          setPendingProposals(proposals.length);
        }
      })
      .catch(() => {
        /* badge is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [activityKey]);

  const currentSavedFile = selectedFilePath ? savedFiles[selectedFilePath] : undefined;
  const currentSavedMarkdown = currentSavedFile?.content ?? '';
  const currentDraftMarkdown = selectedFilePath
    ? (draftContents[selectedFilePath] ?? currentSavedMarkdown)
    : '';

  const hasUnsavedChanges = useMemo(
    () =>
      Object.keys(draftContents).some(
        (path) => (draftContents[path] ?? '') !== (savedFiles[path]?.content ?? ''),
      ),
    [draftContents, savedFiles],
  );

  const isCurrentFileDirty = selectedFilePath
    ? currentDraftMarkdown !== currentSavedMarkdown
    : false;

  const allPaths = useMemo(() => {
    const paths: string[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const node of nodes) {
        if (node.isDirectory) {
          walk(node.children ?? []);
        } else {
          paths.push(node.path);
        }
      }
    };
    walk(tree);
    return paths;
  }, [tree]);

  function showInfoModal(title: string, description: string, variant: 'info' | 'error' = 'error') {
    setModalState({
      title,
      description,
      variant,
      confirmLabel: 'Close',
    });
  }

  function showConfirmModal(config: {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    variant?: 'info' | 'error' | 'destructive';
  }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setModalState({
        ...config,
        onConfirm: () => {
          confirmResolverRef.current?.(true);
          confirmResolverRef.current = null;
          setModalState(null);
        },
        onClose: () => {
          confirmResolverRef.current?.(false);
          confirmResolverRef.current = null;
          setModalState(null);
        },
      });
    });
  }

  async function refreshTree() {
    const nextTree = await fetchTree();
    setTree(nextTree);
  }

  async function refreshCurrentFile(path = selectedFilePath) {
    if (!path) {
      return;
    }

    const latest = await fetchFile(path);
    setSavedFiles((current) => ({ ...current, [path]: latest }));
    setDraftContents((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  async function refreshTreeAndCurrentFile(path = selectedFilePath) {
    await refreshTree();
    await refreshCurrentFile(path);
  }

  useEffect(() => {
    void (async () => {
      try {
        await refreshTree();
      } catch (error: unknown) {
        showInfoModal('Could not load files', getErrorMessage(error), 'error');
      } finally {
        setTreeLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
        return;
      }

      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        triggerSave();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function handleSelectFile(nextPath: string) {
    if (selectedFilePath && isCurrentFileDirty && selectedFilePath !== nextPath) {
      const shouldDiscard = await showConfirmModal({
        title: 'Discard unsaved changes?',
        description: 'You have unsaved changes. Switch files and discard current edits?',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        variant: 'info',
      });
      if (!shouldDiscard) {
        return;
      }

      setDraftContents((current) => {
        const next = { ...current };
        delete next[selectedFilePath];
        return next;
      });
    }

    const previousPath = selectedFilePath;
    setSelectedFilePath(nextPath);

    try {
      const file = await fetchFile(nextPath);
      setSavedFiles((current) => ({ ...current, [nextPath]: file }));
    } catch (error: unknown) {
      setSelectedFilePath(previousPath);
      throw new Error(getErrorMessage(error));
    }
  }

  async function navigateToFile(nextPath: string) {
    try {
      await handleSelectFile(nextPath);
    } catch (error: unknown) {
      showInfoModal('Could not open file', getErrorMessage(error), 'error');
    }
  }

  async function saveCurrentFile() {
    if (!selectedFilePath || !isCurrentFileDirty) {
      return;
    }

    const current = savedFiles[selectedFilePath];
    const updated = await updateFile({
      path: selectedFilePath,
      content: currentDraftMarkdown,
      etag: current?.etag,
      lastModified: current?.lastModified,
    });

    setSavedFiles((files) => ({ ...files, [selectedFilePath]: updated }));
    setDraftContents((currentDrafts) => {
      const next = { ...currentDrafts };
      delete next[selectedFilePath];
      return next;
    });

    await refreshTreeAndCurrentFile(selectedFilePath);
    bumpActivity();
  }

  // Entry points that trigger a save without awaiting its result (keyboard
  // shortcut, editor pane) still need to surface a failure — otherwise the
  // user gets no feedback and may believe the save succeeded.
  function triggerSave() {
    void saveCurrentFile().catch((error: unknown) => {
      showInfoModal('Could not save file', getErrorMessage(error), 'error');
    });
  }

  // React to an out-of-band change to the *currently open* file. Never clobber
  // an unsaved draft: if there is one and the file genuinely diverged on disk,
  // offer a non-destructive reload instead of overwriting the editor.
  async function handleOpenFileChangedOnDisk(path: string) {
    if (path !== selectedFilePath) {
      return;
    }

    const base = savedFiles[path]?.content ?? '';
    const isDirty = (draftContents[path] ?? base) !== base;

    if (!isDirty) {
      try {
        await refreshCurrentFile(path);
      } catch {
        // The file may have just been removed; the tree refresh will reflect it.
      }
      return;
    }

    let latest: RemoteFile;
    try {
      latest = await fetchFile(path);
    } catch {
      return; // can't compare — leave the draft untouched
    }
    if (latest.content === base) {
      return; // no real divergence (e.g. our own write echoed back over SSE)
    }

    const reload = await showConfirmModal({
      title: 'File changed on disk',
      description: `"${path}" was changed outside this editor. Reload and discard your unsaved edits?`,
      confirmLabel: 'Reload',
      cancelLabel: 'Keep my edits',
      variant: 'info',
    });

    // Adopt the new base either way so a later save uses the fresh etag; only
    // drop the draft when the human chose to reload.
    setSavedFiles((current) => ({ ...current, [path]: latest }));
    if (reload) {
      setDraftContents((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
    }
  }

  // Live layer: subscribe to /api/events and refresh surgically as the vault
  // changes (agent/MCP writes, another client, direct file edits). The manual
  // refreshes after the human's own actions stay for instant local feedback;
  // this adds the "someone else changed it" path.
  const { status: liveStatus } = useVaultEvents({
    openFilePath: selectedFilePath,
    onTreeChanged: () => {
      void refreshTree().catch(() => {
        /* best-effort live refresh */
      });
    },
    onOpenFileChanged: (path) => {
      void handleOpenFileChangedOnDisk(path);
    },
    onActivity: bumpActivity,
    onPendingChanged: bumpActivity,
  });

  return (
    <>
      <GlobalLayout
        liveStatus={liveStatus}
        tree={tree}
        treeLoading={treeLoading}
        selectedFilePath={selectedFilePath ?? undefined}
        isDirty={hasUnsavedChanges}
        onSelectFile={handleSelectFile}
        onSave={saveCurrentFile}
        onCreateFile={async (path) => {
          setSelectedFilePath(path);

          try {
            await createFile(path, '');
            await refreshTreeAndCurrentFile(path);
            bumpActivity();
          } catch (error: unknown) {
            setSelectedFilePath((current) => (current === path ? null : current));
            throw new Error(getErrorMessage(error));
          }
        }}
        onCreateFolder={async (path) => {
          await createDirectory(path);
          await refreshTree();
          bumpActivity();
        }}
        onRenamePath={async (fromPath, toPath) => {
          const previousSelected = selectedFilePath;
          const remappedPath =
            previousSelected === fromPath
              ? toPath
              : previousSelected?.startsWith(`${fromPath}/`)
                ? `${toPath}/${previousSelected.slice(fromPath.length + 1)}`
                : previousSelected;

          try {
            await renamePath(fromPath, toPath);
            await refreshTree();
            bumpActivity();
            setSelectedFilePath(remappedPath ?? null);

            if (!remappedPath) {
              return;
            }

            try {
              await refreshCurrentFile(remappedPath);
            } catch (error: unknown) {
              const message = getErrorMessage(error);
              if (/not found|does not exist/i.test(message)) {
                showInfoModal(
                  'Rename completed with warning',
                  `Moved successfully, but could not refresh "${remappedPath}": ${message}`,
                  'info',
                );
                return;
              }

              throw error;
            }
          } catch (error: unknown) {
            setSelectedFilePath(previousSelected);
            throw new Error(getErrorMessage(error));
          }
        }}
        onDeletePath={async (path, recursive = false) => {
          const previousSelected = selectedFilePath;

          if (previousSelected === path) {
            setSelectedFilePath(null);
          }

          try {
            await deletePath(path, recursive);
            await refreshTree();
            bumpActivity();

            if (previousSelected === path) {
              setDraftContents((current) => {
                const next = { ...current };
                delete next[path];
                return next;
              });
              setSavedFiles((current) => {
                const next = { ...current };
                delete next[path];
                return next;
              });
            }
          } catch (error: unknown) {
            setSelectedFilePath(previousSelected);
            throw new Error(getErrorMessage(error));
          }
        }}
      >
        <FileViewerTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          preview={
            <>
              <Suspense fallback={<p className="empty-state">Loading preview…</p>}>
                <MarkdownPreviewPane
                  filePath={selectedFilePath}
                  markdown={currentDraftMarkdown}
                  allPaths={allPaths}
                  onNavigate={(path) => {
                    void navigateToFile(path);
                  }}
                />
              </Suspense>
              <BacklinksPanel
                filePath={selectedFilePath}
                refreshKey={allPaths.length}
                onSelectFile={(path) => {
                  void navigateToFile(path);
                }}
              />
            </>
          }
          edit={
            <RichTextEditorPane
              filePath={selectedFilePath}
              markdown={currentDraftMarkdown}
              savedMarkdown={currentSavedMarkdown}
              isDirty={isCurrentFileDirty}
              onSave={triggerSave}
              onChangeMarkdown={(nextValue: string) => {
                if (!selectedFilePath) {
                  return;
                }

                setDraftContents((current) => ({
                  ...current,
                  [selectedFilePath]: nextValue,
                }));
              }}
            />
          }
          activity={
            <ActivityPanel
              refreshKey={activityKey}
              onSelectFile={(path) => {
                void navigateToFile(path);
              }}
            />
          }
          review={
            <>
              <MaintenancePanel onFiled={bumpActivity} />
              <ReviewPanel
                refreshKey={activityKey}
                onResolved={() => {
                  void refreshTreeAndCurrentFile();
                  bumpActivity();
                }}
                onSelectFile={(path) => {
                  void navigateToFile(path);
                }}
              />
            </>
          }
          graph={
            <GraphView
              refreshKey={activityKey}
              selectedPath={selectedFilePath}
              onSelectFile={(path) => {
                setActiveTab('preview');
                void navigateToFile(path);
              }}
            />
          }
          reviewCount={pendingProposals}
        />
      </GlobalLayout>

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelectFile={(path) => {
          void navigateToFile(path);
        }}
      />

      <ModalDialog
        open={Boolean(modalState)}
        title={modalState?.title ?? ''}
        description={modalState?.description ?? ''}
        variant={modalState?.variant ?? 'info'}
        confirmLabel={modalState?.confirmLabel}
        cancelLabel={modalState?.cancelLabel}
        onConfirm={modalState?.onConfirm}
        onClose={
          modalState?.onClose
            ? modalState.onClose
            : () => {
                setModalState(null);
              }
        }
      />
    </>
  );
}
