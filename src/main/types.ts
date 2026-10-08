/**
 * 跨进程共享类型集中定义。
 * 主进程内部实现（vault / sshService）沿用各自定义，此处统一对外（preload / renderer）导出，
 * 避免渲染进程直接依赖主进程实现文件。
 */
export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privatekey'
  privateKeyPath?: string
  remoteDir?: string
}

export interface ConnectionInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privatekey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  remoteDir?: string
}

export interface RemoteEntry {
  name: string
  path: string
  directory: boolean
  size: number
  mtime: number
}

export interface UploadProgress {
  file: string
  transferred: number
  total: number
  index: number
  count: number
  done: boolean
  /** 缺省视为 upload；download 用于回推下载进度 */
  kind?: 'upload' | 'download'
}

export interface ExecChunk {
  stream: 'stdout' | 'stderr'
  data: string
}

/** 一次传输批次的文件清单条目（上传队列） */
export interface QueueEntry {
  name: string
  size: number
}

/** 一键任务：把“传这些文件 + 跑这些命令”固化为一个可保存、可重复运行的按钮 */
export interface Task {
  id: string
  name: string
  /** 绑定的连接配置 id，运行时若未连接会自动连接 */
  connId: string
  localPaths: string[]
  remoteDir: string
  commands: string[]
}

/** 任务组（大任务/部署流程）：按顺序依次执行多个小任务，任一失败即中止 */
export interface TaskGroup {
  id: string
  name: string
  taskIds: string[]
}

/** 任务运行期间主进程流式回推的事件 */
export type TaskEvent =
  | { taskId: string; kind: 'log'; text: string }
  | { taskId: string; kind: 'queue'; entries: QueueEntry[] }
  | { taskId: string; kind: 'progress'; p: UploadProgress }
  | { taskId: string; kind: 'exec'; command: string; chunk: ExecChunk }

/**
 * 数据库连接配置（MySQL/MariaDB）。
 * host/port 可为任意地址（本机、远程、另一台内网机器）；
 * 若填了 sshConnId，则经由该已保存的 SSH 连接开本地端口隧道去访问数据库（无需开放 3306）。
 */
export interface DbConnection {
  id: string
  name: string
  host: string
  port: number
  user: string
  password?: string
  database: string
  /** 可选：经由哪条 SSH 连接做隧道（数据库不可直连时使用） */
  sshConnId?: string
}

/** 同步选项：结构/数据分别可选，支持目标已存在时先删除、同步数据前清空 */
export interface DbSyncOptions {
  sourceId: string
  targetId: string
  tables: string[]
  structure: boolean
  data: boolean
  dropExisting: boolean
  truncateBeforeInsert: boolean
}

/** 数据库同步过程主进程流式回推的事件 */
export type DbSyncEvent =
  | { kind: 'log'; text: string }
  | { kind: 'table'; table: string; index: number; count: number; rowsDone: number; rowsTotal: number; phase: string }
