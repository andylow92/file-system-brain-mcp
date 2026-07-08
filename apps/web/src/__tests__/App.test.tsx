import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import * as filesApi from '../api/files';

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
        };
      }

      if (path === 'renamed/note.md') {
        return {
          path,
          content: '# Renamed',
          encoding: 'utf-8',
          lastModified: '2026-04-22T00:00:00.000Z',
          etag: 'note-v2',
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
});
