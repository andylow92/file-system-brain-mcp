import { cleanup, render, waitFor } from '@testing-library/react';
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

describe('MarkdownPreviewPane — mermaid', () => {
  beforeEach(() => {
    renderMock.mockReset();
    initializeMock.mockReset();
  });
  afterEach(() => cleanup());

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
});
