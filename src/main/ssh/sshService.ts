import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import * as net from 'net'
import { readFileSync, statSync, readdirSync, createReadStream, createWriteStream } from 'fs'
import { join, basename, relative, dirname, sep } from 'path'

export interface ConnectOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
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
  kind?: 'upload' | 'download'
}

/** 上传批次开始前列出的文件清单 */
export interface QueueEntry {
  name: string
  size: number
}

export interface ExecChunk {
  stream: 'stdout' | 'stderr'
  data: string
}

interface Session {
  conn: Client
}

// 以连接配置 id 为键，维持多个已建立的会话
const sessions = new Map<string, Session>()

export function isConnected(id: string): boolean {
  return sessions.has(id)
}

export async function connect(id: string, opts: ConnectOptions): Promise<void> {
  if (sessions.has(id)) await disconnect(id)

  const conn = new Client()
  const cfg: ConnectConfig = {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    keepaliveInterval: 15000,
    readyTimeout: 20000
  }
  if (opts.privateKeyPath) {
    cfg.privateKey = readFileSync(opts.privateKeyPath)
    if (opts.passphrase) cfg.passphrase = opts.passphrase
  } else if (opts.password) {
    cfg.password = opts.password
  }

  await new Promise<void>((resolve, reject) => {
    conn.once('ready', () => resolve())
    conn.once('error', (err: Error) => reject(err))
    conn.connect(cfg)
  })

  sessions.set(id, { conn })
}

export async function disconnect(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.conn.end()
  } catch {
    /* ignore */
  }
  sessions.delete(id)
}

function requireConn(id: string): Client {
  const s = sessions.get(id)
  if (!s) throw new Error('尚未连接到该服务器，请先连接')
  return s.conn
}

/** 供终端服务复用已建立的会话 */
export function requireClient(id: string): Client {
  return requireConn(id)
}

function openSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
  })
}

/** 判断远程路径是否为已存在目录；不存在返回 false */
function remoteDirExists(sftp: SFTPWrapper, p: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(p, (err, st) => {
      if (err || !st) return resolve(false)
      resolve(typeof st.isDirectory === 'function' ? st.isDirectory() : false)
    })
  })
}

function posixJoin(dir: string, file: string): string {
  if (!dir) return file
  return dir.endsWith('/') ? dir + file : dir + '/' + file
}

/** 远程递归创建目录（mkdir -p 语义），逐段累加，已存在则跳过 */
async function ensureRemoteDir(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const clean = dirPath.replace(/\/+$/, '')
  if (!clean) return
  const isAbs = clean.startsWith('/')
  const segments = clean.split('/').filter(Boolean)
  let cur = isAbs ? '' : '.'
  for (const seg of segments) {
    cur = cur === '' ? '/' + seg : posixJoin(cur, seg)
    if (await remoteDirExists(sftp, cur)) continue
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(cur, (err) => {
        // 目录已存在(EEXIST)忽略，其余报错上抛
        if (err) {
          const code = (err as { code?: number | string }).code
          if (code === 4 || code === 11 || code === 'EEXIST') return resolve()
          return reject(err)
        }
        resolve()
      })
    })
  }
}

function uploadOne(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  total: number,
  onBytes: (transferred: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = createReadStream(localPath)
    const writer = sftp.createWriteStream(remotePath)
    let transferred = 0
    reader.on('data', (chunk: Buffer | string) => {
      transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      onBytes(Math.min(transferred, total))
    })
    reader.on('error', reject)
    writer.on('error', reject)
    writer.on('close', () => resolve())
    reader.pipe(writer)
  })
}

interface FileJob {
  local: string
  rel: string
  size: number
}

/** 收集要上传的文件清单：文件直接入选；目录递归展开并保留相对路径（以目录名开头） */
function collectJobs(paths: string[]): FileJob[] {
  const jobs: FileJob[] = []
  for (const p of paths) {
    const st = statSync(p)
    if (st.isDirectory()) {
      const rootName = basename(p)
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry)
          const s = statSync(full)
          if (s.isDirectory()) walk(full)
          else
            jobs.push({
              local: full,
              rel: join(rootName, relative(p, full)).split(sep).join('/'),
              size: s.size
            })
        }
      }
      walk(p)
    } else {
      jobs.push({ local: p, rel: basename(p), size: st.size })
    }
  }
  return jobs
}

