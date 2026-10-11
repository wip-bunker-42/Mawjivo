export async function publishDownloads(objects, control) {
  const missing = [];
  for (const object of objects) {
    const existing = await control.inspect(object);
    if (existing && existing.sha256 !== object.sha256) throw new Error('DOWNLOADS_IMMUTABLE');
    if (!existing) missing.push(object);
  }
  for (const object of missing) await control.upload(object);
}
