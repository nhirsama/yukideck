import { request } from '@/core/api';
import { computeSha256Hex, getExtension, stripImageMetadata } from './metadata';

export type UploadMode = 'direct' | 'proxy';

export interface StorageConfig {
  configured: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  access_key: string;
  has_secret_key: boolean;
  secret_key_masked: string;
  public_base_url: string;
  hash_length: number;
  force_path_style: boolean;
  upload_mode: UploadMode;
  proxy_max_mb: number;
}

export interface SaveStorageConfigPayload {
  endpoint: string;
  region: string;
  bucket: string;
  access_key: string;
  secret_key: string;
  public_base_url: string;
  hash_length: number;
  force_path_style: boolean;
  upload_mode: UploadMode;
}

export interface FolderEntry {
  name: string;
  prefix: string;
}

export interface FileEntry {
  key: string;
  name: string;
  size: number;
  uploaded: string;
  content_type: string;
  url: string;
  is_image: boolean;
  metadata_stripped: boolean;
}

export interface DirectoryListing {
  prefix: string;
  base_url: string;
  folders: FolderEntry[];
  files: FileEntry[];
  truncated: boolean;
  cursor?: string;
}

export interface PathItem {
  type: 'file' | 'folder';
  path: string;
}

interface PresignResponse {
  url: string;
  method: string;
  headers: Record<string, string>;
  file: FileEntry;
}

export const storageApi = {
  getConfig: () => request<{ config: StorageConfig }>('/api/v1/storage/config'),
  saveConfig: (payload: SaveStorageConfigPayload) =>
    request<{ config: StorageConfig }>('/api/v1/storage/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  testConfig: () => request<{ ok: boolean }>('/api/v1/storage/config/test', { method: 'POST' }),

  list: (prefix = '', cursor = '') => {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    return request<DirectoryListing>(`/api/v1/storage/list${qs ? `?${qs}` : ''}`);
  },
  listFolders: (prefix = '') => {
    const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return request<{ prefix: string; folders: FolderEntry[] }>(`/api/v1/storage/folders${qs}`);
  },
  createFolder: (path: string) =>
    request<{ ok: boolean; folder: FolderEntry }>('/api/v1/storage/folder', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  rename: (type: 'file' | 'folder', oldPath: string, newPath: string) =>
    request<{ ok: boolean; oldPath: string; newPath: string; movedCount: number; url?: string }>(
      '/api/v1/storage/rename',
      {
        method: 'POST',
        body: JSON.stringify({ type, oldPath, newPath }),
      },
    ),
  move: (items: PathItem[], targetFolder: string) =>
    request<{ ok: boolean; movedCount: number }>('/api/v1/storage/move', {
      method: 'POST',
      body: JSON.stringify({ items, targetFolder }),
    }),
  remove: (items: PathItem[]) =>
    request<{ ok: boolean; deletedCount: number }>('/api/v1/storage/delete', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  /**
   * Uploads a file respecting the user's configured upload_mode:
   * - direct: browser strips EXIF & computes SHA-256 -> presigned PUT straight to S3/R2 (NO size cap).
   * - proxy: checks server proxy_max_mb -> browser strips EXIF -> uploads via Go backend.
   */
  async uploadFile(file: File, folder: string, cfg: StorageConfig): Promise<FileEntry> {
    if (cfg.upload_mode === 'proxy' && file.size > cfg.proxy_max_mb * 1024 * 1024) {
      throw new Error(`中转模式下单文件不能超过服务器安全上限 (${cfg.proxy_max_mb} MB)，大文件请切换为直传模式`);
    }

    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const { data: cleanBytes, stripped } = stripImageMetadata(rawBytes);
    const contentType = file.type || 'application/octet-stream';

    if (cfg.upload_mode === 'direct') {
      const fullHash = await computeSha256Hex(cleanBytes);
      const hashLen = Math.min(64, Math.max(8, cfg.hash_length || 16));
      const ext = getExtension(file.name, contentType);
      const hashedName = `${fullHash.slice(0, hashLen)}${ext}`;

      const presigned = await request<PresignResponse>('/api/v1/storage/presign', {
        method: 'POST',
        body: JSON.stringify({
          folder,
          file_name: hashedName,
          content_type: contentType,
          sha256: fullHash,
          stripped,
        }),
      });

      const putRes = await fetch(presigned.url, {
        method: presigned.method || 'PUT',
        headers: presigned.headers,
        body: cleanBytes,
      });
      if (!putRes.ok) {
        throw new Error(`直传对象存储失败 (${putRes.status})，请检查存储桶 CORS 配置`);
      }
      return { ...presigned.file, size: cleanBytes.byteLength };
    }

    // Proxy mode
    const form = new FormData();
    form.append('file', new Blob([cleanBytes], { type: contentType }), file.name || 'upload.bin');
    form.append('folder', folder);
    form.append('stripped', String(stripped));
    const res = await request<{ ok: boolean; file: FileEntry }>('/api/v1/storage/upload', {
      method: 'POST',
      headers: { 'X-Metadata-Stripped': String(stripped) },
      body: form,
    });
    return res.file;
  },
};
