import * as ssh from './ssh/sshService'
import * as vault from './vault'
import { getTask, getGroup } from './tasksStore'
import type { TaskEvent } from './types'

/**
 * 一键任务运行器：按顺序执行「自动连接 → 上传文件 → 逐条命令」。
 * 全过程以 TaskEvent 流式回推给渲染进程（日志 / 队列 / 进度 / 命令输出）。
 * runTask 返回失败命令条数；runGroup 按顺序跑多个任务，任一失败即中止。
 */
const running = new Set<string>()

export function isTaskRunning(taskId: string): boolean {
  return running.has(taskId)
}

async function ensureConnected(connId: string, emit: (ev: TaskEvent) => void): Promise<void> {
  if (ssh.isConnected(connId)) return
  emit({ taskId: '', kind: 'log', text: '· 未连接，正在自动连接…' })
  const prof = vault.getProfile(connId)
  if (!prof) throw new Error('任务绑定的连接已被删除，请编辑任务重新选择连接')
  const secrets = vault.getSecrets(connId)
  await ssh.connect(connId, {
    host: prof.host,
    port: prof.port,
    username: prof.username,
    password: secrets.password,
    privateKeyPath: prof.privateKeyPath,
    passphrase: secrets.passphrase
  })
  emit({ taskId: '', kind: 'log', text: `· 已连接 ${prof.username}@${prof.host}` })
}

export async function runTask(taskId: string, emit: (ev: TaskEvent) => void): Promise<number> {
  const task = getTask(taskId)
  if (!task) throw new Error('任务不存在')
  if (running.has(taskId)) throw new Error('该任务正在运行中')

  const log = (text: string): void => emit({ taskId, kind: 'log', text })
  running.add(taskId)
  try {
    log(`▶ ${new Date().toLocaleTimeString()} 开始任务「${task.name}」`)

    await ensureConnected(task.connId, (ev) => emit({ ...ev, taskId }))

    if (task.localPaths.length) {
      if (!task.remoteDir) throw new Error('任务未设置远程目标目录')
      log(`· 上传 ${task.localPaths.length} 个本地来源 → ${task.remoteDir}`)
      await ssh.upload(
        task.connId,
        task.localPaths,
        task.remoteDir,
        (p) => emit({ taskId, kind: 'progress', p }),
        (entries) => emit({ taskId, kind: 'queue', entries })
      )
      log('· 上传完成')
    }

    let failed = 0
    for (const cmd of task.commands) {
      if (!cmd.trim()) continue
      log(`$ ${cmd}`)
      if (cmd.trim().endsWith('&')) log('· 后台命令：已自动脱离会话执行（不会阻塞）')
      const code = await ssh.exec(task.connId, cmd, (chunk) =>
        emit({ taskId, kind: 'exec', command: cmd, chunk })
      )
      if (code !== 0) {
        failed++
        log(`✖ 命令失败，退出码 ${code}（后续命令继续执行，但任务将标记为失败）`)
      } else {
        log('# 退出码 0')
      }
    }

    if (failed) {
      log(`⚠ 任务结束：共 ${failed} 条命令失败，请检查上方输出`)
    } else {
      log('✔ 任务完成')
    }
    return failed
  } catch (e) {
    log('✖ 任务失败：' + (e as Error).message)
    throw e
  } finally {
    running.delete(taskId)
  }
}

/** 按顺序执行流程内的全部任务；任一任务失败/异常即中止后续步骤 */
export async function runGroup(groupId: string, emit: (ev: TaskEvent) => void): Promise<void> {
  const group = getGroup(groupId)
  if (!group) throw new Error('流程不存在')
  if (!group.taskIds.length) throw new Error('流程里还没有任务，请先编辑并添加')
  if (group.taskIds.some((id) => running.has(id))) throw new Error('流程内有任务正在运行中')

  const log = (text: string): void => emit({ taskId: '', kind: 'log', text })
  log(`▶ ${new Date().toLocaleTimeString()} 开始流程「${group.name}」（共 ${group.taskIds.length} 个任务）`)
  for (let i = 0; i < group.taskIds.length; i++) {
    const t = getTask(group.taskIds[i])
    if (!t) {
      log(`✖ 第 ${i + 1} 步的任务已被删除，流程中止`)
      throw new Error('流程内任务不存在')
    }
    log(`── 第 ${i + 1}/${group.taskIds.length} 步：「${t.name}」 ──`)
    try {
      const failed = await runTask(t.id, emit)
      if (failed) {
        log(`✖ 流程中止：「${t.name}」有 ${failed} 条命令失败，后续步骤未执行`)
        return
      }
    } catch (e) {
      log(`✖ 流程中止：「${t.name}」失败（${(e as Error).message}），后续步骤未执行`)
      return
    }
  }
  log('✔ 流程全部完成')
}
