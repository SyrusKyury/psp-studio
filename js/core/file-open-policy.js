function hasExplicitAccept(manifest, fileName) {
  const name = String(fileName || '').toLowerCase();
  return manifest.accepts.some((rule) => {
    const normalized = String(rule || '').trim().toLowerCase();
    if (!normalized || normalized === '*') return false;
    if (normalized.startsWith('.')) return name.endsWith(normalized);
    return name === normalized;
  });
}

/**
 * Pick a tool only when the choice is unambiguous or intentionally preferred.
 * Saved workspace associations are handled by app.js before this function.
 *
 * Rules:
 * - Image Viewer is the lightweight default whenever it explicitly supports a file.
 * - Wildcard-only tools (currently Hex Viewer) are fallbacks, not competitors to a
 *   single format-specific handler.
 * - If several format-specific handlers remain, let Open With ask the user.
 */
export function automaticHandler(fileName, handlers = []) {
  if (!Array.isArray(handlers) || !handlers.length) return null;

  const imageViewer = handlers.find((tool) => tool.id === 'image-viewer' && hasExplicitAccept(tool, fileName));
  if (imageViewer) return imageViewer;

  const explicit = handlers.filter((tool) => hasExplicitAccept(tool, fileName));
  if (explicit.length === 1) return explicit[0];
  if (explicit.length > 1) return null;

  const hexViewer = handlers.find((tool) => tool.id === 'hex-viewer');
  if (hexViewer) return hexViewer;

  return handlers.length === 1 ? handlers[0] : null;
}
