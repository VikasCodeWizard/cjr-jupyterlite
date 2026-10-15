import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { PageConfig } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import type { Contents } from '@jupyterlab/services';

const VIEW_PREFIX = '.cjr-view';
const OWNER_STORAGE_KEY = 'cjr-jupyter-owner';
const MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;

interface LabInitPayload {
  apiBaseUrl: string;
  authToken: string;
  initialProjectId?: string;
}

interface NotebookRow {
  jn_id: string;
  jn_path: string;
  jn_title: string;
  jn_user_id: number;
  jn_data_key: string;
  jn_content_hash: string;
  download_url?: string;
  jn_updated_at: string;
}

const fnv1a = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const isNotebookPath = (path: string) => /\.ipynb$/i.test(path);
const isViewPath = (path: string) => path === VIEW_PREFIX || path.startsWith(`${VIEW_PREFIX}/`);
const isUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
const titleFromPath = (path: string) => (path.split('/').pop() || path).replace(/\.ipynb$/i, '') || 'Untitled';

const parentOrigins = (): string[] => {
  const raw = PageConfig.getOption('cjrParentOrigins');
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return raw
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
};

const userIdFromToken = (token: string): string | null => {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
    return claims.user_id !== undefined ? String(claims.user_id) : null;
  } catch {
    return null;
  }
};

const storage = {
  get: (key: string) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // storage blocked: the owner check runs again next time
    }
  },
};