export async function listRemote(id: string, remotePath: string): Promise<RemoteEntry[]> {
  const conn = requireConn(id)
  const sftp = await openSftp(conn)
  try {
    const entries = await new Promise<
      { filename: string; attrs: { isDirectory?: () => boolean; size: number; mtime: number } }[]
    >((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list as never)))
    })
    return entries
      .map((e) => ({
        name: e.filename,
        path: posixJoin(remotePath, e.filename),
        directory: typeof e.attrs.isDirectory === 'function' ? e.attrs.isDirectory() : false,
        size: e.attrs.size ?? 0,
        mtime: (e.attrs.mtime ?? 0) * 1000
      }))
      .sort((a, b) => {
        if (a.directory !== b.directory) return a.directory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  } finally {
    sftp.end()
  }
}

export async function upload(
  id: string,
  localPaths: string[],
  remoteDir: string,
  onProgress: (p: UploadProgress) => void,
  onQueue?: (entries: QueueEntry[]) => void
): Promise<void> {
  const conn = requireConn(id)
  const sftp = await openSftp(conn)
  try {
    await ensureRemoteDir(sftp, remoteDir)
    const jobs = collectJobs(localPaths)
    onQueue?.(jobs.map((j) => ({ name: j.rel, size: j.size })))
    const count = jobs.length
    let index = 0
    for (const job of jobs) {
      index++
      const remotePath = posixJoin(remoteDir, job.rel)
      const parent = dirname(remotePath)
      if (parent && parent !== '.' && parent !== '/') await ensureRemoteDir(sftp, parent)
      await uploadOne(sftp, job.local, remotePath, job.size, (transferred) => {
        onProgress({ file: job.rel, transferred, total: job.size, index, count, done: false })
      })
      onProgress({ file: job.rel, transferred: job.size, total: job.size, index, count, done: true })
    }
  } finally {
    sftp.end()
  }
}

function sftpStat(sftp: SFTPWrapper, p: string): Promise<{ size: number; directory: boolean }> {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err, st) => {
      if (err || !st) return reject(err ?? new Error('无法获取文件信息: ' + p))
      resolve({
        size: st.size ?? 0,
        directory: typeof st.isDirectory === 'function' ? st.isDirectory() : false
      })
    })
  })
}

/** 下载单个远程文件到本地路径，流式回推进度 */
export async function download(
  id: string,
  remotePath: string,
  localPath: string,
  onProgress: (p: UploadProgress) => void
): Promise<void> {
  const conn = requireConn(id)
  const sftp = await openSftp(conn)
  try {
    const st = await sftpStat(sftp, remotePath)
    if (st.directory) throw new Error('不能直接下载目录，请进入目录后选择文件')
    const total = st.size
    await new Promise<void>((resolve, reject) => {
      const reader = sftp.createReadStream(remotePath)
      const writer = createWriteStream(localPath)
      let transferred = 0
      reader.on('data', (chunk: Buffer | string) => {
        transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        onProgress({
          file: basename(remotePath),
          transferred: Math.min(transferred, total),
          total,
          index: 1,
          count: 1,
          done: false,
          kind: 'download'
        })
      })
      reader.on('error', reject)
      writer.on('error', reject)
      writer.on('close', () => resolve())
      reader.pipe(writer)
    })
    onProgress({
      file: basename(remotePath),
      transferred: total,
      total,
      index: 1,
      count: 1,
      done: true,
      kind: 'download'
    })
  } finally {
    sftp.end()
  }
}

/** 递归删除远程路径（目录逐项深入后 rmdir，文件 unlink） */
export async function remoteDelete(id: string, path: string): Promise<void> {
  const conn = requireConn(id)
  const sftp = await openSftp(conn)
  try {
    const rm = async (p: string): Promise<void> => {
      const st = await sftpStat(sftp, p)
      if (!st.directory) {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(p, (err) => (err ? reject(err) : resolve()))
        })
        return
      }
      const entries = await new Promise<{ filename: string }[]>((resolve, reject) => {
        sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list)))
      })
      for (const e of entries) await rm(posixJoin(p, e.filename))
      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(p, (err) => (err ? reject(err) : resolve()))
      })
    }
    await rm(path)
  } finally {
    sftp.end()
  }
}

