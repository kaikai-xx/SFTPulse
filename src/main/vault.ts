import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * 连接配置持久化。
 * 密码/私钥口令通过 Electron safeStorage 走操作系统密钥链加密后再落盘，
 * 明文永不写入磁盘；若系统不支持加密，则退化为 base64（带 plain:: 前缀标记）并仅存于本地 userData。
 */
export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privatekey'
  passwordEnc?: string
  privateKeyPath?: string
  passphraseEnc?: string
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

const storeDir = (): string => join(app.getPath('userData'), 'sftpulse')
const storeFile = (): string => join(storeDir(), 'connections.json')

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

function readAll(): ConnectionProfile[] {
  ensureDir()
  if (!existsSync(storeFile())) return []
  try {
    return JSON.parse(readFileSync(storeFile(), 'utf-8')) as ConnectionProfile[]
  } catch {
    return []
  }
}

function writeAll(list: ConnectionProfile[]): void {
  ensureDir()
  writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf-8')
}

/** 返回给渲染进程的连接列表（不含任何密文/明文密码字段） */
export function listConnections(): Omit<ConnectionProfile, 'passwordEnc' | 'passphraseEnc'>[] {
  return readAll().map(({ passwordEnc, passphraseEnc, ...rest }) => rest)
}

export function upsertConnection(input: ConnectionInput): void {
  const list = readAll()
  const id = input.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  const prev = list.find((c) => c.id === id)

  const profile: ConnectionProfile = {
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    privateKeyPath: input.privateKeyPath,
    remoteDir: input.remoteDir
  }

  // 密码：本次填了就用新的；没填则沿用旧值（编辑时不必每次重输）
  if (input.password) profile.passwordEnc = encrypt(input.password)
  else if (prev?.passwordEnc) profile.passwordEnc = prev.passwordEnc

  if (input.passphrase) profile.passphraseEnc = encrypt(input.passphrase)
  else if (prev?.passphraseEnc) profile.passphraseEnc = prev.passphraseEnc

  const idx = list.findIndex((c) => c.id === id)
  if (idx >= 0) list[idx] = profile
  else list.push(profile)
  writeAll(list)
}

export function deleteConnection(id: string): void {
  writeAll(readAll().filter((c) => c.id !== id))
}

/** 取出解密后的凭据，仅供主进程建立连接使用，绝不回传渲染进程 */
export function getSecrets(id: string): { password?: string; passphrase?: string } {
  const p = readAll().find((c) => c.id === id)
  const out: { password?: string; passphrase?: string } = {}
  if (!p) return out
  if (p.passwordEnc) out.password = decrypt(p.passwordEnc)
  if (p.passphraseEnc) out.passphrase = decrypt(p.passphraseEnc)
  return out
}

export function getProfile(id: string): ConnectionProfile | undefined {
  return readAll().find((c) => c.id === id)
}
