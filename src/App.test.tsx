import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the scaffold message on the home route', () => {
  render(<App />);
  expect(screen.getByText(/BRAIN Companion · Phase 2 scaffold/)).toBeInTheDocument();
});
