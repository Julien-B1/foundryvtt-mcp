/**
 * Uploads an asset (image, audio, etc.) to FoundryVTT's storage via FilePicker.
 *
 * @param {{ targetDir: string; filename: string; contentBase64: string; mimeType?: string }} params
 */
export async function uploadAsset(params) {
  const { targetDir, filename, contentBase64, mimeType = 'application/octet-stream' } = params;
  if (!targetDir || !filename || !contentBase64) {
    throw new Error('targetDir, filename, and contentBase64 are required');
  }

  // Decode base64 to binary
  const binaryString = atob(contentBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
  // Taverne: create the target folder (and its parents) when missing.
  let dir = '';
  for (const part of targetDir.split('/').filter(Boolean)) {
    dir = dir ? `${dir}/${part}` : part;
    try { await FP.createDirectory('data', dir, {}); } catch { /* exists */ }
  }

  const file = new File([bytes], filename, { type: mimeType });
  const result = await FP.upload('data', targetDir, file, {}, { notify: false });

  return {
    path: result.path,
  };
}
