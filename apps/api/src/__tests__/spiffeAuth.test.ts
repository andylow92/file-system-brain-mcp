import type http from 'node:http';

import { describe, expect, it } from 'vitest';
import {
  accessAllows,
  parseSpiffeId,
  resolveAgentAccess,
  DEFAULT_AUTH_SETTINGS,
  type AuthAgentRule,
} from '@repo/shared';

import { isLoopbackAddress, peerSpiffeId, requiredAccess } from '../auth/verifier.js';

describe('parseSpiffeId', () => {
  it('accepts well-formed ids with and without paths', () => {
    expect(parseSpiffeId('spiffe://example.org')).toEqual({
      trustDomain: 'example.org',
      path: '',
      id: 'spiffe://example.org',
    });
    expect(parseSpiffeId('spiffe://example.org/agent/claude-laptop')?.path).toBe(
      '/agent/claude-laptop',
    );
    expect(parseSpiffeId('spiffe://prod_1.example-corp.internal/ns/a.b_c-d')?.trustDomain).toBe(
      'prod_1.example-corp.internal',
    );
  });

  it('rejects everything the SPIFFE spec forbids', () => {
    for (const bad of [
      'https://example.org/agent',
      'spiffe://',
      'spiffe://Example.org/x', // uppercase trust domain
      'spiffe://example.org:8443/x', // port
      'spiffe://user@example.org/x', // userinfo
      'spiffe://example.org/x?y=1', // query
      'spiffe://example.org/x#frag', // fragment
      'spiffe://example.org//double',
      'spiffe://example.org/trailing/',
      'spiffe://example.org/./dot',
      'spiffe://example.org/../up',
      'spiffe://example.org/sp ace',
      '',
    ]) {
      expect(parseSpiffeId(bad), bad).toBeNull();
    }
  });
});

describe('resolveAgentAccess', () => {
  const rules: AuthAgentRule[] = [
    { id: 'spiffe://example.org/readonly/', match: 'prefix', access: 'read' },
    { id: 'spiffe://example.org/readonly/special', match: 'exact', access: 'admin' },
    { id: 'spiffe://example.org/', match: 'prefix', access: 'readwrite' },
  ];

  it('prefers exact rules, then the longest prefix, then the default', () => {
    expect(resolveAgentAccess('spiffe://example.org/readonly/special', rules, 'none')).toBe(
      'admin',
    );
    expect(resolveAgentAccess('spiffe://example.org/readonly/scout', rules, 'none')).toBe('read');
    expect(resolveAgentAccess('spiffe://example.org/agent/x', rules, 'none')).toBe('readwrite');
    expect(resolveAgentAccess('spiffe://other.org/agent/x', [], 'none')).toBeNull();
    expect(resolveAgentAccess('spiffe://other.org/agent/x', [], 'read')).toBe('read');
  });

  it('orders access levels read < readwrite < admin', () => {
    expect(accessAllows('read', 'read')).toBe(true);
    expect(accessAllows('read', 'readwrite')).toBe(false);
    expect(accessAllows('readwrite', 'read')).toBe(true);
    expect(accessAllows('readwrite', 'admin')).toBe(false);
    expect(accessAllows('admin', 'readwrite')).toBe(true);
  });
});

describe('requiredAccess', () => {
  it('maps reads to read, writes to readwrite, auth changes to admin', () => {
    expect(requiredAccess('GET', '/api/tree')).toBe('read');
    expect(requiredAccess('POST', '/api/file')).toBe('readwrite');
    expect(requiredAccess('DELETE', '/api/path')).toBe('readwrite');
    expect(requiredAccess('PUT', '/api/auth')).toBe('admin');
    expect(requiredAccess('GET', '/api/auth')).toBe('read');
    expect(requiredAccess('POST', '/api/auth/test')).toBe('read');
  });
});

describe('isLoopbackAddress', () => {
  it('covers IPv4, IPv6, and mapped loopback forms only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.8.9.10')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('peerSpiffeId (mTLS SAN extraction)', () => {
  const settings = { ...DEFAULT_AUTH_SETTINGS, trustDomain: 'example.org' };

  function fakeRequest(socket: Record<string, unknown>): http.IncomingMessage {
    return { socket } as unknown as http.IncomingMessage;
  }

  it('returns the SAN URI identity for an authorized cert in the trust domain', () => {
    const req = fakeRequest({
      encrypted: true,
      authorized: true,
      getPeerCertificate: () => ({
        subjectaltname: 'DNS:vault.internal, URI:spiffe://example.org/agent/cert-agent',
      }),
    });
    expect(peerSpiffeId(req, settings)).toBe('spiffe://example.org/agent/cert-agent');
  });

  it('ignores unauthorized, certless, plain, and out-of-domain connections', () => {
    expect(
      peerSpiffeId(
        fakeRequest({
          encrypted: true,
          authorized: false,
          getPeerCertificate: () => ({
            subjectaltname: 'URI:spiffe://example.org/agent/unverified',
          }),
        }),
        settings,
      ),
    ).toBeUndefined();
    expect(
      peerSpiffeId(
        fakeRequest({
          encrypted: true,
          authorized: true,
          getPeerCertificate: () => ({ subjectaltname: 'URI:spiffe://other.org/agent/x' }),
        }),
        settings,
      ),
    ).toBeUndefined();
    expect(
      peerSpiffeId(
        fakeRequest({
          encrypted: true,
          authorized: true,
          getPeerCertificate: () => ({}),
        }),
        settings,
      ),
    ).toBeUndefined();
    expect(peerSpiffeId(fakeRequest({}), settings)).toBeUndefined();
  });
});
