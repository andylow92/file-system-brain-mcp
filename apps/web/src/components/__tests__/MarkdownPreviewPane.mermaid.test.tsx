import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mermaid touches browser-only APIs (getBBox, …) jsdom lacks, so mock the
// library. The mock covers the dynamic `import('mermaid')` too.
const renderMock = vi.fn();
const initializeMock = vi.fn();
vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

import { MarkdownPreviewPane } from '../MarkdownPreviewPane';

const MERMAID_DOC = ['```mermaid', 'graph TD; A-->B;', '```'].join('\n');

/**
 * Install a controllable `prefers-color-scheme` media query (jsdom has none).
 * Returns a `setDark` that flips the value and notifies listeners, so a live
 * theme toggle can be simulated.
 */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
  } as unknown as MediaQueryList;
  (window as unknown as { matchMedia: unknown }).matchMedia = vi.fn().mockReturnValue(mql);
  return {
    setDark(dark: boolean) {
      (mql as { matches: boolean }).matches = dark;
      listeners.forEach((cb) => cb({ matches: dark } as MediaQueryListEvent));
    },
  };
}

describe('MarkdownPreviewPane — mermaid', () => {
  beforeEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('renders a ```mermaid fence as an SVG diagram, not a code block', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="mmd"><g /></svg>' });

    const { container } = render(<MarkdownPreviewPane filePath="t.md" markdown={MERMAID_DOC} />);

    // It is routed to the diagram renderer, not the highlight.js code block.
    expect(container.querySelector('code.hljs')).toBeNull();

    await waitFor(() => {
      expect(container.querySelector('.mermaid-diagram svg')).toBeInTheDocument();
    });
    // The raw fence body (not the ``` lines) is handed to mermaid.
    expect(renderMock).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'graph TD; A-->B;');
  });

  it('falls back to the source when the diagram fails to render', async () => {
    renderMock.mockRejectedValue(new Error('parse error'));

    const { container, findByText } = render(
      <MarkdownPreviewPane filePath="t.md" markdown={MERMAID_DOC} />,
    );

    expect(await findByText(/Couldn.t render this Mermaid diagram/i)).toBeInTheDocument();
    const source = container.querySelector('.mermaid-diagram--error .mermaid-diagram__source');
    expect(source).toHaveTextContent('graph TD; A-->B;');
  });

  it('still renders a non-mermaid fence as a highlighted code block', () => {
    const md = ['```js', 'const x = 1;', '```'].join('\n');
    const { container } = render(<MarkdownPreviewPane filePath="t.md" markdown={md} />);

    expect(container.querySelector('.code-block code.hljs')).toBeInTheDocument();
    expect(container.querySelector('.mermaid-diagram')).toBeNull();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('themes by prefers-color-scheme and re-themes on a live toggle', async () => {
    const media = installMatchMedia(false); // start light
    renderMock.mockResolvedValue({ svg: '<svg data-testid="mmd"><g /></svg>' });

    const { container } = render(<MarkdownPreviewPane filePath="t.md" markdown={MERMAID_DOC} />);

    await waitFor(() => {
      expect(container.querySelector('.mermaid-diagram svg')).toBeInTheDocument();
    });
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }));

    // Toggle to dark; the diagram re-initializes with the dark theme.
    await act(async () => {
      media.setDark(true);
    });
    await waitFor(() => {
      expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
    });
  });
});
