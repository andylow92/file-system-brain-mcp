import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsDialog } from '../SettingsDialog';

describe('SettingsDialog', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
  });

  function renderDialog(props: Partial<React.ComponentProps<typeof SettingsDialog>> = {}) {
    const onClose = vi.fn();
    const view = render(<SettingsDialog open onClose={onClose} {...props} />);
    return { ...view, onClose };
  }

  it('renders nothing while closed', () => {
    render(<SettingsDialog open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the OpenRouter settings', () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'OpenRouter' })).toBeInTheDocument();
  });

  it('persists OpenRouter settings and reports them to the caller', () => {
    const onOpenRouterSaved = vi.fn();
    renderDialog({ onOpenRouterSaved });

    fireEvent.change(screen.getByPlaceholderText('sk-or-...'), {
      target: { value: '  sk-or-test-key  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(localStorage.getItem('openrouter:apiKey')).toBe('sk-or-test-key');
    expect(onOpenRouterSaved).toHaveBeenCalledWith({
      apiKey: 'sk-or-test-key',
      model: 'anthropic/claude-3.5-sonnet',
    });
    expect(screen.getByText('OpenRouter settings saved.')).toBeInTheDocument();
  });

  it('closes on Escape and on the backdrop', async () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });
});
