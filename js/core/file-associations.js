const SPECIFIC_PSP_NAMES = new Set([
  'EBOOT.BIN', 'BOOT.BIN', 'PARAM.SFO', 'UMD_DATA.BIN',
  'EBOOT.PBP', 'PBOOT.PBP', 'DATA.PSAR', 'ICON0.PNG',
  'ICON1.PMF', 'PIC0.PNG', 'PIC1.PNG', 'SND0.AT3'
]);

function baseName(name) {
  return String(name || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '';
}

export function extensionOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function associationKeys(name) {
  const base = baseName(name).toLowerCase();
  const ext = extensionOf(name);
  const keys = base ? [`name:${base}`] : [];
  if (ext) keys.push(`ext:${ext}`);
  return keys;
}

export function preferredAssociationKey(name, handlers = []) {
  const base = baseName(name);
  const upper = base.toUpperCase();
  const lower = base.toLowerCase();
  const hasExactHandler = handlers.some((handler) => handler.accepts.some((rule) => {
    const normalized = String(rule || '').trim().toLowerCase();
    return normalized && normalized !== '*' && !normalized.startsWith('.') && normalized === lower;
  }));
  if (base && (SPECIFIC_PSP_NAMES.has(upper) || hasExactHandler)) return `name:${lower}`;
  const ext = extensionOf(base);
  return ext ? `ext:${ext}` : `name:${lower}`;
}

export function associationLabel(key) {
  const value = String(key || 'this file type');
  if (value.startsWith('ext:')) return value.slice(4);
  if (value.startsWith('name:')) return value.slice(5);
  return value;
}
