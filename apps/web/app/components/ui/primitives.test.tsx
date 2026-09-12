import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { Button } from './Button';
import { Field } from './Field';
import { EmptyState } from './EmptyState';

test('Button: primary variant gets the primary-button class, default is secondary', () => {
  const { rerender } = render(<Button>Save</Button>);
  assert.equal(screen.getByRole('button', { name: 'Save' }).className, 'secondary-button');

  rerender(<Button variant="primary">Save</Button>);
  assert.equal(screen.getByRole('button', { name: 'Save' }).className, 'primary-button');
});

test('Button: an extra className is appended, not replaced', () => {
  render(<Button className="wide">Go</Button>);
  assert.equal(screen.getByRole('button', { name: 'Go' }).className, 'secondary-button wide');
});

test('Button: forwards disabled and type through to the native element', () => {
  render(<Button type="submit" disabled>Submit</Button>);
  const el = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
  assert.equal(el.disabled, true);
  assert.equal(el.type, 'submit');
});

test('Field: renders the label text and input as a single <label>', () => {
  render(<Field label="Display name"><input aria-label="Display name" defaultValue="" /></Field>);
  const input = screen.getByLabelText('Display name');
  assert.ok(input);
});

test('EmptyState: plain by default, helper-text when helper is set', () => {
  const { rerender } = render(<EmptyState>No queues yet.</EmptyState>);
  assert.equal(screen.getByText('No queues yet.').className, '');

  rerender(<EmptyState helper>No alerts yet.</EmptyState>);
  assert.equal(screen.getByText('No alerts yet.').className, 'helper-text');
});
