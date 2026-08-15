const CHUNK = 8 * 1024 * 1024;

function safeParentDocument() {
  try {
    if (window.parent && window.parent !== window && window.parent.document?.body) return window.parent.document;
  } catch {}
  return null;
}

export async function saveBlob(blob, filename, { description = 'File', mime = blob?.type || 'application/octet-stream', extension = '' } = {}) {
  if (!(blob instanceof Blob)) throw new Error('Nothing to save: output is not a Blob.');
  const name = String(filename || 'download.bin');
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const ext = extension || (name.includes('.') ? `.${name.split('.').pop()}` : '');
      const types = ext ? [{ description, accept: { [mime || 'application/octet-stream']: [ext] } }] : undefined;
      const handle = await window.showSaveFilePicker({ suggestedName: name, ...(types ? { types } : {}) });
      const writable = await handle.createWritable();
      try {
        for (let offset = 0; offset < blob.size; offset += CHUNK) {
          await writable.write(blob.slice(offset, Math.min(blob.size, offset + CHUNK)));
        }
        await writable.close();
        return { mode: 'picker', name };
      } catch (error) {
        try { await writable.abort(); } catch {}
        throw error;
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // File System Access can be unavailable from an embedded browsing context
      // even when the method exists. Fall back to a normal browser download.
      console.warn('Native save picker unavailable; using browser download.', error);
    }
  }

  // When hosted in an iframe, trigger the download from the same-origin parent
  // document. Firefox can otherwise treat a blob: anchor as frame navigation,
  // which is blocked by the Studio's frame-src 'self' CSP.
  const hostDocument = safeParentDocument() || document;
  const url = URL.createObjectURL(blob);
  const anchor = hostDocument.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  hostDocument.body.appendChild(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return { mode: hostDocument === document ? 'download' : 'parent-download', name };
}
