import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import StatusPill from './StatusPill';

describe('StatusPill', () => {
  it.each([
    ['tracking', 'Tracking'],
    ['accountable', 'Accountable'],
    ['graduated', 'Graduated'],
  ] as const)('renders %s pill with display label %s', (status, label) => {
    render(<StatusPill status={status} />);
    expect(screen.getByTestId(`status-pill-${status}`)).toHaveTextContent(label);
  });

  it('applies a distinct ring/background for each status', () => {
    const { rerender } = render(<StatusPill status="tracking" />);
    expect(screen.getByTestId('status-pill-tracking').className).toMatch(
      /emerald/,
    );

    rerender(<StatusPill status="accountable" />);
    expect(screen.getByTestId('status-pill-accountable').className).toMatch(
      /amber/,
    );

    rerender(<StatusPill status="graduated" />);
    expect(screen.getByTestId('status-pill-graduated').className).toMatch(
      /neutral/,
    );
  });
});
