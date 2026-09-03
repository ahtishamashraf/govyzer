'use client';

import { createElement as h, useEffect, useRef, useState } from 'react';
import { STATUS_TONES } from './tokens.js';

export { tokens, STATUS_TONES } from './tokens.js';

const cx = (...values) => values.filter(Boolean).join(' ');

export function Button({ variant = 'primary', size = 'md', className, loading = false, children, ...props }) {
  return h(
    'button',
    {
      ...props,
      disabled: props.disabled || loading,
      className: cx('gv-btn', `gv-btn--${variant}`, `gv-btn--${size}`, loading && 'is-loading', className),
    },
    loading ? h('span', { className: 'gv-spinner', 'aria-hidden': 'true' }) : null,
    children
  );
}

export function Card({ title, description, actions, footer, className, children }) {
  return h(
    'section',
    { className: cx('gv-card', className) },
    title || actions
      ? h(
          'header',
          { className: 'gv-card__head' },
          h(
            'div',
            null,
            title ? h('h2', { className: 'gv-card__title' }, title) : null,
            description ? h('p', { className: 'gv-card__desc' }, description) : null
          ),
          actions ? h('div', { className: 'gv-card__actions' }, actions) : null
        )
      : null,
    h('div', { className: 'gv-card__body' }, children),
    footer ? h('footer', { className: 'gv-card__foot' }, footer) : null
  );
}

export function Badge({ tone, children, className }) {
  const resolved = tone ?? STATUS_TONES[String(children).toLowerCase?.()] ?? 'neutral';
  return h('span', { className: cx('gv-badge', `gv-badge--${resolved}`, className) }, children);
}

export function StatusBadge({ status }) {
  const label = String(status ?? 'unknown').replace(/_/g, ' ');
  return h(Badge, { tone: STATUS_TONES[status] ?? 'neutral' }, label);
}

export function Stat({ label, value, delta, hint, tone = 'neutral' }) {
  return h(
    'div',
    { className: cx('gv-stat', `gv-stat--${tone}`) },
    h('span', { className: 'gv-stat__label' }, label),
    h('strong', { className: 'gv-stat__value' }, value),
    delta != null ? h('span', { className: cx('gv-stat__delta', Number(delta) >= 0 ? 'is-up' : 'is-down') }, `${Number(delta) >= 0 ? '▲' : '▼'} ${Math.abs(Number(delta))}%`) : null,
    hint ? h('span', { className: 'gv-stat__hint' }, hint) : null
  );
}

export function Field({ label, hint, error, required, children, htmlFor }) {
  return h(
    'div',
    { className: cx('gv-field', error && 'has-error') },
    label ? h('label', { className: 'gv-field__label', htmlFor }, label, required ? h('span', { className: 'gv-field__req', 'aria-hidden': 'true' }, '*') : null) : null,
    children,
    error ? h('p', { className: 'gv-field__error', role: 'alert' }, error) : hint ? h('p', { className: 'gv-field__hint' }, hint) : null
  );
}

export function Input(props) {
  return h('input', { ...props, className: cx('gv-input', props.className) });
}

export function Textarea(props) {
  return h('textarea', { ...props, className: cx('gv-input gv-textarea', props.className) });
}

export function Select({ options = [], placeholder, ...props }) {
  return h(
    'select',
    { ...props, className: cx('gv-input gv-select', props.className) },
    placeholder ? h('option', { value: '' }, placeholder) : null,
    options.map((option) =>
      h('option', { key: String(option.value), value: option.value }, option.label)
    )
  );
}

export function EmptyState({ title, description, action, icon = '◇' }) {
  return h(
    'div',
    { className: 'gv-empty' },
    h('span', { className: 'gv-empty__icon', 'aria-hidden': 'true' }, icon),
    h('h3', { className: 'gv-empty__title' }, title),
    description ? h('p', { className: 'gv-empty__desc' }, description) : null,
    action ? h('div', { className: 'gv-empty__action' }, action) : null
  );
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }) {
  return h(
    'div',
    { className: 'gv-error', role: 'alert' },
    h('h3', { className: 'gv-error__title' }, title),
    message ? h('p', { className: 'gv-error__msg' }, message) : null,
    onRetry ? h(Button, { variant: 'secondary', size: 'sm', onClick: onRetry }, 'Try again') : null
  );
}

