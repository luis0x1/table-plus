import 'solid-js'

declare module 'solid-js' {
  namespace JSX {
    interface ExplicitAttributes {
      // Solid does not type `focusable` for SVG; icons set it alongside aria-hidden.
      focusable: string
    }
  }
}