class NotebookApi {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  private async request<T>(method: string, query: Record<string, string> | null, body?: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/jupyter/notebook`);
    Object.entries(query ?? {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data?.message || `Request failed (${res.status})`);
    return data as T;
  }

  list = async () => (await this.request<{ data: NotebookRow[] }>('GET', null)).data ?? [];
  get = async (id: string) => (await this.request<{ data: NotebookRow[] }>('GET', { jn_id: id })).data?.[0] ?? null;
  create = async (path: string) => (await this.request<{ data: NotebookRow }>('POST', null, { jn_path: path, jn_title: titleFromPath(path) })).data;
  move = (row: NotebookRow, path: string) => this.request('PATCH', null, { jn_id: row.jn_id, jn_path: path, jn_title: titleFromPath(path) });
  remove = (row: NotebookRow) => this.request('DELETE', { jn_id: row.jn_id });

  async upload(row: NotebookRow, json: string, hash: string) {
    const res = await this.request<{ upload_url?: string }>('PATCH', null, {
      jn_id: row.jn_id,
      jn_path: row.jn_path,
      jn_title: titleFromPath(row.jn_path),
      jn_content_hash: hash,
      jn_data_key: row.jn_data_key || 'notebook',
    });
    if (!res.upload_url) throw new Error('The server did not return an upload URL.');
    const put = await fetch(res.upload_url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  }

  async download(row: NotebookRow): Promise<unknown | null> {
    if (!row.download_url) return null;
    const res = await fetch(row.download_url, { cache: 'no-store' });
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return res.json();
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlite/cjr-bridge-extension:plugin',
  description: 'Saves notebooks to the CodingJr student account using the LAB_READY / LAB_INIT handshake.',
  autoStart: true,
  optional: [IDocumentManager],
  activate: (app: JupyterFrontEnd, docManager: IDocumentManager | null) => {
    if (window.parent === window) return;
    const origins = parentOrigins();
    if (origins.length === 0) return;

    const contents = app.serviceManager.contents;
    const knownHash = new Map<string, string>();
    const rows = new Map<string, NotebookRow>();
    const savedBeforeInit = new Set<string>();
    let api: NotebookApi | null = null;
    let queue: Promise<void> = Promise.resolve();
    let initStarted = false;
    let quiet = 0;
    let dirLock: Promise<void> = Promise.resolve();

    const warn = (message: string) => Notification.error(message, { autoClose: 8000 });

    const enqueue = (job: () => Promise<void>) => {
      queue = queue.then(job).catch((e) => {
        warn(`Could not save to your account: ${e instanceof Error ? e.message : e}`);
      });
      return queue;
    };

    const withQuiet = async <T>(job: () => Promise<T>): Promise<T> => {
      quiet++;
      try {
        return await job();
      } finally {
        quiet--;
      }
    };

    const listAll = async (dir = ''): Promise<Contents.IModel[]> => {
      const model = await contents.get(dir, { content: true });
      const out: Contents.IModel[] = [];
      for (const item of (model.content as Contents.IModel[]) ?? []) {
        if (item.type === 'directory') out.push(item, ...(await listAll(item.path)));
        else out.push(item);
      }
      return out;
    };

    const ensureDirs = async (path: string) => {
      let current = '';
      for (const part of path.split('/').slice(0, -1)) {
        const next = current ? `${current}/${part}` : part;
        try {
          await contents.get(next, { content: false });
        } catch {
          const created = await contents.newUntitled({ path: current, type: 'directory' });
          await contents.rename(created.path, next);
        }
        current = next;
      }
    };

    const seed = async (path: string, content: unknown) => {
      knownHash.set(path, fnv1a(JSON.stringify(content)));
      dirLock = dirLock.then(() => withQuiet(() => ensureDirs(path))).catch(() => undefined);
      await dirLock;
      await contents.save(path, { type: 'notebook', format: 'json', content });
      const widget = docManager?.findWidget(path);
      const context = widget ? docManager?.contextForWidget(widget) : undefined;
      if (context) await context.revert();
    };

    const upload = (path: string, content?: unknown, force = false) =>
      enqueue(async () => {
        if (!api) return;
        const body = content ?? (await contents.get(path, { content: true, type: 'notebook' })).content;
        const json = JSON.stringify(body);
        const size = new Blob([json]).size;
        if (size > MAX_NOTEBOOK_BYTES) {
          warn(`"${titleFromPath(path)}" is ${(size / 1048576).toFixed(1)} MB, over the 10 MB limit, so it was not saved to your account. Clear large outputs and save again.`);
          return;
        }
        const hash = fnv1a(json);
        if (!force && knownHash.get(path) === hash) return;
        let row = rows.get(path);
        if (!row) {
          row = await api.create(path);
          rows.set(path, row);
        }
        if (row.jn_content_hash !== hash) {
          await api.upload(row, json, hash);
          rows.set(path, { ...row, jn_content_hash: hash, jn_updated_at: new Date().toISOString() });
        }
        knownHash.set(path, hash);
      });

    const renameRows = (oldPath: string, newPath: string) =>
      enqueue(async () => {
        if (!api) return;
        for (const [p, row] of Array.from(rows.entries()).filter(([p]) => isUnder(p, oldPath))) {
          const target = newPath + p.slice(oldPath.length);
          await api.move(row, target);
          rows.delete(p);
          rows.set(target, { ...row, jn_path: target });
        }
      });

    const deleteRows = (path: string) =>
      enqueue(async () => {
        if (!api) return;
        for (const [p, row] of Array.from(rows.entries()).filter(([p]) => isUnder(p, path))) {
          await api.remove(row);
          rows.delete(p);
        }
      });

    const openViewCopy = async (client: NotebookApi, projectId: string) => {
      const row = await client.get(projectId);
      const content = row ? await client.download(row) : null;
      if (!row || !content) {
        warn('This notebook could not be opened. It may have been deleted.');
        return;
      }
      const path = rows.get(row.jn_path)?.jn_id === row.jn_id ? row.jn_path : `${VIEW_PREFIX}/${row.jn_id}/${row.jn_path.split('/').pop()}`;
      if (isViewPath(path)) await seed(path, content);
      await app.commands.execute('docmanager:open', { path });
    };

    const isBeingEdited = (path: string) => {
      const widget = docManager?.findWidget(path);
      return !!(widget && docManager?.contextForWidget(widget)?.model.dirty);
    };

    const reconcile = async (client: NotebookApi, ownerKey: string, initialProjectId?: string) => {
      api = client;
      const storedOwner = storage.get(OWNER_STORAGE_KEY);

      if (storedOwner && storedOwner !== ownerKey) {
        await docManager?.closeAll();
        await withQuiet(async () => {
          for (const item of ((await contents.get('', { content: true })).content as Contents.IModel[]) ?? []) {
            await contents.delete(item.path);
          }
        });
        knownHash.clear();
        savedBeforeInit.clear();
      }
      storage.set(OWNER_STORAGE_KEY, ownerKey);

      const local = new Map<string, { lastModified: string; hash: string }>();
      for (const file of await listAll().catch(() => [] as Contents.IModel[])) {
        if (file.type !== 'notebook' || isViewPath(file.path)) continue;
        const model = await contents.get(file.path, { content: true, type: 'notebook' }).catch(() => null);
        if (!model) continue;
        const hash = fnv1a(JSON.stringify(model.content));
        knownHash.set(file.path, hash);
        local.set(file.path, { lastModified: model.last_modified, hash });
      }

      const serverRows = await client.list();
      serverRows.forEach((r) => rows.set(r.jn_path, r));

      const toDownload: NotebookRow[] = [];
      const toUpload: string[] = [];
      serverRows.forEach((row) => {
        const mine = local.get(row.jn_path);
        if (!mine) return toDownload.push(row);
        if (mine.hash === row.jn_content_hash) return;
        if (new Date(row.jn_updated_at).getTime() >= new Date(mine.lastModified).getTime()) toDownload.push(row);
        else toUpload.push(row.jn_path);
      });
      if (storedOwner === ownerKey) local.forEach((_, path) => !rows.has(path) && toUpload.push(path));

      let next = 0;
      let failed = 0;
      const worker = async () => {
        while (next < toDownload.length) {
          const row = toDownload[next++];
          try {
            const content = await client.download(row);
            if (!content || isBeingEdited(row.jn_path)) continue;
            const before = local.get(row.jn_path);
            if (before) {
              const now = await contents.get(row.jn_path, { content: false }).catch(() => null);
              if (now && now.last_modified !== before.lastModified) continue;
            }
            await seed(row.jn_path, content);
          } catch {
            failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, toDownload.length) }, worker));
      if (failed > 0) warn(`${failed} saved notebook(s) could not be loaded from your account. Reload to try again.`);

      toUpload.forEach((path) => void upload(path, undefined, true));
      savedBeforeInit.forEach((path) => void upload(path));
      savedBeforeInit.clear();

      if (initialProjectId) await openViewCopy(client, initialProjectId);
    };

    const init = ({ apiBaseUrl, authToken, initialProjectId }: LabInitPayload) => {
      const owner = userIdFromToken(authToken);
      if (!apiBaseUrl || !authToken || !owner) {
        initStarted = false;
        return;
      }
      const client = new NotebookApi(apiBaseUrl, authToken);
      const ownerKey = fnv1a(`cjr-jupyter-owner:${owner}`);
      queue = queue.then(async () => {
        try {
          await reconcile(client, ownerKey, initialProjectId);
        } catch (e) {
          api = null;
          rows.clear();
          initStarted = false;
          warn(`Could not load your notebooks: ${e instanceof Error ? e.message : e}`);
        }
      });
    };

    contents.fileChanged.connect((_, change) => {
      if (quiet > 0 && change.type !== 'save') return;
      const oldPath = change.oldValue?.path ?? '';
      const newPath = change.newValue?.path ?? '';

      if (change.type === 'save' && newPath && isNotebookPath(newPath) && !isViewPath(newPath)) {
        if (!api) savedBeforeInit.add(newPath);
        else void upload(newPath, change.newValue?.content ?? undefined);
      } else if (change.type === 'rename' && oldPath && newPath && !isViewPath(oldPath) && !isViewPath(newPath)) {
        Array.from(knownHash.keys())
          .filter((p) => isUnder(p, oldPath))
          .forEach((p) => {
            knownHash.set(newPath + p.slice(oldPath.length), knownHash.get(p) as string);
            knownHash.delete(p);
          });
        void renameRows(oldPath, newPath);
      } else if (change.type === 'delete' && oldPath && !isViewPath(oldPath)) {
        Array.from(knownHash.keys())
          .filter((p) => isUnder(p, oldPath))
          .forEach((p) => knownHash.delete(p));
        void deleteRows(oldPath);
      }
    });

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window.parent || !origins.includes(event.origin)) return;
      const data = event.data as { type?: string; payload?: LabInitPayload } | null;
      if (!data || data.type !== 'LAB_INIT' || !data.payload || initStarted) return;
      initStarted = true;
      init(data.payload);
    });

    void app.restored.then(() => {
      origins.forEach((origin) => window.parent.postMessage({ type: 'LAB_READY' }, origin));
    });
  },
};

export default plugin;
