import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DocumentFormat } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewerTabs, type ViewerTabKey } from '../FileViewerTabs';

function renderTabs({
  format = 'markdown',
  initialTab = 'preview',
  onTabChange,
}: {
  format?: DocumentFormat;
  initialTab?: ViewerTabKey;
  onTabChange?: (tab: ViewerTabKey) => void;
} = {}) {
  function Harness() {
    const [activeTab, setActiveTab] = useState<ViewerTabKey>(initialTab);
    return (
      <FileViewerTabs
        activeTab={activeTab}
        onTabChange={(tab) => {
          onTabChange?.(tab);
          setActiveTab(tab);
        }}
        documentFormat={format}
        preview={<p>Preview Body</p>}
        source={<p>Source Body</p>}
        edit={<p>Edit Body</p>}
        activity={<p>Activity Body</p>}
        review={<p>Review Body</p>}
        graph={<p>Graph Body</p>}
        reviewCount={2}
      />
    );
  }
  return render(<Harness />);
}

const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'File tabs' }))
    .getAllByRole('tab')
    .map((tab) => tab.getAttribute('data-tab'));

describe('FileViewerTabs', () => {
  afterEach(cleanup);

  it('offers Preview, Split, Edit, Activity, Review, Graph for markdown (no Source)', () => {
    renderTabs();

    expect(tabNames()).toEqual(['preview', 'split', 'edit', 'activity', 'review', 'graph']);
    expect(screen.queryByRole('tab', { name: 'Source' })).not.toBeInTheDocument();
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).not.toHaveAttribute('aria-disabled');
    }
  });

  it('adds Source for html, and makes Split and Edit read-only with an explanation', () => {
    const onTabChange = vi.fn();
    renderTabs({ format: 'html', onTabChange });

    expect(tabNames()).toEqual([
      'preview',
      'source',
      'split',
      'edit',
      'activity',
      'review',
      'graph',
    ]);
    for (const name of ['Split', 'Edit']) {
      const tab = screen.getByRole('tab', { name });
      expect(tab).toHaveAttribute('aria-disabled', 'true');
      expect(tab).toHaveAccessibleDescription(
        'HTML documents are read-only. Only Markdown notes can be edited.',
      );
      expect(tab).toHaveAttribute('title', expect.stringContaining('read-only'));
      fireEvent.click(tab);
    }
    expect(onTabChange).not.toHaveBeenCalled();
    expect(screen.getByText('Preview Body')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(onTabChange).toHaveBeenCalledWith('source');
    expect(screen.getByText('Source Body')).toBeInTheDocument();
  });

  it('shows Preview (and selects it) when html opens on Edit or Split', () => {
    for (const initialTab of ['edit', 'split'] as const) {
      renderTabs({ format: 'html', initialTab });

      expect(screen.getByText('Preview Body')).toBeInTheDocument();
      expect(screen.queryByText('Edit Body')).not.toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: 'Split' })).toHaveAttribute('aria-selected', 'false');
      cleanup();
    }
  });

  it('shows Preview when markdown opens on Source', () => {
    renderTabs({ format: 'markdown', initialTab: 'source' });

    expect(screen.getByText('Preview Body')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('labels the panel by the selected tab, which controls it', () => {
    renderTabs({ initialTab: 'activity' });

    const panel = screen.getByRole('tabpanel', { name: 'Activity' });
    expect(panel).toHaveTextContent('Activity Body');
    const activityTab = screen.getByRole('tab', { name: 'Activity' });
    expect(activityTab).toHaveAttribute('aria-selected', 'true');
    expect(activityTab.getAttribute('aria-controls')).toBe(panel.id);
    expect(activityTab).toHaveClass('active');
  });

  it('keeps only the selected tab in the Tab sequence (roving tabindex)', () => {
    renderTabs({ initialTab: 'edit' });

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('tabindex', tab.dataset.tab === 'edit' ? '0' : '-1');
    }
  });

  it('moves focus with arrows (wrapping), Home and End without activating', () => {
    const onTabChange = vi.fn();
    renderTabs({ onTabChange });
    const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

    tab('Preview').focus();
    fireEvent.keyDown(tab('Preview'), { key: 'ArrowRight' });
    expect(tab('Split')).toHaveFocus();
    fireEvent.keyDown(tab('Split'), { key: 'ArrowLeft' });
    expect(tab('Preview')).toHaveFocus();
    fireEvent.keyDown(tab('Preview'), { key: 'ArrowLeft' });
    expect(tab('Graph')).toHaveFocus();
    fireEvent.keyDown(tab('Graph'), { key: 'ArrowRight' });
    expect(tab('Preview')).toHaveFocus();
    fireEvent.keyDown(tab('Preview'), { key: 'End' });
    expect(tab('Graph')).toHaveFocus();
    fireEvent.keyDown(tab('Graph'), { key: 'Home' });
    expect(tab('Preview')).toHaveFocus();

    // Manual activation: moving focus never switches the panel.
    expect(onTabChange).not.toHaveBeenCalled();
    expect(screen.getByText('Preview Body')).toBeInTheDocument();
  });

  it('activates the focused tab with Enter or Space', () => {
    const onTabChange = vi.fn();
    renderTabs({ onTabChange });

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Activity' }), { key: 'Enter' });
    expect(onTabChange).toHaveBeenLastCalledWith('activity');
    expect(screen.getByText('Activity Body')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Graph' }), { key: ' ' });
    expect(onTabChange).toHaveBeenLastCalledWith('graph');
    expect(screen.getByText('Graph Body')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Graph' })).toHaveAttribute('tabindex', '0');
  });

  it('lets keyboard users reach read-only tabs, but not activate them', () => {
    const onTabChange = vi.fn();
    renderTabs({ format: 'html', onTabChange });
    const source = screen.getByRole('tab', { name: 'Source' });
    const split = screen.getByRole('tab', { name: 'Split' });

    source.focus();
    fireEvent.keyDown(source, { key: 'ArrowRight' });
    expect(split).toHaveFocus();
    fireEvent.keyDown(split, { key: 'Enter' });
    fireEvent.keyDown(split, { key: ' ' });
    expect(onTabChange).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
  });
});
