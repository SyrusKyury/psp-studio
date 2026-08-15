function isEditableTarget(target) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

function normalizeKey(key) { return key === ' ' ? 'space' : String(key || '').toLowerCase(); }

function parseCombo(combo) {
  const spec = { mod: false, ctrl: false, meta: false, shift: false, alt: false, key: '' };
  for (const token of String(combo).split('+').map((part) => part.trim()).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === 'mod') spec.mod = true;
    else if (lower === 'ctrl' || lower === 'control') spec.ctrl = true;
    else if (lower === 'cmd' || lower === 'meta') spec.meta = true;
    else if (lower === 'shift') spec.shift = true;
    else if (lower === 'alt' || lower === 'option') spec.alt = true;
    else spec.key = normalizeKey(token);
  }
  return spec;
}

function matches(event, spec) {
  const primary = spec.mod ? event.ctrlKey || event.metaKey : spec.ctrl === event.ctrlKey && spec.meta === event.metaKey;
  return primary && spec.shift === event.shiftKey && spec.alt === event.altKey && normalizeKey(event.key) === spec.key;
}

export function bindShortcuts(target, definitions, { scope = 'scope', ignoreEditable = true, signal = null } = {}) {
  const entries = definitions.map((definition) => ({ ...definition, parsed: parseCombo(definition.combo) }));
  const handler = async (event) => {
    if (event.defaultPrevented || (ignoreEditable && isEditableTarget(event.target))) return;
    for (const entry of entries) {
      if ((entry.when && !entry.when(event)) || !matches(event, entry.parsed)) continue;
      if (entry.preventDefault !== false) event.preventDefault();
      if (entry.stopPropagation) event.stopPropagation();
      try { await entry.handler(event); }
      catch (error) { console.error(`Shortcut ${entry.id || entry.combo} failed in ${scope}`, error); }
      return;
    }
  };
  target.addEventListener('keydown', handler, signal ? { signal } : undefined);
}

export function shortcutLabel(combo) {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  return String(combo)
    .replace(/Mod/gi, isMac ? '⌘' : 'Ctrl')
    .replace(/Shift/gi, isMac ? '⇧' : 'Shift')
    .replace(/Alt/gi, isMac ? '⌥' : 'Alt')
    .replace(/\+/g, isMac ? '' : '+');
}
