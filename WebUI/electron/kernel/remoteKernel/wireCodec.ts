const BYTES = '__aipgBytes'
const UNDEFINED = '__aipgUndefined'

export type StringMapper = (value: string) => string

function isMarker(value: unknown, key: string): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    key in value &&
    Object.keys(value).length === 1
  )
}

/**
 * JSON for the remote-kernel wire. Byte arrays and `undefined` survive the trip (IPC
 * structured clone keeps both, and a `null` in place of an omitted argument defeats a
 * handler's default parameter); `mapString` rewrites every string on the way out.
 */
export function encodeWire(value: unknown, mapString?: StringMapper): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, mapped: unknown) {
    const raw = this[key]
    if (raw === undefined) return { [UNDEFINED]: 1 }
    if (raw instanceof ArrayBuffer) return { [BYTES]: Buffer.from(raw).toString('base64') }
    if (ArrayBuffer.isView(raw)) {
      return { [BYTES]: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') }
    }
    if (typeof mapped === 'string' && mapString) return mapString(mapped)
    return mapped
  })
}

export function decodeWire<T = unknown>(text: string, mapString?: StringMapper): T {
  return JSON.parse(text, (_key, value: unknown) => {
    if (isMarker(value, UNDEFINED)) return undefined
    if (isMarker(value, BYTES) && typeof value[BYTES] === 'string') {
      return Buffer.from(value[BYTES], 'base64')
    }
    if (typeof value === 'string' && mapString) return mapString(value)
    return value
  }) as T
}
