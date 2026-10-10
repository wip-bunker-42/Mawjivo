const segmenter = new Intl.Segmenter('ar', { granularity: 'grapheme' });
export function imageFilename(originalName: string, originalMime: string, outputMime: string): string {
  if (originalMime === outputMime) return originalName;
  if (outputMime !== 'image/jpeg') throw new Error('UNSUPPORTED_IMAGE_OUTPUT');
  const dot = originalName.lastIndexOf('.');
  return (dot > 0 ? originalName.slice(0, dot) : originalName) + '.jpg';
}
export function videoFilename(title: string, extension: string): string {
  if (!title.trim()) throw new Error('VIDEO_TITLE_REQUIRED');
  const ext = extension.replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(ext)) throw new Error('INVALID_EXTENSION');
  let basename = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!basename) basename = 'فيديو';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename))
    basename = 'فيديو-' + basename;
  let safe = '';
  for (const { segment } of segmenter.segment(basename)) {
    if (safe.length + segment.length + ext.length + 1 > 180) break;
    safe += segment;
  }
  return safe.trimEnd().replace(/[. ]+$/g, '') + '.' + ext;
}
