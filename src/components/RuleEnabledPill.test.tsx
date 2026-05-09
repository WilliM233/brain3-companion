import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import RuleEnabledPill from './RuleEnabledPill';

describe('RuleEnabledPill', () => {
  it('renders the Enabled pill in emerald tone when enabled', () => {
    render(<RuleEnabledPill enabled={true} />);
    const pill = screen.getByTestId('rule-enabled-pill-enabled');
    expect(pill).toHaveTextContent('Enabled');
    expect(pill.className).toMatch(/emerald/);
  });

  it('renders the Disabled pill in neutral tone when disabled', () => {
    render(<RuleEnabledPill enabled={false} />);
    const pill = screen.getByTestId('rule-enabled-pill-disabled');
    expect(pill).toHaveTextContent('Disabled');
    expect(pill.className).toMatch(/neutral/);
  });
});