export function PermissionDenied({ permission }) {
  return h(EmptyState, {
    icon: '🔒',
    title: 'You do not have access to this view',
    description: permission ? `This screen requires the ${permission} permission. Ask an administrator to grant it.` : 'Ask an administrator to grant access.',
  });
}

export function Skeleton({ rows = 3, className }) {
  return h(
    'div',
    { className: cx('gv-skeleton', className), 'aria-busy': 'true', 'aria-live': 'polite' },
    Array.from({ length: rows }).map((_, index) => h('span', { key: index, className: 'gv-skeleton__row' }))
  );
}

export function DataTable({ columns, rows, empty, onRowClick, rowKey = (row) => row.id, loading = false }) {
  if (loading) return h(Skeleton, { rows: 6 });
  if (!rows || rows.length === 0) return empty ?? h(EmptyState, { title: 'Nothing to show yet' });

  return h(
    'div',
    { className: 'gv-table__wrap' },
    h(
      'table',
      { className: 'gv-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          columns.map((column) => h('th', { key: column.key, style: column.width ? { width: column.width } : undefined, scope: 'col' }, column.header))
        )
      ),
      h(
        'tbody',
        null,
        rows.map((row) =>
          h(
            'tr',
            {
              key: rowKey(row),
              onClick: onRowClick ? () => onRowClick(row) : undefined,
              className: onRowClick ? 'is-clickable' : undefined,
              tabIndex: onRowClick ? 0 : undefined,
              onKeyDown: onRowClick ? (event) => event.key === 'Enter' && onRowClick(row) : undefined,
            },
            columns.map((column) => h('td', { key: column.key, 'data-label': column.header }, column.render ? column.render(row) : row[column.key] ?? '—'))
          )
        )
      )
    )
  );
}

export function Tabs({ tabs, active, onChange }) {
  return h(
    'div',
    { className: 'gv-tabs', role: 'tablist' },
    tabs.map((tab) =>
      h(
        'button',
        {
          key: tab.value,
          role: 'tab',
          type: 'button',
          'aria-selected': active === tab.value,
          className: cx('gv-tab', active === tab.value && 'is-active'),
          onClick: () => onChange(tab.value),
        },
        tab.label,
        tab.count != null ? h('span', { className: 'gv-tab__count' }, tab.count) : null
      )
    )
  );
}

export function Drawer({ open, title, onClose, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return h(
    'div',
    { className: 'gv-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { className: 'gv-drawer__scrim', onClick: onClose }),
    h(
      'aside',
      { className: 'gv-drawer__panel' },
      h(
        'header',
        { className: 'gv-drawer__head' },
        h('h2', null, title),
        h('button', { type: 'button', className: 'gv-drawer__close', onClick: onClose, 'aria-label': 'Close' }, '×')
      ),
      h('div', { className: 'gv-drawer__body' }, children),
      footer ? h('footer', { className: 'gv-drawer__foot' }, footer) : null
    )
  );
}

export function Toast({ toasts = [], onDismiss }) {
  return h(
    'div',
    { className: 'gv-toasts', role: 'status', 'aria-live': 'polite' },
    toasts.map((toast) =>
      h(
        'div',
        { key: toast.id, className: cx('gv-toast', `gv-toast--${toast.tone ?? 'info'}`) },
        h('span', null, toast.message),
        h('button', { type: 'button', onClick: () => onDismiss(toast.id), 'aria-label': 'Dismiss' }, '×')
      )
    )
  );
}

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const counter = useRef(0);

  const push = (message, tone = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  };
  const dismiss = (id) => setToasts((current) => current.filter((toast) => toast.id !== id));
  return { toasts, push, dismiss };
}

export function ProgressBar({ value, max = 100, label }) {
  const percentage = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return h(
    'div',
    { className: 'gv-progress' },
    label ? h('span', { className: 'gv-progress__label' }, label) : null,
    h(
      'div',
      { className: 'gv-progress__track', role: 'progressbar', 'aria-valuenow': Math.round(percentage), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { className: 'gv-progress__fill', style: { width: `${percentage}%` } })
    )
  );
}
