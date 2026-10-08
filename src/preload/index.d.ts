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

export interface SftpulseApi {
  listConnections: () => Promise<ConnectionProfile[]>
  saveConnection: (input: ConnectionInput) => Promise<ConnectionProfile[]>
  deleteConnection: (id: string) => Promise<ConnectionProfile[]>
  connect: (id: string) => Promise<boolean>
  disconnect: (id: string) => Promise<boolean>
  status: (id: string) => Promise<boolean>
  setPin: (pinned: boolean) => Promise<boolean>
  pickFiles: () => Promise<string[]>
  pickDir: () => Promise<string[]>
  pickPrivateKey: () => Promise<string | null>
  getPathForFile: (file: File) => string
  listRemote: (id: string, path: string) => Promise<RemoteEntry[]>
  upload: (id: string, localPaths: string[], remoteDir: string) => Promise<void>
  download: (id: string, remotePath: string) => Promise<string | null>
  deleteRemote: (id: string, path: string) => Promise<void>
  renameRemote: (id: string, fromPath: string, toPath: string) => Promise<void>
  mkdirRemote: (id: string, path: string) => Promise<void>
  exec: (id: string, command: string) => Promise<number>
  termOpen: (connId: string, cols: number, rows: number) => Promise<string>
  termWrite: (termId: string, dataBase64: string) => Promise<void>
  termResize: (termId: string, cols: number, rows: number) => Promise<void>
  termClose: (termId: string) => Promise<void>
  listTasks: () => Promise<Task[]>
  saveTask: (task: Task) => Promise<Task[]>
  deleteTask: (id: string) => Promise<Task[]>
  runTask: (id: string) => Promise<number>
  listGroups: () => Promise<TaskGroup[]>
  saveGroup: (group: TaskGroup) => Promise<TaskGroup[]>
  deleteGroup: (id: string) => Promise<TaskGroup[]>
  runGroup: (id: string) => Promise<void>
  listDatabases: () => Promise<DbConnection[]>
  saveDatabase: (input: DbConnection) => Promise<DbConnection[]>
  deleteDatabase: (id: string) => Promise<DbConnection[]>
  testDatabase: (id: string) => Promise<string>
  listDbNames: (input: DbConnection) => Promise<string[]>
  listDbTables: (id: string) => Promise<string[]>
  syncDatabase: (opts: DbSyncOptions) => Promise<number>
  onProgress: (cb: (p: UploadProgress) => void) => () => void
  onQueue: (cb: (entries: QueueEntry[]) => void) => () => void
  onExecData: (cb: (c: ExecChunk) => void) => () => void
  onTermData: (cb: (payload: { termId: string; data: string }) => void) => () => void
  onTermExit: (cb: (payload: { termId: string }) => void) => () => void
  onTaskEvent: (cb: (ev: TaskEvent) => void) => () => void
  onDbSyncEvent: (cb: (ev: DbSyncEvent) => void) => () => void
}

declare global {
  interface Window {
    electron: typeof electronAPI
    api: SftpulseApi
  }
}

export {}
