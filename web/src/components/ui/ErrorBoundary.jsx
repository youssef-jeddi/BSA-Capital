import { Component } from 'react'

/**
 * A render error used to blank the whole page, which is a terrible way to lose
 * a demo. Show what broke and keep the rest of the app usable instead.
 */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) { return { error } }

  componentDidCatch(error, info) {
    console.error('[BSA] render error', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="card">
        <h2>This screen crashed</h2>
        <p className="lede">
          The rest of the app still works. Details below, and the full stack is in the browser console.
        </p>
        <pre>{String(this.state.error?.message ?? this.state.error)}</pre>
        <div className="row">
          <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}
