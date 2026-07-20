import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import api from '../src/api';

vi.mock('../src/api', () => {
  const api = {
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    verify: vi.fn(),
    catalog: vi.fn(),
    events: vi.fn(),
    createEvent: vi.fn(),
    schedules: vi.fn(),
    createSchedule: vi.fn(),
    patchSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    uploadEvidence: vi.fn(),
    users: vi.fn(),
    createUser: vi.fn(),
    patchUser: vi.fn(),
    resetPassword: vi.fn(),
    keys: vi.fn(),
    createKey: vi.fn(),
    revokeKey: vi.fn(),
    changePassword: vi.fn(),
    sessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    passkeyConfig: vi.fn(),
    passkeys: vi.fn(),
    passkeyRegisterOptions: vi.fn(),
    passkeyRegisterVerify: vi.fn(),
    passkeyDelete: vi.fn(),
    passkeyLoginOptions: vi.fn(),
    passkeyLoginVerify: vi.fn(),
    totpSetup: vi.fn(),
    totpEnable: vi.fn(),
    totpDisable: vi.fn()
  };
  return {
    api,
    default: api,
    exportUrls: {
      jsonl: () => '/api/export/jsonl',
      report: () => '/api/export/report'
    }
  };
});

const EDITOR = { id: 'u1', email: 'lucas@example.com', name: 'Lucas', role: 'editor' };
const AUDITOR = { id: 'u2', email: 'rev@example.com', name: 'Revisorn', role: 'auditor' };
const ADMIN = { id: 'u3', email: 'admin@example.com', name: 'Anna Admin', role: 'admin' };

const EVENT = {
  id: 'e1', sequence: 1, action: 'patch.applied',
  actor: { type: 'user', id: 'lucas' }, target: { type: 'system', id: 'web-01' },
  occurred_at: '2026-07-13T10:00:00.000Z', recorded_at: '2026-07-13T10:00:01.000Z',
  context: null, evidence: null,
  prev_hash: '0'.repeat(64), hash: 'a'.repeat(64)
};

// 'patch.applied' appears both as a filter <option> and a ledger cell — scope to the cell.
async function findLedgerCell() {
  const matches = await screen.findAllByText('patch.applied');
  return matches.find(el => el.tagName === 'TD');
}

