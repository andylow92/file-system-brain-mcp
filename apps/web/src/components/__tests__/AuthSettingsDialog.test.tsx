import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusResponse } from '@repo/shared';
import { AuthSettingsDialog } from '../AuthSettingsDialog';
import { getAuthStatus, testAuthToken, updateAuthSettings } from '../../api/auth';

vi.mock('../../api/auth', () => ({
  getAuthStatus: vi.fn(),
  updateAuthSettings: vi.fn(),
  testAuthToken: vi.fn(),
}));

const disabledStatus: AuthStatusResponse = {
  enabled: false,
  configured: false,
  state: 'disabled',
  audience: 'fsbrain',
  allowLoopback: true,
  defaultAccess: 'readwrite',
  bearerReady: false,
  agents: [],
  caller: { kind: 'loopback' },
};

describe('AuthSettingsDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads status and shows the disabled state', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(disabledStatus);
    render(<AuthSettingsDialog open onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/Disabled — vault trusts its network/)).toBeTruthy(),
    );
    expect(getAuthStatus).toHaveBeenCalledTimes(1);
  });

  it('toggling the switch sends only the enabled patch', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({
      ...disabledStatus,
      configured: true,
      trustDomain: 'example.org',
    });
    vi.mocked(updateAuthSettings).mockResolvedValue({
      ...disabledStatus,
      enabled: true,
      configured: true,
      state: 'enabled',
      trustDomain: 'example.org',
      bearerReady: true,
      jwksSource: 'inline',
    });

    render(<AuthSettingsDialog open onClose={() => {}} />);
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole('checkbox', { name: /Require SPIFFE identity for remote requests/ }),
    );
    await waitFor(() => expect(updateAuthSettings).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(screen.getByText(/Auth enabled/)).toBeTruthy());
  });

  it('saves the full configuration including added rules', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(disabledStatus);
    vi.mocked(updateAuthSettings).mockResolvedValue({
      ...disabledStatus,
      configured: true,
      trustDomain: 'example.org',
    });

    render(<AuthSettingsDialog open onClose={() => {}} />);
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('example.org'), {
      target: { value: 'example.org' },
    });
    fireEvent.change(screen.getByLabelText('New rule SPIFFE id'), {
      target: { value: 'spiffe://example.org/agent/ops' },
    });
    fireEvent.change(screen.getByLabelText('New rule access'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(updateAuthSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          trustDomain: 'example.org',
          agents: [{ id: 'spiffe://example.org/agent/ops', match: 'exact', access: 'admin' }],
        }),
      ),
    );
  });

  it('tests a pasted token and reports the verdict', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(disabledStatus);
    vi.mocked(testAuthToken).mockResolvedValue({
      valid: true,
      spiffeId: 'spiffe://example.org/agent/probe',
      access: 'readwrite',
    });

    render(<AuthSettingsDialog open onClose={() => {}} />);
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Paste a JWT-SVID/), {
      target: { value: 'header.payload.sig' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test token' }));
    await waitFor(() =>
      expect(
        screen.getByText(/Valid — spiffe:\/\/example\.org\/agent\/probe \(access: readwrite\)/),
      ).toBeTruthy(),
    );
    expect(testAuthToken).toHaveBeenCalledWith('header.payload.sig');
  });
});
