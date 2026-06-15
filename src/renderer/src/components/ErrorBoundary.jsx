import { Component } from 'react'

// Keeps a render error in one view from blanking the whole app.
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('UI error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 28, color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
          Что-то пошло не так в этом экране.
          <br />
          {String(this.state.error?.message || this.state.error)}
        </div>
      )
    }
    return this.props.children
  }
}
