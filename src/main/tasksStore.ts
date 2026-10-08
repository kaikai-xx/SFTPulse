import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Task, TaskGroup } from './types'

/**
 * 一键任务与任务组（流程）的持久化存储（tasks.json / groups.json）。
 * 两者均不含任何密码/凭据，只引用连接配置 id，因此无需加密。
 */
const storeDir = (): string => join(app.getPath('userData'), 'sftpulse')
const storeFile = (): string => join(storeDir(), 'tasks.json')
const groupsFile = (): string => join(storeDir(), 'groups.json')

function readAll(): Task[] {
  const d = storeDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  if (!existsSync(storeFile())) return []
  try {
    return JSON.parse(readFileSync(storeFile(), 'utf-8')) as Task[]
  } catch {
    return []
  }
}

function writeAll(list: Task[]): void {
  const d = storeDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf-8')
}

export function listTasks(): Task[] {
  return readAll()
}

export function getTask(id: string): Task | undefined {
  return readAll().find((t) => t.id === id)
}

export function upsertTask(task: Task): void {
  const list = readAll()
  const idx = list.findIndex((t) => t.id === task.id)
  if (idx >= 0) list[idx] = task
  else list.push(task)
  writeAll(list)
}

export function deleteTask(id: string): void {
  writeAll(readAll().filter((t) => t.id !== id))
  // 同步从所有流程中移除该任务，避免残留悬空引用
  writeGroups(readGroups().map((g) => ({ ...g, taskIds: g.taskIds.filter((x) => x !== id) })))
}

// ---------- 任务组（流程） ----------

function readGroups(): TaskGroup[] {
  const d = storeDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  if (!existsSync(groupsFile())) return []
  try {
    return JSON.parse(readFileSync(groupsFile(), 'utf-8')) as TaskGroup[]
  } catch {
    return []
  }
}

function writeGroups(list: TaskGroup[]): void {
  const d = storeDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  writeFileSync(groupsFile(), JSON.stringify(list, null, 2), 'utf-8')
}

export function listGroups(): TaskGroup[] {
  return readGroups()
}

export function getGroup(id: string): TaskGroup | undefined {
  return readGroups().find((g) => g.id === id)
}

export function upsertGroup(group: TaskGroup): void {
  const list = readGroups()
  const idx = list.findIndex((g) => g.id === group.id)
  if (idx >= 0) list[idx] = group
  else list.push(group)
  writeGroups(list)
}

export function deleteGroup(id: string): void {
  writeGroups(readGroups().filter((g) => g.id !== id))
}
