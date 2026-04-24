import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CLIInstallBlock } from '../CLIInstallBlock';

describe('CLIInstallBlock', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom exposes navigator.clipboard as a getter — must use defineProperty
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the command with a $ prompt and a Copy button', () => {
    render(<CLIInstallBlock command="npm install -g coderover" />);
    expect(screen.getByText('npm install -g coderover')).toBeInTheDocument();
    expect(screen.getByText('$')).toBeInTheDocument();
    expect(screen.getByTestId('cli-install-copy')).toHaveTextContent('Copy');
  });

  it('copies the command to clipboard and shows "Copied" on click', async () => {
    render(<CLIInstallBlock command="npm install -g coderover && rover land" />);

    const btn = screen.getByTestId('cli-install-copy');
    fireEvent.click(btn);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('npm install -g coderover && rover land')
    );
    await waitFor(() => expect(btn).toHaveTextContent('Copied'));
    expect(btn).toHaveAttribute('aria-label', 'Copied');
  });

  it('reverts to "Copy" after 2 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    render(<CLIInstallBlock command="rover land" />);

    const btn = screen.getByTestId('cli-install-copy');
    await user.click(btn);
    await vi.waitFor(() => expect(btn).toHaveTextContent('Copied'));

    await vi.advanceTimersByTimeAsync(2100);
    expect(btn).toHaveTextContent('Copy');
  });
});