/** 重命名/移动（toPath 为完整目标路径） */
export async function remoteRename(id: string, fromPath: string, toPath: string): Promise<void> {
  const conn = requireConn(id)
  const sftp = await openSftp(conn)
  try {
    await new Promise<void>((resolve, reject) => {
      sftp.rename(fromPath, toPath, (err) => (err ? reject(err) : resolve()))
    })
  } finally {
    sftp.end()
  }
}

/** 新建远程目录（支持多级，mkdir -p 语义） */
export async function remoteMkdir(id: string, dirPath: string): Promise<void> {
  const conn = requireConn(id)
  const sftp = await openSftp(conn)
  try {
    await ensureRemoteDir(sftp, dirPath)
  } finally {
    sftp.end()
  }
}

/** 打开交互式 shell（pty），返回流 id；数据以 Buffer 交给回调，由 IPC 层决定编码 */
export async function openShell(
  id: string,
  cols: number,
  rows: number
): Promise<{ stream: ClientChannel; close: () => void }> {
  const conn = requireConn(id)
  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', rows, cols }, (err, s) => (err ? reject(err) : resolve(s)))
  })
  return { stream, close: () => stream.close() }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * 任务命令若以 `&` 结尾，表示要后台常驻（如启动 jar、nohup ...）。
 * SSH 对“后台进程仍占用会话”不会关闭通道，会导致界面永久卡在“等退出码”。
 * 这里统一用 setsid + </dev/null 让进程彻底脱离会话，命令即可即时返回。
 * 普通命令（不以 & 结尾）原样执行，正常回显输出与退出码。
 */
function buildCommand(command: string): { cmd: string; detached: boolean } {
  const t = command.trim()
  if (!/&$/.test(t)) return { cmd: command, detached: false }
  const inner = t.replace(/&+$/, '').trim()
  if (!inner) return { cmd: command, detached: false }
  return { cmd: `setsid bash -c ${shellQuote(inner)} </dev/null >/dev/null 2>&1 &`, detached: true }
}

export function exec(id: string, command: string, onData: (c: ExecChunk) => void): Promise<number> {
  const conn = requireConn(id)
  const { cmd, detached } = buildCommand(command)
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let done = false
      let timer: NodeJS.Timeout | undefined
      const finish = (code: number): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        resolve(code)
      }
      if (detached) {
        // 后台命令已脱离会话，正常 1~2s 内应返回；兜底：8s 未收到关闭则视为已后台启动
        timer = setTimeout(() => {
          onData({ stream: 'stdout', data: '[SFTPulse] 后台命令已发出，按启动成功处理\n' })
          try {
            stream.close()
          } catch {
            /* ignore */
          }
          finish(0)
        }, 8000)
      }
      stream.on('data', (buf: Buffer) => onData({ stream: 'stdout', data: buf.toString('utf-8') }))
      stream.stderr.on('data', (buf: Buffer) => onData({ stream: 'stderr', data: buf.toString('utf-8') }))
      stream.on('close', (code: number | null) => finish(code ?? 0))
      stream.on('error', (e: Error) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        reject(e)
      })
      stream.end() // 主动关闭 stdin，避免命令等待输入而挂住
    })
  })
}

export interface TunnelHandle {
  port: number
  close: () => void
}

/**
 * 经由已建立的 SSH 会话开一个本地端口转发：本地随机端口 -> (经 SSH 服务器) -> targetHost:targetPort。
 * 用于数据库不可直连（未开放 3306 / 在内网另一台机器）时，以 SSH 服务器为跳板访问。
 * targetHost 是“从 SSH 服务器视角”可达的地址（如 127.0.0.1 表示库就在 SSH 服务器上）。
 */
export function openTunnel(sshId: string, targetHost: string, targetPort: number): Promise<TunnelHandle> {
  const conn = requireConn(sshId)
  return new Promise((resolve, reject) => {
    const server = net.createServer((stream) => {
      stream.pause()
      conn.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, chan) => {
        if (err) {
          stream.destroy()
          return
        }
        stream.pipe(chan)
        chan.pipe(stream)
        stream.resume()
        chan.on('error', () => stream.destroy())
        stream.on('error', () => chan.destroy())
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({
        port: addr.port,
        close: () => {
          try {
            server.close()
          } catch {
            /* ignore */
          }
        }
      })
    })
  })
}
