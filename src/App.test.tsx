import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('mounts and redirects first-run users to the Settings screen', async () => {
  render(<App />);
  await waitFor(() => {
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Server URL')).toBeInTheDocument();
    expect(screen.getByText('Bearer Token')).toBeInTheDocument();
  });
});
