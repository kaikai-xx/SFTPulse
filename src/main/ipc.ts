import { ipcMain, dialog, BrowserWindow } from 'electron'
import { basename } from 'path'
import * as vault from './vault'
import * as ssh from './ssh/sshService'
import * as term from './ssh/terminalService'
import * as tasks from './tasksStore'
import * as dbStore from './dbStore'
import * as dbSync from './dbSync'
import { runTask, runGroup } from './taskRunner'
import type { Task, TaskGroup, DbConnection, DbSyncOptions } from './types'

/**
 * 集中注册所有 IPC 处理器。
 * 渲染进程通过 preload 暴露的 window.api 调用，永远拿不到密码明文。
 */
export function registerIpcHandlers(): void {
  const send = (e: Electron.IpcMainInvokeEvent, channel: string, payload: unknown): void => {
    BrowserWindow.fromWebContents(e.sender)?.webContents.send(channel, payload)
  }

  // ---------- 连接配置管理 ----------
  ipcMain.handle('conn:list', () => vault.listConnections())
  ipcMain.handle('conn:save', (_e, input: vault.ConnectionInput) => {
    vault.upsertConnection(input)
    return vault.listConnections()
  })
  ipcMain.handle('conn:delete', (_e, id: string) => {
    vault.deleteConnection(id)
    return vault.listConnections()
  })

  // ---------- 连接 / 断开 ----------
  ipcMain.handle('conn:connect', async (_e, id: string) => {
    const prof = vault.getProfile(id)
    if (!prof) throw new Error('连接不存在')
    const secrets = vault.getSecrets(id)
    await ssh.connect(id, {
      host: prof.host,
      port: prof.port,
      username: prof.username,
      password: secrets.password,
      privateKeyPath: prof.privateKeyPath,
      passphrase: secrets.passphrase
    })
    return true
  })
  ipcMain.handle('conn:disconnect', async (_e, id: string) => {
    term.closeByConn(id) // 连接断开时连带关闭其上的终端
    await ssh.disconnect(id)
    return true
  })
  ipcMain.handle('conn:status', (_e, id: string) => ssh.isConnected(id))

  // ---------- 窗口置顶（右上角钉子） ----------
  ipcMain.handle('win:setPin', (e, pinned: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.setAlwaysOnTop(pinned, 'floating')
    return pinned
  })

  // ---------- 本地文件选择对话框 ----------
  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('dialog:pickPrivateKey', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '私钥文件', extensions: ['*'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })

  // ---------- SFTP：列目录 / 上传（队列+进度） / 下载 / 删除 / 重命名 / 新建目录 ----------
  ipcMain.handle('sftp:list', (_e, args: { id: string; path: string }) =>
    ssh.listRemote(args.id, args.path)
  )
  ipcMain.handle('sftp:upload', (e, args: { id: string; localPaths: string[]; remoteDir: string }) =>
    ssh.upload(
      args.id,
      args.localPaths,
      args.remoteDir,
      (p) => send(e, 'sftp:progress', p),
      (entries) => send(e, 'sftp:queue', entries)
    )
  )
  ipcMain.handle('sftp:download', async (e, args: { id: string; remotePath: string }) => {
    const fileName = basename(args.remotePath)
    const r = await dialog.showSaveDialog({ defaultPath: fileName, title: '保存文件' })
    if (r.canceled || !r.filePath) return null
    await ssh.download(args.id, args.remotePath, r.filePath, (p) => send(e, 'sftp:progress', p))
    return r.filePath
  })
  ipcMain.handle('sftp:delete', (_e, args: { id: string; path: string }) =>
    ssh.remoteDelete(args.id, args.path)
  )
  ipcMain.handle('sftp:rename', (_e, args: { id: string; fromPath: string; toPath: string }) =>
    ssh.remoteRename(args.id, args.fromPath, args.toPath)
  )
  ipcMain.handle('sftp:mkdir', (_e, args: { id: string; path: string }) =>
    ssh.remoteMkdir(args.id, args.path)
  )

  // ---------- SSH 命令执行（输出流式回推） ----------
  ipcMain.handle('ssh:exec', (e, args: { id: string; command: string }) =>
    ssh.exec(args.id, args.command, (chunk) => send(e, 'ssh:exec-data', chunk))
  )

  // ---------- 交互式终端（xterm.js 对接的 pty 通道） ----------
  ipcMain.handle('term:open', (e, args: { connId: string; cols: number; rows: number }) =>
    term.open(
      args.connId,
      args.cols,
      args.rows,
      (termId, buf) => send(e, 'term:data', { termId, data: buf.toString('base64') }),
      (termId) => send(e, 'term:exit', { termId })
    )
  )
  ipcMain.handle('term:write', (_e, args: { termId: string; dataBase64: string }) => {
    term.write(args.termId, args.dataBase64)
  })
  ipcMain.handle('term:resize', (_e, args: { termId: string; cols: number; rows: number }) => {
    term.resize(args.termId, args.cols, args.rows)
  })
  ipcMain.handle('term:close', (_e, termId: string) => {
    term.close(termId)
  })

  // ---------- 一键任务 ----------
  ipcMain.handle('task:list', () => tasks.listTasks())
  ipcMain.handle('task:save', (_e, task: Task) => {
    tasks.upsertTask(task)
    return tasks.listTasks()
  })
  ipcMain.handle('task:delete', (_e, id: string) => {
    tasks.deleteTask(id)
    return tasks.listTasks()
  })
  ipcMain.handle('task:run', (e, id: string) =>
    runTask(id, (ev) => send(e, 'task:event', ev))
  )

  // ---------- 任务流程（大任务：按顺序跑多个小任务） ----------
  ipcMain.handle('group:list', () => tasks.listGroups())
  ipcMain.handle('group:save', (_e, group: TaskGroup) => {
    tasks.upsertGroup(group)
    return tasks.listGroups()
  })
  ipcMain.handle('group:delete', (_e, id: string) => {
    tasks.deleteGroup(id)
    return tasks.listGroups()
  })
  ipcMain.handle('group:run', (e, id: string) =>
    runGroup(id, (ev) => send(e, 'task:event', ev))
  )

  // ---------- 数据库连接与同步 ----------
  ipcMain.handle('db:list', () => dbStore.listDatabases())
  ipcMain.handle('db:save', (_e, input: DbConnection) => {
    dbStore.upsertDatabase(input)
    return dbStore.listDatabases()
  })
  ipcMain.handle('db:delete', (_e, id: string) => {
    dbStore.deleteDatabase(id)
    return dbStore.listDatabases()
  })
  ipcMain.handle('db:test', (_e, id: string) => dbSync.testConnection(id))
  ipcMain.handle('db:databases', (_e, input: DbConnection) => dbSync.listDatabases(input))
  ipcMain.handle('db:tables', (_e, id: string) => dbSync.listTables(id))
  ipcMain.handle('db:sync', (e, opts: DbSyncOptions) =>
    dbSync.syncDatabase(opts, (ev) => send(e, 'db:sync-event', ev))
  )
}