function primeLoggedIn(user) {
  api.me.mockResolvedValue({ data: { user } });
  api.verify.mockResolvedValue({ data: { intact: true, verified: 1, checkpoint: null } });
  api.catalog.mockResolvedValue({ data: { actions: [{ action: 'patch.applied', title: 'Patch applied', soc2: ['CC7.1'], nis2: ['21.2(e)'] }] } });
  api.events.mockResolvedValue({ data: { events: [EVENT], has_more: false, next_before_sequence: null } });
  api.schedules.mockResolvedValue({ data: { schedules: [], overdue: 0 } });
}

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Passkeys are disabled by default; every screen that probes for them
    // must handle the rejection gracefully.
    api.passkeyConfig.mockRejectedValue(new Error('not configured'));
    api.passkeys.mockResolvedValue({ data: { passkeys: [] } });
    api.sessions.mockResolvedValue({ data: { sessions: [] } });
  });

  it('shows the login screen when there is no session', async () => {
    api.me.mockRejectedValue({ response: { status: 401 } });
    render(<App />);
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
  });

  it('logs in and shows the ledger with the chain badge', async () => {
    primeLoggedIn(EDITOR);
    api.me.mockRejectedValueOnce({ response: { status: 401 } });
    api.login.mockResolvedValue({ data: { user: EDITOR } });

    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email/), 'lucas@example.com');
    await user.type(screen.getByLabelText(/Password/), 'pw');
    await user.click(screen.getByText('Sign in'));

    expect(await findLedgerCell()).toBeInTheDocument();
    expect(await screen.findByText(/chain intact · 1 events/)).toBeInTheDocument();
    expect(api.login).toHaveBeenCalledWith('lucas@example.com', 'pw', undefined);
  });

  it('asks for a TOTP code when the server requires one', async () => {
    api.me.mockRejectedValue({ response: { status: 401 } });
    api.login.mockRejectedValueOnce({ response: { data: { totp_required: true, error: 'TOTP code required' } } });

    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Email/), 'lucas@example.com');
    await user.type(screen.getByLabelText(/Password/), 'pw');
    await user.click(screen.getByText('Sign in'));

    expect(await screen.findByLabelText(/TOTP \/ recovery code/)).toBeInTheDocument();
  });

  it('restores an existing session and scopes tabs by role: auditor', async () => {
    primeLoggedIn(AUDITOR);
    render(<App />);

    expect(await findLedgerCell()).toBeInTheDocument();
    expect(screen.getByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText('Export')).toBeInTheDocument();
    expect(screen.queryByText('Record')).not.toBeInTheDocument();
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('shows all tabs for admins', async () => {
    primeLoggedIn(ADMIN);
    render(<App />);
    await findLedgerCell();
    expect(screen.getByText('Record')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('sends debounced free-text search to the events API', async () => {
    primeLoggedIn(EDITOR);
    render(<App />);
    const user = userEvent.setup();
    await findLedgerCell();

    // The initial load must not carry a q parameter.
    expect(api.events.mock.calls[0][0]).not.toHaveProperty('q');

    await user.type(screen.getByPlaceholderText(/search events/), 'web-01');
    await waitFor(() => {
      const lastCall = api.events.mock.calls.at(-1)[0];
      expect(lastCall).toMatchObject({ q: 'web-01' });
    });
  });

  it('expands an event row to show hashes', async () => {
    primeLoggedIn(EDITOR);
    render(<App />);
    const user = userEvent.setup();
    await user.click(await findLedgerCell());
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
  });

  it('warns loudly when the chain is broken', async () => {
    primeLoggedIn(EDITOR);
    api.verify.mockResolvedValue({ data: { intact: false, verified: 3, firstBreak: 4, checkpoint: null } });
    render(<App />);
    expect(await screen.findByText(/CHAIN BROKEN at #4/)).toBeInTheDocument();
  });

  it('records an event from the Record view', async () => {
    primeLoggedIn(EDITOR);
    api.createEvent.mockResolvedValue({
      data: { event: { sequence: 2, hash: 'b'.repeat(64) }, known_action: true }
    });

    render(<App />);
    const user = userEvent.setup();
    await findLedgerCell();
    await user.click(screen.getByText('Record'));

    await user.type(screen.getByLabelText(/Action/), 'patch.applied');
    await user.click(screen.getByText('Append to ledger'));

    await waitFor(() => expect(api.createEvent).toHaveBeenCalled());
    const body = api.createEvent.mock.calls[0][0];
    expect(body.action).toBe('patch.applied');
    expect(body.actor).toEqual({ type: 'user', id: 'lucas@example.com' });
    expect(await screen.findByText(/#2/)).toBeInTheDocument();
  });

  it('shows scheduled controls with overdue status', async () => {
    primeLoggedIn(EDITOR);
    api.schedules.mockResolvedValue({
      data: {
        schedules: [{
          id: 's1', action: 'access.review.completed', title: 'Quarterly access review',
          frequency: 'quarterly', grace_days: 14, active: true,
          status: 'overdue', last_event_at: null, next_due_at: '2026-04-01T00:00:00.000Z',
          deadline_at: '2026-04-15T00:00:00.000Z'
        }],
        overdue: 1
      }
    });

    render(<App />);
    const user = userEvent.setup();
    await findLedgerCell();
    await user.click(screen.getByText('Schedules'));

    expect(await screen.findByText('Quarterly access review')).toBeInTheDocument();
    expect(screen.getByText('overdue')).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 scheduled control/)).toBeInTheDocument();
    expect(screen.getByText('never')).toBeInTheDocument();
  });

  it('creates a schedule from the Schedules view', async () => {
    primeLoggedIn(EDITOR);
    api.createSchedule.mockResolvedValue({ data: { schedule: { id: 's1' } } });

    render(<App />);
    const user = userEvent.setup();
    await findLedgerCell();
    await user.click(screen.getByText('Schedules'));

    await user.type(await screen.findByPlaceholderText(/action \(e\.g\./), 'backup.tested');
    await user.click(screen.getByText('Add schedule'));

    await waitFor(() => expect(api.createSchedule).toHaveBeenCalled());
    expect(api.createSchedule.mock.calls[0][0]).toMatchObject({
      action: 'backup.tested',
      frequency: 'quarterly',
      grace_days: 14
    });
  });

  it('signs out', async () => {
    primeLoggedIn(EDITOR);
    api.logout.mockResolvedValue({ data: { ok: true } });
    render(<App />);
    const user = userEvent.setup();
    await findLedgerCell();
    await user.click(screen.getByText('Sign out'));
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
  });
});
