import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalLayout } from '../GlobalLayout';
import * as integrationsApi from '../../api/integrations';

vi.mock('../../api/integrations', () => ({
  getRocketReachStatus: vi.fn(),
  updateRocketReach: vi.fn(),
  testRocketReach: vi.fn(),
}));

describe('GlobalLayout', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(integrationsApi.getRocketReachStatus).mockResolvedValue({
      enabled: false,
      configured: false,
      state: 'disabled',
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  const tree = [
    {
      name: 'docs',
      path: 'docs',
      isDirectory: true,
      children: [
        {
          name: 'nested',
          path: 'docs/nested',
          isDirectory: true,
          children: [{ name: 'intro.md', path: 'docs/nested/intro.md', isDirectory: false }],
        },
      ],
    },
  ];

  function renderLayout() {
    const onRenamePath = vi.fn(async () => {});
    const view = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlobalLayout
          tree={tree}
          onSelectFile={vi.fn()}
          onCreateFile={vi.fn(async () => {})}
          onCreateFolder={vi.fn(async () => {})}
          onRenamePath={onRenamePath}
          onDeletePath={vi.fn(async () => {})}
          onSave={vi.fn(async () => {})}
        >
          <div>Editor Panel</div>
        </GlobalLayout>
      </MemoryRouter>,
    );

    return { ...view, onRenamePath };
  }

  // -------------------------------------------------------------------------
  // Drag-and-drop (existing tests)
  // -------------------------------------------------------------------------

  it('makes tree rows draggable and shows visual drag-grip indicators', () => {
    renderLayout();

    const folderRow = screen.getByRole('treeitem', { name: 'docs' });
    expect(folderRow).toHaveAttribute('draggable', 'true');
    expect(folderRow).toHaveAttribute('data-kind', 'directory');

    const fileRow = screen.getByRole('treeitem', { name: 'intro.md' });
    expect(fileRow).toHaveAttribute('draggable', 'true');
    expect(fileRow).toHaveAttribute('data-kind', 'file');
    expect(fileRow).toHaveAttribute('data-path', 'docs/nested/intro.md');

    expect(screen.getByTitle('Drag docs')).toBeInTheDocument();
    expect(screen.getByTitle('Drag intro.md')).toBeInTheDocument();
  });

  it('shows an error toast when drop source path is missing', () => {
    renderLayout();

    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    fireEvent.drop(docsRow, {
      dataTransfer: {
        getData: () => '',
      },
    });

    expect(screen.getByText('Could not determine dragged item. Try again.')).toBeInTheDocument();
  });

  it('treats dropping a file onto itself as a no-op with an info toast', () => {
    const { onRenamePath } = renderLayout();

    const introRow = screen.getByRole('treeitem', { name: 'intro.md' });
    fireEvent.drop(introRow, {
      dataTransfer: {
        getData: () => 'docs/nested/intro.md',
      },
    });

    // The file row resolves to its parent folder (docs/nested), which is
    // already the source's parent — so the move is a no-op.
    expect(screen.getByText('Item is already in that folder.')).toBeInTheDocument();
    expect(onRenamePath).not.toHaveBeenCalled();
  });

  it('calls onRenamePath when dropping on a folder row', async () => {
    const { onRenamePath } = renderLayout();

    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    fireEvent.drop(docsRow, {
      dataTransfer: {
        getData: () => 'docs/nested/intro.md',
      },
    });

    await waitFor(() =>
      expect(onRenamePath).toHaveBeenCalledWith('docs/nested/intro.md', 'docs/intro.md'),
    );
  });

  it('shows an error toast when moving a folder into itself', () => {
    renderLayout();

    const nestedRow = screen.getByRole('treeitem', { name: 'nested' });
    fireEvent.drop(nestedRow, {
      dataTransfer: {
        getData: () => 'docs',
      },
    });

    expect(screen.getAllByText('Cannot move a folder into itself.').length).toBeGreaterThan(0);
    expect(screen.getByRole('treeitem', { name: 'docs' })).toBeInTheDocument();
  });

  it('shows an info toast and does not rename when dropping onto same parent folder', async () => {
    const { onRenamePath } = renderLayout();

    // intro.md is already inside docs/nested; dropping it onto docs/nested is a no-op
    const nestedRow = screen.getByRole('treeitem', { name: 'nested' });
    fireEvent.drop(nestedRow, {
      dataTransfer: {
        getData: () => 'docs/nested/intro.md',
      },
    });

    expect(screen.getByText('Item is already in that folder.')).toBeInTheDocument();
    expect(onRenamePath).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Full-sequence DnD (dragstart -> dragenter -> dragover -> drop -> dragend)
  //
  // The legacy tests above only fire `drop` directly. That can mask
  // regressions in dragstart wiring (data transfer, draggable attribute) or
  // in dragover's `preventDefault` gating — which is what enables the drop
  // to fire at all in real browsers. The tests below simulate the full
  // sequence and share a single DataTransfer across events, mirroring what
  // a real browser does.
  // -------------------------------------------------------------------------

  class DataTransferStub {
    private store = new Map<string, string>();
    public effectAllowed = '';
    public dropEffect = '';
    public files: File[] = [];
    public types: string[] = [];
    setData(type: string, val: string) {
      this.store.set(type, val);
      if (!this.types.includes(type)) this.types.push(type);
    }
    getData(type: string) {
      return this.store.get(type) ?? '';
    }
    clearData() {
      this.store.clear();
      this.types = [];
    }
    setDragImage() {
      /* noop */
    }
  }

  const richTree = [
    {
      name: 'a.md',
      path: 'a.md',
      isDirectory: false,
    },
    {
      name: 'docs',
      path: 'docs',
      isDirectory: true,
      children: [
        { name: 'guide.md', path: 'docs/guide.md', isDirectory: false },
        {
          name: 'nested',
          path: 'docs/nested',
          isDirectory: true,
          children: [{ name: 'intro.md', path: 'docs/nested/intro.md', isDirectory: false }],
        },
      ],
    },
  ];

  function renderRichLayout() {
    const onRenamePath = vi.fn(async () => {});
    const view = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlobalLayout
          tree={richTree}
          onSelectFile={vi.fn()}
          onCreateFile={vi.fn(async () => {})}
          onCreateFolder={vi.fn(async () => {})}
          onRenamePath={onRenamePath}
          onDeletePath={vi.fn(async () => {})}
          onSave={vi.fn(async () => {})}
        >
          <div />
        </GlobalLayout>
      </MemoryRouter>,
    );
    return { ...view, onRenamePath };
  }

  it('full sequence: dragstart -> dragenter -> dragover -> drop on folder row moves file', async () => {
    const { onRenamePath } = renderRichLayout();
    const introRow = screen.getByRole('treeitem', { name: 'intro.md' });
    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    const dt = new DataTransferStub();

    fireEvent.dragStart(introRow, { dataTransfer: dt });
    expect(dt.getData('text/plain')).toBe('docs/nested/intro.md');
    expect(dt.effectAllowed).toBe('move');

    fireEvent.dragEnter(docsRow, { dataTransfer: dt });
    fireEvent.dragOver(docsRow, { dataTransfer: dt });

    fireEvent.drop(docsRow, { dataTransfer: dt });
    fireEvent.dragEnd(introRow, { dataTransfer: dt });

    await waitFor(() =>
      expect(onRenamePath).toHaveBeenCalledWith('docs/nested/intro.md', 'docs/intro.md'),
    );
  });

  it('full sequence: dropping a file on a sibling-file row moves into the shared parent', async () => {
    // a.md is at the root. guide.md lives in docs/.
    // Dragging a.md onto guide.md should move a.md into docs/, because
    // the file row resolves to its parent folder. This is the user-friendly
    // behavior that the prior code was rejecting with "Drop onto a folder.".
    const { onRenamePath } = renderRichLayout();
    const sourceRow = screen.getByRole('treeitem', { name: 'a.md' });
    const targetRow = screen.getByRole('treeitem', { name: 'guide.md' });
    const dt = new DataTransferStub();

    fireEvent.dragStart(sourceRow, { dataTransfer: dt });
    fireEvent.dragEnter(targetRow, { dataTransfer: dt });
    fireEvent.dragOver(targetRow, { dataTransfer: dt });
    fireEvent.drop(targetRow, { dataTransfer: dt });
    fireEvent.dragEnd(sourceRow, { dataTransfer: dt });

    await waitFor(() => expect(onRenamePath).toHaveBeenCalledWith('a.md', 'docs/a.md'));
  });

  it('dragover on a folder row calls preventDefault so the drop event can fire', () => {
    // This is the gate that makes drops actually happen in real browsers.
    // If preventDefault is not called on dragover, the browser shows a
    // "no-drop" cursor and never delivers the drop event.
    const { onRenamePath } = renderRichLayout();
    const introRow = screen.getByRole('treeitem', { name: 'intro.md' });
    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    const dt = new DataTransferStub();

    fireEvent.dragStart(introRow, { dataTransfer: dt });

    const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, 'dataTransfer', { value: dt });
    docsRow.dispatchEvent(dragOverEvent);
    expect(dragOverEvent.defaultPrevented).toBe(true);

    expect(onRenamePath).not.toHaveBeenCalled();
  });

  it('dragover on the source row does NOT preventDefault (cannot drop on self)', () => {
    const { onRenamePath } = renderRichLayout();
    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    const dt = new DataTransferStub();

    fireEvent.dragStart(docsRow, { dataTransfer: dt });

    const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, 'dataTransfer', { value: dt });
    docsRow.dispatchEvent(dragOverEvent);
    expect(dragOverEvent.defaultPrevented).toBe(false);

    expect(onRenamePath).not.toHaveBeenCalled();
  });

  it('drop falls back to dataTransfer when ref was cleared (e.g. after re-render)', async () => {
    const { onRenamePath } = renderRichLayout();
    const introRow = screen.getByRole('treeitem', { name: 'intro.md' });
    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    const dt = new DataTransferStub();
    dt.setData('text/plain', 'docs/nested/intro.md');

    // No dragStart -> internal ref is null. The drop must still resolve
    // the source path from the dataTransfer payload.
    fireEvent.dragOver(docsRow, { dataTransfer: dt });
    fireEvent.drop(docsRow, { dataTransfer: dt });
    fireEvent.dragEnd(introRow, { dataTransfer: dt });

    await waitFor(() =>
      expect(onRenamePath).toHaveBeenCalledWith('docs/nested/intro.md', 'docs/intro.md'),
    );
  });

  it('full sequence: drop on the explicit "move to root" zone moves nested file to root', async () => {
    const { onRenamePath } = renderRichLayout();
    const introRow = screen.getByRole('treeitem', { name: 'intro.md' });
    const dt = new DataTransferStub();

    fireEvent.dragStart(introRow, { dataTransfer: dt });
    // Root drop appears only after dragstart triggers a re-render.
    const rootDrop = await screen.findByLabelText('Move to repository root');

    fireEvent.dragOver(rootDrop, { dataTransfer: dt });
    fireEvent.drop(rootDrop, { dataTransfer: dt });
    fireEvent.dragEnd(introRow, { dataTransfer: dt });

    await waitFor(() =>
      expect(onRenamePath).toHaveBeenCalledWith('docs/nested/intro.md', 'intro.md'),
    );
  });

  it('drop on the tree gap (between rows) is a safety net that lands the move at the root', async () => {
    const { onRenamePath } = renderRichLayout();
    const introRow = screen.getByRole('treeitem', { name: 'intro.md' });
    const treeList = screen.getByRole('tree', { name: 'Repository file tree' });
    const dt = new DataTransferStub();

    fireEvent.dragStart(introRow, { dataTransfer: dt });
    fireEvent.dragOver(treeList, { dataTransfer: dt });
    fireEvent.drop(treeList, { dataTransfer: dt });
    fireEvent.dragEnd(introRow, { dataTransfer: dt });

    await waitFor(() =>
      expect(onRenamePath).toHaveBeenCalledWith('docs/nested/intro.md', 'intro.md'),
    );
  });

  it('surfaces a toast (not a silent no-op) when the dragged path cannot be resolved', () => {
    const { onRenamePath } = renderRichLayout();
    const docsRow = screen.getByRole('treeitem', { name: 'docs' });

    fireEvent.drop(docsRow, {
      dataTransfer: { getData: () => 'does/not/exist.md' },
    });

    expect(screen.getByText(/could not find/i)).toBeInTheDocument();
    expect(onRenamePath).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Sidebar collapse / expand
  // -------------------------------------------------------------------------

  it('renders a collapse button and hides sidebar content on click', () => {
    renderLayout();

    const collapseBtn = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapseBtn).toBeInTheDocument();

    // Tree is visible before collapse
    expect(screen.getByRole('tree')).toBeInTheDocument();

    fireEvent.click(collapseBtn);

    // Sidebar content is gone; only the expand button remains
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Filter files')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('restores expanded sidebar on second click', () => {
    renderLayout();

    const collapseBtn = screen.getByRole('button', { name: 'Collapse sidebar' });
    fireEvent.click(collapseBtn);
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();

    const expandBtn = screen.getByRole('button', { name: 'Expand sidebar' });
    fireEvent.click(expandBtn);

    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });

  it('persists collapsed state in localStorage', () => {
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem('sidebarCollapsed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(localStorage.getItem('sidebarCollapsed')).toBe('false');
  });

  it('initialises as collapsed when localStorage says so', () => {
    localStorage.setItem('sidebarCollapsed', 'true');
    renderLayout();

    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Folder expand / collapse
  // -------------------------------------------------------------------------

  it('collapses a folder and hides its children when clicked', () => {
    renderLayout();

    // All children visible initially
    expect(screen.getByRole('treeitem', { name: 'nested' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'intro.md' })).toBeInTheDocument();

    // Click docs to collapse it
    fireEvent.click(screen.getByRole('treeitem', { name: 'docs' }));

    expect(screen.queryByRole('treeitem', { name: 'nested' })).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'intro.md' })).not.toBeInTheDocument();
  });

  it('expands a collapsed folder and shows children on second click', () => {
    renderLayout();

    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    fireEvent.click(docsRow); // collapse
    expect(screen.queryByRole('treeitem', { name: 'intro.md' })).not.toBeInTheDocument();

    fireEvent.click(docsRow); // expand
    expect(screen.getByRole('treeitem', { name: 'intro.md' })).toBeInTheDocument();
  });

  it('sets aria-expanded false on collapsed folder and true when expanded', () => {
    renderLayout();

    const docsRow = screen.getByRole('treeitem', { name: 'docs' });
    // Initially expanded
    expect(docsRow).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(docsRow);
    expect(docsRow).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(docsRow);
    expect(docsRow).toHaveAttribute('aria-expanded', 'true');
  });

  it('persists collapsed folders in localStorage', () => {
    renderLayout();

    fireEvent.click(screen.getByRole('treeitem', { name: 'docs' }));

    const stored = JSON.parse(localStorage.getItem('collapsedFolders') ?? '[]') as string[];
    expect(stored).toContain('docs');
  });

  // -------------------------------------------------------------------------
  // Tree organization: sort + default-collapse-deep
  // -------------------------------------------------------------------------

  it('sorts each level: folders before files, then alphabetical', () => {
    const mixed = [
      { name: 'zeta.md', path: 'zeta.md', isDirectory: false },
      {
        name: 'docs',
        path: 'docs',
        isDirectory: true,
        children: [
          { name: 'guide.md', path: 'docs/guide.md', isDirectory: false },
          { name: 'archive', path: 'docs/archive', isDirectory: true, children: [] },
        ],
      },
      { name: 'README.md', path: 'README.md', isDirectory: false },
      { name: 'apps', path: 'apps', isDirectory: true, children: [] },
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlobalLayout
          tree={mixed}
          onSelectFile={vi.fn()}
          onCreateFile={vi.fn(async () => {})}
          onCreateFolder={vi.fn(async () => {})}
          onRenamePath={vi.fn(async () => {})}
          onDeletePath={vi.fn(async () => {})}
          onSave={vi.fn(async () => {})}
        >
          <div />
        </GlobalLayout>
      </MemoryRouter>,
    );

    const rows = screen.getAllByRole('treeitem').map((row) => row.getAttribute('data-path'));
    // Top level: folders (apps, docs) before files (README.md, zeta.md), all alphabetical.
    // Inside docs: archive (folder) before guide.md (file).
    expect(rows).toEqual(['apps', 'docs', 'docs/archive', 'docs/guide.md', 'README.md', 'zeta.md']);
  });

  it('collapses folders past depth 2 on first ever load (no saved preference)', () => {
    const deep = [
      {
        name: 'docs',
        path: 'docs',
        isDirectory: true,
        children: [
          {
            name: 'guide',
            path: 'docs/guide',
            isDirectory: true,
            children: [
              {
                name: 'intro',
                path: 'docs/guide/intro',
                isDirectory: true,
                children: [{ name: 'a.md', path: 'docs/guide/intro/a.md', isDirectory: false }],
              },
            ],
          },
        ],
      },
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlobalLayout
          tree={deep}
          onSelectFile={vi.fn()}
          onCreateFile={vi.fn(async () => {})}
          onCreateFolder={vi.fn(async () => {})}
          onRenamePath={vi.fn(async () => {})}
          onDeletePath={vi.fn(async () => {})}
          onSave={vi.fn(async () => {})}
        >
          <div />
        </GlobalLayout>
      </MemoryRouter>,
    );

    // docs (depth 1) and guide (depth 2) are visible. intro (depth 3) is
    // visible because guide is expanded — but intro is itself collapsed,
    // so a.md (depth 4) is hidden.
    expect(screen.getByRole('treeitem', { name: 'docs' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'guide' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'intro' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'a.md' })).not.toBeInTheDocument();

    // Default-collapse choice was persisted, so future renders are stable.
    const stored = JSON.parse(localStorage.getItem('collapsedFolders') ?? '[]') as string[];
    expect(stored).toContain('docs/guide/intro');
  });

  // -------------------------------------------------------------------------
  // Settings entry point
  //
  // This is the only human path into the integrations config — the MCP-side
  // RocketReach tools cannot be reached any other way (no env var, no CLI). It
  // previously shipped as an unlabeled 16px glyph with no test behind it, so
  // these assertions pin down both that it is *findable* and that it works.
  // -------------------------------------------------------------------------

  it('renders a settings control with a visible text label, not a bare glyph', () => {
    renderLayout();

    const settingsBtn = screen.getByRole('button', { name: 'Settings' });
    expect(settingsBtn).toBeInTheDocument();
    // The label must be real text in the DOM, not a hover-only title attribute.
    expect(settingsBtn).toHaveTextContent('Settings');
    expect(settingsBtn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(settingsBtn).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the settings dialog on the Integrations section when activated', async () => {
    renderLayout();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Integrations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'RocketReach' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    await waitFor(() => expect(integrationsApi.getRocketReachStatus).toHaveBeenCalled());
  });

  it('closes the settings dialog again', async () => {
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('dialog', { name: 'Settings' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('respects saved collapsedFolders preference and does not auto-collapse', () => {
    // User had previously chosen to collapse nothing — that choice wins
    // over the default-collapse heuristic, even for deep trees.
    localStorage.setItem('collapsedFolders', JSON.stringify([]));

    const deep = [
      {
        name: 'docs',
        path: 'docs',
        isDirectory: true,
        children: [
          {
            name: 'guide',
            path: 'docs/guide',
            isDirectory: true,
            children: [
              {
                name: 'intro',
                path: 'docs/guide/intro',
                isDirectory: true,
                children: [{ name: 'a.md', path: 'docs/guide/intro/a.md', isDirectory: false }],
              },
            ],
          },
        ],
      },
    ];

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlobalLayout
          tree={deep}
          onSelectFile={vi.fn()}
          onCreateFile={vi.fn(async () => {})}
          onCreateFolder={vi.fn(async () => {})}
          onRenamePath={vi.fn(async () => {})}
          onDeletePath={vi.fn(async () => {})}
          onSave={vi.fn(async () => {})}
        >
          <div />
        </GlobalLayout>
      </MemoryRouter>,
    );

    expect(screen.getByRole('treeitem', { name: 'a.md' })).toBeInTheDocument();
  });
});
