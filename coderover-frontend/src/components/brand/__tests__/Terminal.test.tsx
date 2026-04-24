import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Terminal, TerminalLine, TerminalToken } from '../Terminal';

describe('Terminal', () => {
  it('renders with default title, three traffic-light dots, and body children', () => {
    render(
      <Terminal>
        <TerminalLine>hello world</TerminalLine>
      </Terminal>
    );
    expect(screen.getByTestId('terminal-title')).toHaveTextContent('~/my-app — rover');
    expect(screen.getByTestId('terminal-dots').children).toHaveLength(3);
    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  it('uses the provided title when passed', () => {
    render(
      <Terminal title="~/repo/a — bash">
        <TerminalLine>hi</TerminalLine>
      </Terminal>
    );
    expect(screen.getByTestId('terminal-title')).toHaveTextContent('~/repo/a — bash');
  });
});

describe('TerminalLine', () => {
  it('renders a $ prompt when prompt=true', () => {
    render(<TerminalLine prompt>rover land</TerminalLine>);
    expect(screen.getByText('$')).toBeInTheDocument();
    expect(screen.getByText('rover land')).toBeInTheDocument();
  });

  it('does not render a prompt when prompt is undefined', () => {
    render(<TerminalLine>bare output</TerminalLine>);
    expect(screen.queryByText('$')).not.toBeInTheDocument();
  });

  it('applies muted styling when muted=true', () => {
    render(<TerminalLine muted>quiet line</TerminalLine>);
    const line = screen.getByText('quiet line');
    expect(line.closest('[data-testid="terminal-line"]')).toHaveClass('text-muted-foreground');
  });
});

describe('TerminalToken', () => {
  it('renders with accent tone by mapping to text-accent', () => {
    render(<TerminalToken tone="accent">ok</TerminalToken>);
    expect(screen.getByText('ok')).toHaveClass('text-accent');
  });

  it('renders with destructive tone by mapping to text-destructive', () => {
    render(<TerminalToken tone="destructive">BLOCK</TerminalToken>);
    expect(screen.getByText('BLOCK')).toHaveClass('text-destructive');
  });
});
