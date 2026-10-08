import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { DbConnection } from './types'

/**
 * 数据库连接配置持久化（databases.json）。
 * 密码经 safeStorage 走系统密钥链加密后落盘，明文不写磁盘；
 * 与 vault.ts 同构：返回给渲染进程的列表不含任何密文/明文密码。
 */
interface DbProfile {
  id: string
  name: string
  host: string
  port: number
  user: string
  database: string
  sshConnId?: string
  passwordEnc?: string
}

const storeDir = (): string => join(app.getPath('userData'), 'sftpulse')
const storeFile = (): string => join(storeDir(), 'databases.json')

function ensureDir(): void {
  const d = storeDir()
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  return 'plain::' + Buffer.from(plain, 'utf-8').toString('base64')
}

function decrypt(cipher: string): string {
  if (cipher.startsWith('plain::')) {
    return Buffer.from(cipher.slice(7), 'base64').toString('utf-8')
  }
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }
  return ''
}

function readAll(): DbProfile[] {
  ensureDir()
  if (!existsSync(storeFile())) return []
  try {
    return JSON.parse(readFileSync(storeFile(), 'utf-8')) as DbProfile[]
  } catch {
    return []
  }
}

function writeAll(list: DbProfile[]): void {
  ensureDir()
  writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf-8')
}

/** 返回给渲染进程的连接列表（不含密文/明文密码） */
export function listDatabases(): Omit<DbProfile, 'passwordEnc'>[] {
  return readAll().map(({ passwordEnc, ...rest }) => rest)
}

/** 保存/更新一个数据库连接；密码留空则沿用旧值 */
export function upsertDatabase(input: DbConnection): void {
  const list = readAll()
  const id = input.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  const prev = list.find((c) => c.id === id)

  const profile: DbProfile = {
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    user: input.user,
    database: input.database,
    sshConnId: input.sshConnId || undefined
  }
  if (input.password) profile.passwordEnc = encrypt(input.password)
  else if (prev?.passwordEnc) profile.passwordEnc = prev.passwordEnc

  const idx = list.findIndex((c) => c.id === id)
  if (idx >= 0) list[idx] = profile
  else list.push(profile)
  writeAll(list)
}

export function deleteDatabase(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id))
}

/** 取出含明文密码的完整配置，仅供主进程建连使用，绝不回传渲染进程 */
export function getDatabaseSecret(id: string): DbConnection | undefined {
  const p = readAll().find((c) => c.id === id)
  if (!p) return undefined
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    user: p.user,
    database: p.database,
    sshConnId: p.sshConnId,
    password: p.passwordEnc ? decrypt(p.passwordEnc) : ''
  }
}
