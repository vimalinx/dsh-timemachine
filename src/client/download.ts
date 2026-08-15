/**
 * Browser-side archive transfer helpers: turning the `export` endpoint's
 * base64 zip into a download, and a picked file back into the base64 the
 * `import` endpoint expects. Kept out of the component so the apply closure
 * owns the RPC and this module owns the DOM mechanics.
 */

/**
 * Decode base64 to bytes.
 * @param base64 - the wire payload.
 * @returns the raw bytes.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}

/**
 * Encode bytes as base64, chunked so the spread never blows the argument
 * limit on a large archive.
 * @param bytes - the raw bytes.
 * @returns the base64 payload.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(text)
}

/**
 * Trigger a browser download of a base64 zip archive.
 * @param base64 - the archive payload.
 * @param filename - the suggested download name.
 */
export function downloadZip(base64: string, filename: string): void {
  const blob = new Blob([base64ToBytes(base64) as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * The export download's suggested filename: `dsh-timemachine-<date>.zip`.
 * @param now - the export moment.
 * @returns the filename.
 */
export function exportFilename(now: Date): string {
  return `dsh-timemachine-${now.toISOString().slice(0, 10)}.zip`
}

/**
 * Read a picked file as base64 for the `import` endpoint.
 * @param file - the file from an `<input type="file">`.
 * @returns the base64 payload.
 */
export async function readFileBase64(file: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()))
}
