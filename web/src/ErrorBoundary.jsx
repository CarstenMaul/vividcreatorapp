import { Component } from "react";

// Top-level safety net. Without this, any synchronous throw during render
// unmounts the whole React tree and leaves a pure-white window with nothing
// logged anywhere the user can see. Here we catch it, show the error, and log
// it to console.error — which electron/main.ts forwards into boot.log.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary] render error:", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    const detail = (e && (e.stack || e.message)) || String(e);
    return (
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: 32,
          color: "#e6e6e6",
          background: "#1f2430",
          minHeight: "100vh",
          boxSizing: "border-box",
        }}
      >
        <h1 style={{ color: "#f7768e", fontSize: 18 }}>VCA hit an error while rendering</h1>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#161a23",
            border: "1px solid #3a4252",
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {detail}
        </pre>
      </div>
    );
  }
}
