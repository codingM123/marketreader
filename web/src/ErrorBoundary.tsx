/**
 * A crash in one card must not take the page with it.
 *
 * This product's whole argument is that a system handling money should degrade
 * honestly rather than fail silently or fail totally. A white screen because
 * one field was missing from one response would contradict that on the first
 * bad deploy. The boundary keeps the rest of the digest readable and says
 * plainly which part broke.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label: string;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <p className="lab-fault" style={{ margin: "1rem 0" }}>
        This section could not be drawn ({this.props.label}: {this.state.error.message}). The rest of
        the page is unaffected, and the numbers you can see are still current.
      </p>
    );
  }
}
