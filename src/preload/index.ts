import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ConnectionProfile,
  ConnectionInput,
  RemoteEntry,
  UploadProgress,
  ExecChunk,
  QueueEntry,
  Task,
  TaskGroup,
  TaskEvent,
  DbConnection,
  DbSyncOptions,
  DbSyncEvent
} from '../main/types'

/** 暴露给渲染进程的安全 API（白名单式，不直接透出 ipcRenderer / Node） */
const api = {
  listConnections: (): Promise<ConnectionProfile[]> => ipcRenderer.invoke('conn:list'),
  saveConnection: (input: ConnectionInput): Promise<ConnectionProfile[]> =>
    ipcRenderer.invoke('conn:save', input),
  deleteConnection: (id: string): Promise<ConnectionProfile[]> => ipcRenderer.invoke('conn:delete', id),

  connect: (id: string): Promise<boolean> => ipcRenderer.invoke('conn:connect', id),
  disconnect: (id: string): Promise<boolean> => ipcRenderer.invoke('conn:disconnect', id),
  status: (id: string): Promise<boolean> => ipcRenderer.invoke('conn:status', id),

  /** 置顶窗口（钉子）：返回设置后的状态 */
  setPin: (pinned: boolean): Promise<boolean> => ipcRenderer.invoke('win:setPin', pinned),

  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFiles'),
  pickDir: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickDir'),
  pickPrivateKey: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickPrivateKey'),

  /** 拖拽上传：把渲染进程的 File 对象换成本地绝对路径（Electron 官方推荐用法） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  listRemote: (id: string, path: string): Promise<RemoteEntry[]> =>
    ipcRenderer.invoke('sftp:list', { id, path }),
  upload: (id: string, localPaths: string[], remoteDir: string): Promise<void> =>
    ipcRenderer.invoke('sftp:upload', { id, localPaths, remoteDir }),
  /** 弹出另存为对话框并下载，返回保存路径；用户取消返回 null */
  download: (id: string, remotePath: string): Promise<string | null> =>
    ipcRenderer.invoke('sftp:download', { id, remotePath }),
  deleteRemote: (id: string, path: string): Promise<void> => ipcRenderer.invoke('sftp:delete', { id, path }),
  renameRemote: (id: string, fromPath: string, toPath: string): Promise<void> =>
    ipcRenderer.invoke('sftp:rename', { id, fromPath, toPath }),
  mkdirRemote: (id: string, path: string): Promise<void> => ipcRenderer.invoke('sftp:mkdir', { id, path }),

  exec: (id: string, command: string): Promise<number> => ipcRenderer.invoke('ssh:exec', { id, command }),

  // ---------- 交互式终端 ----------
  termOpen: (connId: string, cols: number, rows: number): Promise<string> =>
    ipcRenderer.invoke('term:open', { connId, cols, rows }),
  termWrite: (termId: string, dataBase64: string): Promise<void> =>
    ipcRenderer.invoke('term:write', { termId, dataBase64 }),
  termResize: (termId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('term:resize', { termId, cols, rows }),
  termClose: (termId: string): Promise<void> => ipcRenderer.invoke('term:close', termId),

  // ---------- 一键任务 ----------
  listTasks: (): Promise<Task[]> => ipcRenderer.invoke('task:list'),
  saveTask: (task: Task): Promise<Task[]> => ipcRenderer.invoke('task:save', task),
  deleteTask: (id: string): Promise<Task[]> => ipcRenderer.invoke('task:delete', id),
  /** 返回失败命令条数（ 0 = 全部成功） */
  runTask: (id: string): Promise<number> => ipcRenderer.invoke('task:run', id),

  // ---------- 任务流程（大任务） ----------
  listGroups: (): Promise<TaskGroup[]> => ipcRenderer.invoke('group:list'),
  saveGroup: (group: TaskGroup): Promise<TaskGroup[]> => ipcRenderer.invoke('group:save', group),
  deleteGroup: (id: string): Promise<TaskGroup[]> => ipcRenderer.invoke('group:delete', id),
  runGroup: (id: string): Promise<void> => ipcRenderer.invoke('group:run', id),

  // ---------- 数据库连接与同步 ----------
  listDatabases: (): Promise<DbConnection[]> => ipcRenderer.invoke('db:list'),
  saveDatabase: (input: DbConnection): Promise<DbConnection[]> => ipcRenderer.invoke('db:save', input),
  deleteDatabase: (id: string): Promise<DbConnection[]> => ipcRenderer.invoke('db:delete', id),
  testDatabase: (id: string): Promise<string> => ipcRenderer.invoke('db:test', id),
  listDbNames: (input: DbConnection): Promise<string[]> => ipcRenderer.invoke('db:databases', input),
  listDbTables: (id: string): Promise<string[]> => ipcRenderer.invoke('db:tables', id),
  syncDatabase: (opts: DbSyncOptions): Promise<number> => ipcRenderer.invoke('db:sync', opts),

  onProgress: (cb: (p: UploadProgress) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, p: UploadProgress): void => cb(p)
    ipcRenderer.on('sftp:progress', handler)
    return () => ipcRenderer.removeListener('sftp:progress', handler)
  },
  onQueue: (cb: (entries: QueueEntry[]) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, entries: QueueEntry[]): void => cb(entries)
    ipcRenderer.on('sftp:queue', handler)
    return () => ipcRenderer.removeListener('sftp:queue', handler)
  },
  onExecData: (cb: (c: ExecChunk) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, c: ExecChunk): void => cb(c)
    ipcRenderer.on('ssh:exec-data', handler)
    return () => ipcRenderer.removeListener('ssh:exec-data', handler)
  },
  onTermData: (cb: (payload: { termId: string; data: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: { termId: string; data: string }): void => cb(payload)
    ipcRenderer.on('term:data', handler)
    return () => ipcRenderer.removeListener('term:data', handler)
  },
  onTermExit: (cb: (payload: { termId: string }) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, payload: { termId: string }): void => cb(payload)
    ipcRenderer.on('term:exit', handler)
    return () => ipcRenderer.removeListener('term:exit', handler)
  },
  onTaskEvent: (cb: (ev: TaskEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, ev: TaskEvent): void => cb(ev)
    ipcRenderer.on('task:event', handler)
    return () => ipcRenderer.removeListener('task:event', handler)
  },
  onDbSyncEvent: (cb: (ev: DbSyncEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, ev: DbSyncEvent): void => cb(ev)
    ipcRenderer.on('db:sync-event', handler)
    return () => ipcRenderer.removeListener('db:sync-event', handler)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
