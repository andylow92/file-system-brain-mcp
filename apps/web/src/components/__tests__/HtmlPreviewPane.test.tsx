import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTML_PREVIEW_CSP } from '../../html/sandbox';
import { HtmlPreviewPane, HtmlSourcePane } from '../HtmlPreviewPane';

const failBuild = vi.hoisted(() => ({ current: false }));

vi.mock('../../html/sandbox', async () => {
  const actual = await vi.importActual<typeof import('../../html/sandbox')>('../../html/sandbox');
  return {
    ...actual,
    buildSandboxedSrcdoc: (source: string) => {
      if (failBuild.current) {
        throw new Error('parser unavailable');
      }
      return actual.buildSandboxedSrcdoc(source);
    },
  };
});

const REPORT = '<html><head><style>h1{color:teal}</style></head><body><h1>Q3</h1></body></html>';

describe('HtmlPreviewPane', () => {
  afterEach(() => {
    cleanup();
    failBuild.current = false;
  });

  it('renders the document in an empty-sandbox frame with the CSP and an accessible title', () => {
    render(<HtmlPreviewPane filePath="reports/q3.html" source={REPORT} />);

    const frame = screen.getByTitle('q3.html — HTML preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(`content="${HTML_PREVIEW_CSP}"`);
    expect(srcdoc).toContain('<h1>Q3</h1>');
    expect(screen.getByText('HTML · read-only · scripts and network disabled')).toBeInTheDocument();
  });

  it('falls back to a notice plus the raw source when the preview cannot be built', () => {
    failBuild.current = true;
    render(<HtmlPreviewPane filePath="q3.html" source={REPORT} />);

    expect(screen.queryByTitle('q3.html — HTML preview')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'This HTML document could not be previewed (parser unavailable). Showing its source instead.',
    );
    expect(screen.getByText(REPORT)).toBeInTheDocument();
  });

  it('says so when the document is empty', () => {
    render(<HtmlPreviewPane filePath="blank.html" source="   " />);

    expect(screen.getByRole('status')).toHaveTextContent('This HTML document is empty.');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('shows a loading state until the source arrives', () => {
    render(<HtmlPreviewPane filePath="q3.html" source={undefined} />);

    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('HtmlSourcePane', () => {
  afterEach(cleanup);

  it('shows the raw source as escaped, read-only text', () => {
    const source = '<script>alert("x")</script><p onclick="y()">hi</p>';
    render(<HtmlSourcePane filePath="q3.html" source={source} />);

    const code = screen.getByText(source);
    expect(code.tagName).toBe('CODE');
    expect(code.closest('pre')).not.toBeNull();
    // Shown as text, never parsed into elements.
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('p[onclick]')).toBeNull();
    expect(screen.getByText('HTML source · read-only')).toBeInTheDocument();
  });
});
