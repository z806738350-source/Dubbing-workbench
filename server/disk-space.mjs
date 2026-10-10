import { statfsSync, statSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './store.mjs';

export const DISK_SAFETY_BYTES = 256 * 1024 * 1024;
export const PAID_AUDIO_DISK_BYTES = 200 * 1024 * 1024;
// In-process reservations coordinate writes on the same filesystem. Other apps
// can still exhaust the disk; ENOSPC must retain the existing recovery evidence.
const reservations = new Map();
function space(directory) {
  let fs, device;
  try { fs = statfsSync(directory); device = statSync(directory).dev; }
  catch { fail('无法读取保存位置的可用空间，本次未写入或发送；请检查文件夹权限', 503,
    { code: 'disk-space-unavailable', diskSpace: true, retryClass: 'check-storage-and-resume' }); }
  const freeBytes = Number(fs.bavail) * Number(fs.bsize), reservedBytes = reservations.get(device) || 0;
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0)
    fail('保存位置的可用空间信息无效，本次未写入或发送', 503,
      { code: 'disk-space-unavailable', diskSpace: true, retryClass: 'check-storage-and-resume' });
  return { device, freeBytes, reservedBytes, safetyBytes: DISK_SAFETY_BYTES,
    availableBytes: Math.max(0, freeBytes - reservedBytes - DISK_SAFETY_BYTES) };
}
export function diskStatus(directory) { const { device, ...status } = space(directory); return status; }
export function reserveDiskSpace(directory, bytes, action = '本地操作') {
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail('写盘空间估算无效');
  const status = space(directory);
  if (bytes > status.availableBytes || status.freeBytes - status.reservedBytes < DISK_SAFETY_BYTES)
    fail(`保存位置空间不足，${action}尚未开始；整理资料或迁移后可继续`, 507,
      { code: 'disk-space-low', diskSpace: true, retryClass: 'free-space-and-resume', requiredBytes: bytes,
        freeBytes: status.freeBytes, reservedBytes: status.reservedBytes, safetyBytes: status.safetyBytes });
  reservations.set(status.device, status.reservedBytes + bytes);
  let released = false;
  return { release() {
    if (released) return;
    released = true;
    const remaining = (reservations.get(status.device) || 0) - bytes;
    if (remaining) reservations.set(status.device, remaining); else reservations.delete(status.device);
  } };
}
export function assertDiskSpace(directory, bytes = 0, action) {
  const lease = reserveDiskSpace(directory, bytes, action); lease.release();
}
export async function fileTreeBytes(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory()) return entry.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await fileTreeBytes(join(path, name));
  return bytes;
}
