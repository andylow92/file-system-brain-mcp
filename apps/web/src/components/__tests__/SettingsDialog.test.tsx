import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as integrationsApi from '../../api/integrations';
import { SettingsDialog } from '../SettingsDialog';

vi.mock('../../api/integrations', () => ({
  getRocketReachStatus: vi.fn(),
  updateRocketReach: vi.fn(),
  testRocketReach: vi.fn(),
}));

describe('SettingsDialog', () => {
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

  function renderDialog(props: Partial<React.ComponentProps<typeof SettingsDialog>> = {}) {
    const onClose = vi.fn();
    const view = render(<SettingsDialog open onClose={onClose} {...props} />);
    return { ...view, onClose };
  }

  it('renders nothing while closed', () => {
    render(<SettingsDialog open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows both configuration surfaces as sections of one settings home', async () => {
    renderDialog();

    expect(screen.getByRole('tab', { name: 'Integrations' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'AI formatting' })).toBeInTheDocument();

    await waitFor(() => expect(integrationsApi.getRocketReachStatus).toHaveBeenCalled());
  });

  it('states that the MCP server must restart before the tools register', async () => {
    renderDialog();

    // Enabling the integration alone changes nothing agent-side; without this
    // note that gap reads as a failure.
    expect(screen.getByText(/registers RocketReach tools at startup/i)).toBeInTheDocument();
    expect(screen.getByText(/rocketreach_\*/)).toBeInTheDocument();

    await waitFor(() => expect(integrationsApi.getRocketReachStatus).toHaveBeenCalled());
  });

  it('switches to the OpenRouter section on click', async () => {
    renderDialog();
    await waitFor(() => expect(integrationsApi.getRocketReachStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: 'AI formatting' }));

    expect(screen.getByRole('heading', { name: 'OpenRouter' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'RocketReach' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'AI formatting' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves between sections with the arrow keys', async () => {
    renderDialog();
    await waitFor(() => expect(integrationsApi.getRocketReachStatus).toHaveBeenCalled());

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Integrations' }), { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { name: 'OpenRouter' })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'AI formatting' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('heading', { name: 'RocketReach' })).toBeInTheDocument();
  });

  it('honours initialSection so the editor gear lands on OpenRouter', () => {
    renderDialog({ initialSection: 'openrouter' });

    expect(screen.getByRole('heading', { name: 'OpenRouter' })).toBeInTheDocument();
    expect(integrationsApi.getRocketReachStatus).not.toHaveBeenCalled();
  });

  it('persists OpenRouter settings and reports them to the caller', () => {
    const onOpenRouterSaved = vi.fn();
    renderDialog({ initialSection: 'openrouter', onOpenRouterSaved });

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
    const { onClose } = renderDialog({ initialSection: 'openrouter' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it('toggling RocketReach on sends the update through the API', async () => {
    vi.mocked(integrationsApi.updateRocketReach).mockResolvedValue({
      enabled: true,
      configured: false,
      state: 'enabled_unconfigured',
    });

    renderDialog();
    await waitFor(() => expect(integrationsApi.getRocketReachStatus).toHaveBeenCalled());

    const toggle = await screen.findByRole('checkbox', { name: 'Enable RocketReach' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(integrationsApi.updateRocketReach).toHaveBeenCalledWith({ enabled: true }),
    );
    expect(await screen.findByText('RocketReach enabled.')).toBeInTheDocument();
  });

  it('surfaces a status load failure instead of showing a silent empty panel', async () => {
    vi.mocked(integrationsApi.getRocketReachStatus).mockRejectedValue(new Error('API offline'));

    renderDialog();

    expect(await screen.findByText('API offline')).toBeInTheDocument();
  });
});
