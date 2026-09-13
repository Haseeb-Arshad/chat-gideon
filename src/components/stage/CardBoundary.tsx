import { Component, type ErrorInfo, type ReactNode } from 'react'

interface CardBoundaryProps {
  /** A different card starts with a clean slate. */
  resetKey: unknown
  children: ReactNode
}

/**
 * Keeps one card's failure to itself.
 *
 * Without it, a block that throws while rendering unmounts everything above
 * it, which on this page is the whole conversation: the face, the transcript,
 * the controls. A card that cannot be drawn is simply not drawn, and the talk
 * carries on around it.
 */
export class CardBoundary extends Component<CardBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A card could not be drawn.', error, info.componentStack)
  }

  componentDidUpdate(previous: CardBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
