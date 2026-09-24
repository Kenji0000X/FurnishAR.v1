/**
 * A same-site path, or null. The one rule behind every `next=`: a leading
 * "/", not "//", no backslash or control character (a browser reads
 * "/\evil" and "/<tab>/evil" as "//evil" — another site), and never the
 * sign-in machinery itself.
 */
export function safeLocalPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (/^\/(auth\/callback|api\/)/.test(trimmed)) return null;
  return trimmed.slice(0, 512);
}
