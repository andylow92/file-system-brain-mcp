import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { VaultEvent } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import * as filesApi from '../api/files';
import type { RemoteFile } from '../api/files';

vi.mock('../api/files', async () => {
  const actual = await vi.importActual<typeof import('../api/files')>('../api/files');

  return {
    ...actual,
    fetchTree: vi.fn(),
    fetchFile: vi.fn(),
    renamePath: vi.fn(),
    updateFile: vi.fn(),
  };
});

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('loads the tree, then renders it and fetches file content when a file is selected', async () => {
    vi.mocked(filesApi.fetchTree).mockResolvedValue([
      {
        name: 'README.md',
        path: 'README.md',
        isDirectory: false,
      },
    ]);

    vi.mocked(filesApi.fetchFile).mockResolvedValue({
      path: 'README.md',
      content: '# Loaded from API',
      encoding: 'utf-8',
      lastModified: '2026-04-21T00:00:00.000Z',
      etag: 'readme-v1',
      format: 'markdown',
      mimeType: 'text/markdown',
    });

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading files...')).toBeInTheDocument();

    expect(await screen.findByRole('tree', { name: 'Repository file tree' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /README.md/ })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText('Loading files...')).not.toBeInTheDocument();
      expect(filesApi.fetchTree).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('treeitem', { name: /README.md/ }));

    await waitFor(() => {
      expect(filesApi.fetchFile).toHaveBeenCalledWith('README.md');
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Loaded from API' }),
    ).toBeInTheDocument();
  });

  it('renames a directory and remaps the selected nested file before refreshing file content', async () => {
    vi.mocked(filesApi.fetchTree)
      .mockResolvedValueOnce([
        {
          name: 'docs',
          path: 'docs',
          isDirectory: true,
          children: [
            {
              name: 'note.md',
              path: 'docs/note.md',
              isDirectory: false,
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          name: 'renamed',
          path: 'renamed',
          isDirectory: true,
          children: [
            {
              name: 'note.md',
              path: 'renamed/note.md',
              isDirectory: false,
            },
          ],
        },
      ]);

    vi.mocked(filesApi.fetchFile).mockImplementation(async (path: string) => {
      if (path === 'docs/note.md') {
        return {
          path,
          content: '# Original',
          encoding: 'utf-8',
          lastModified: '2026-04-21T00:00:00.000Z',
          etag: 'note-v1',
          format: 'markdown',
          mimeType: 'text/markdown',
        };
      }

      if (path === 'renamed/note.md') {
        return {
          path,
          content: '# Renamed',
          encoding: 'utf-8',
          lastModified: '2026-04-22T00:00:00.000Z',
          etag: 'note-v2',
          format: 'markdown',
          mimeType: 'text/markdown',
        };
      }

      throw new Error(`Path does not exist: ${path}`);
    });

    vi.mocked(filesApi.renamePath).mockResolvedValue({
      fromPath: 'docs',
      toPath: 'renamed',
    });

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('treeitem', { name: /note.md/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('treeitem', { name: /note.md/ }));
    await waitFor(() => {
      expect(filesApi.fetchFile).toHaveBeenCalledWith('docs/note.md');
    });

    fireEvent.click(screen.getByRole('treeitem', { name: /docs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(filesApi.renamePath).toHaveBeenCalledWith('docs', 'renamed');
      expect(filesApi.fetchFile).toHaveBeenCalledWith('renamed/note.md');
    });

    expect(vi.mocked(filesApi.fetchFile).mock.calls.at(-1)?.[0]).toBe('renamed/note.md');
  });

  it('keeps rename success when refreshing remapped file returns not found', async () => {
    vi.mocked(filesApi.fetchTree)
      .mockResolvedValueOnce([
        {
          name: 'docs',
          path: 'docs',
          isDirectory: true,
          children: [{ name: 'note.md', path: 'docs/note.md', isDirectory: false }],
        },
      ])
      .mockResolvedValueOnce([
        {
          name: 'renamed',
          path: 'renamed',
          isDirectory: true,
          children: [{ name: 'note.md', path: 'renamed/note.md', isDirectory: false }],
        },
      ]);

    vi.mocked(filesApi.fetchFile).mockImplementation(async (path: string) => {
      if (path === 'docs/note.md') {
        return {
          path,
          content: '# Original',
          encoding: 'utf-8',
          lastModified: '2026-04-21T00:00:00.000Z',
          etag: 'note-v1',
          format: 'markdown',
          mimeType: 'text/markdown',
        };
      }

      throw new Error('Path does not exist.');
    });

    vi.mocked(filesApi.renamePath).mockResolvedValue({
      fromPath: 'docs',
      toPath: 'renamed',
    });

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('treeitem', { name: /note.md/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('treeitem', { name: /note.md/ }));
    await waitFor(() => expect(filesApi.fetchFile).toHaveBeenCalledWith('docs/note.md'));

    fireEvent.click(screen.getByRole('treeitem', { name: /docs/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('New name'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Renamed to renamed.')).toBeInTheDocument();
    expect(await screen.findByRole('treeitem', { name: /renamed/ })).toBeInTheDocument();
    expect(
      await screen.findByRole('dialog', { name: 'Rename completed with warning' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Moved successfully, but could not refresh "renamed\/note.md"/),
    ).toBeInTheDocument();
  });

  it('surfaces an error dialog when the Cmd/Ctrl+S shortcut fails to save', async () => {
    vi.mocked(filesApi.fetchTree).mockResolvedValue([
      { name: 'README.md', path: 'README.md', isDirectory: false },
    ]);

    vi.mocked(filesApi.fetchFile).mockResolvedValue({
      path: 'README.md',
      content: '# Original',
      encoding: 'utf-8',
      lastModified: '2026-04-21T00:00:00.000Z',
      etag: 'readme-v1',
      format: 'markdown',
      mimeType: 'text/markdown',
    });

    vi.mocked(filesApi.updateFile).mockRejectedValue(new Error('Network error'));

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('treeitem', { name: /README.md/ }));
    await waitFor(() => expect(filesApi.fetchFile).toHaveBeenCalledWith('README.md'));

    fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Markdown source' }), {
      target: { value: '# Original\nedited' },
    });

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    expect(filesApi.updateFile).toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Could not save file' })).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  describe('html documents', () => {
    const REPORT_V1 =
      '<!DOCTYPE html><html><head><style>h1 { color: teal; }</style></head>' +
      '<body><h1>Quarterly report</h1><script>alert(1)</script></body></html>';

    function remote(path: string, content: string, format: 'markdown' | 'html'): RemoteFile {
      return {
        path,
        content,
        encoding: 'utf-8',
        lastModified: '2026-04-21T00:00:00.000Z',
        etag: `${path}-etag`,
        format,
        mimeType: format === 'html' ? 'text/html' : 'text/markdown',
      };
    }

    function mockVault(htmlContent = () => REPORT_V1) {
      vi.mocked(filesApi.fetchTree).mockResolvedValue([
        { name: 'README.md', path: 'README.md', isDirectory: false, format: 'markdown' },
        { name: 'report.html', path: 'report.html', isDirectory: false, format: 'html' },
      ]);
      vi.mocked(filesApi.fetchFile).mockImplementation(async (path: string) =>
        path === 'report.html'
          ? remote(path, htmlContent(), 'html')
          : remote(path, '# Loaded from API', 'markdown'),
      );
    }

    function renderApp() {
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </MemoryRouter>,
      );
    }

    it('opens read-only: sandboxed preview and raw source, editing unavailable, then back to markdown', async () => {
      mockVault();
      renderApp();

      fireEvent.click(await screen.findByRole('treeitem', { name: /report\.html/ }));

      const frame = await screen.findByTitle('report.html — HTML preview');
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.getAttribute('srcdoc')).toContain('<h1>Quarterly report</h1>');
      expect(frame.getAttribute('srcdoc')).not.toContain('<script>');
      expect(screen.queryByRole('region', { name: 'Backlinks' })).not.toBeInTheDocument();
      expect(screen.getByText('Read-only', { selector: '.topbar-status' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled();

      // Edit is visibly unavailable and cannot be entered.
      const editTab = screen.getByRole('tab', { name: 'Edit' });
      expect(editTab).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(editTab);
      expect(screen.queryByRole('textbox', { name: 'Markdown source' })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');

      // Source shows the verbatim text.
      fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
      expect(screen.getByText(REPORT_V1)).toBeInTheDocument();

      // Back to markdown: rendered preview, no Source tab, editing works again.
      fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }));
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Loaded from API' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Source' })).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
      const markdownEdit = screen.getByRole('tab', { name: 'Edit' });
      expect(markdownEdit).not.toHaveAttribute('aria-disabled');
      fireEvent.click(markdownEdit);
      expect(await screen.findByRole('textbox', { name: 'Markdown source' })).toHaveValue(
        '# Loaded from API',
      );
    });

    it('never shows the markdown editor for an html document, even while it loads', async () => {
      mockVault();
      renderApp();

      fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }));
      fireEvent.click(await screen.findByRole('tab', { name: 'Edit' }));
      expect(await screen.findByRole('textbox', { name: 'Markdown source' })).toBeInTheDocument();

      let resolveHtml: (file: RemoteFile) => void = () => {};
      vi.mocked(filesApi.fetchFile).mockImplementationOnce(
        () => new Promise<RemoteFile>((resolve) => (resolveHtml = resolve)),
      );
      fireEvent.click(screen.getByRole('treeitem', { name: /report\.html/ }));

      expect(screen.queryByRole('textbox', { name: 'Markdown source' })).not.toBeInTheDocument();
      expect(screen.getByText('Loading preview…')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');

      await act(async () => resolveHtml(remote('report.html', REPORT_V1, 'html')));
      expect(await screen.findByTitle('report.html — HTML preview')).toBeInTheDocument();
    });

    it('refreshes the open preview when the html file changes on disk', async () => {
      class FakeEventSource {
        static latest: FakeEventSource | undefined;
        onopen: (() => void) | null = null;
        onmessage: ((message: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public url: string) {
          FakeEventSource.latest = this;
        }
        close() {}
      }
      vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

      let html = REPORT_V1;
      mockVault(() => html);
      renderApp();

      fireEvent.click(await screen.findByRole('treeitem', { name: /report\.html/ }));
      const frame = await screen.findByTitle('report.html — HTML preview');
      expect(frame.getAttribute('srcdoc')).toContain('Quarterly report');

      html = REPORT_V1.replace('Quarterly report', 'Revised report');
      const update: VaultEvent = {
        type: 'updated',
        path: 'report.html',
        actor: 'external',
        ts: '2026-04-22T00:00:00.000Z',
        source: 'watch',
      };
      act(() => FakeEventSource.latest?.onmessage?.({ data: JSON.stringify(update) }));

      await waitFor(() =>
        expect(screen.getByTitle('report.html — HTML preview').getAttribute('srcdoc')).toContain(
          'Revised report',
        ),
      );
      expect(
        vi.mocked(filesApi.fetchFile).mock.calls.filter(([p]) => p === 'report.html'),
      ).toHaveLength(2);
    });
  });
});
