import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { StatusMessage } from './StatusMessage';

test('renders nothing when there is no message', () => {
  const { container } = render(<StatusMessage message={null} kind="success" />);
  assert.equal(container.textContent, '');
});

test('inline variant: success uses role=status and no error class', () => {
  render(<StatusMessage message="Saved." kind="success" />);
  const el = screen.getByRole('status');
  assert.equal(el.textContent, 'Saved.');
  assert.equal(el.className, 'inline-message');
});

test('inline variant: error uses role=alert and the error-text class', () => {
  render(<StatusMessage message="Could not save." kind="error" />);
  const el = screen.getByRole('alert');
  assert.equal(el.textContent, 'Could not save.');
  assert.equal(el.className, 'inline-message error-text');
});

test('helper variant: success and error share helper-text, only error adds error-text', () => {
  const { rerender } = render(<StatusMessage message="Reset link sent." kind="success" variant="helper" />);
  assert.equal(screen.getByRole('status').className, 'helper-text');

  rerender(<StatusMessage message="Email is required." kind="error" variant="helper" />);
  assert.equal(screen.getByRole('alert').className, 'helper-text error-text');
});
