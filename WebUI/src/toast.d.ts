type ToastOptions = {
  mounted?: string | HTMLElement
  style?: ToastStyle
  settings?: ToastSettings
  /** A button in the toast; clicking it runs `run` and hides the toast. */
  action?: ToastAction
}

type ToastAction = {
  label: string
  run: () => void
}

type ToastStyle = {
  main?: KVObject
  content?: KVObject
}

type ToastSettings = {
  duration: number
}

type ToastTransitions = {
  show: object
  hide: object
}
