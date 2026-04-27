import React from 'react';

interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
}

// Catches render-time errors so we can see them inside CEF (which has no
// devtools by default). Without this, a thrown error blanks the whole app.
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, info });
    console.error('[ErrorBoundary]', error, info);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        padding: 24,
        margin: 24,
        border: '1px solid rgba(176, 74, 74, 0.4)',
        background: 'rgba(176, 74, 74, 0.08)',
        borderRadius: 8,
        fontFamily: 'var(--font-sans)',
      }}>
        <h2 style={{ color: '#7a3030', marginBottom: 12 }}>Render error</h2>
        <pre style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          background: 'rgba(0,0,0,0.04)',
          padding: 12,
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
          maxHeight: 200,
          overflow: 'auto',
        }}>{this.state.error.message}{'\n\n'}{this.state.error.stack ?? ''}</pre>
        {this.state.info && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#7a3030' }}>Component stack</summary>
            <pre style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: 8,
              maxHeight: 200,
              overflow: 'auto',
            }}>{this.state.info.componentStack}</pre>
          </details>
        )}
        <button
          style={{ marginTop: 12, padding: '6px 12px', cursor: 'pointer' }}
          onClick={this.reset}
        >Dismiss & retry</button>
      </div>
    );
  }
}
